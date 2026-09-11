<#
.SYNOPSIS
    《锅从天降》判定库批量生成脚本

.DESCRIPTION
    读 scripts/manifest.json（由 scripts/export-manifest.js 从运行中的页面导出），
    按 NPC 分批调用 OpenAI 兼容网关，为每个 (NPC, 论证类型) 组合生成四条文案，
    校验通过后写出：

        data/verdicts.generated.js      —— 生成结果，UMD 模块，可直接被 index.html 引用
        docs/generation-report.md       —— 本次生成的完整留痕（成功/失败/被丢弃的字段）

    它**不会**覆盖 data/verdicts.js。那一份是经过人工精修的线上版本，
    两者并排存在，由人决定采纳哪些。这是刻意的：本项目四次批量生成的经验是，
    模型产出的文案可用率很高，但直接落盘一定会带进重名、旁白体、复读句这三类问题。

.PARAMETER 环境
    密钥只从环境变量读，脚本里不出现任何明文，产物也不含任何密钥：

        $env:BLAMEFALL_API_BASE = 'https://your-gateway/v1'
        $env:BLAMEFALL_API_KEY  = 'sk-...'

.EXAMPLE
    # 只看会生成哪些组合、prompt 长什么样，不发起任何请求
    .\generate-verdicts.ps1 -DryRun

.EXAMPLE
    # 重做「导师」和「前任」两个 NPC 的全部条目
    .\generate-verdicts.ps1 -Only daoshi,ex -Force

.NOTES
    兼容性：Windows PowerShell 5.1 与 PowerShell 7 均可运行。

    两个 5.1 的编码坑已在代码里规避，改动时请勿「简化」掉：
      1. Invoke-RestMethod 用字符串 body 时会按 ISO-8859-1 编码，中文变乱码
         —— 必须传 UTF-8 字节数组。
      2. 网关响应常不带 charset，5.1 会把 UTF-8 当 Latin-1 解
         —— 必须自己从 RawContentStream 按 UTF-8 解码。

    本文件保存为 UTF-8 with BOM。5.1 在没有 BOM 时会按系统 ANSI 代码页
    读取 .ps1，届时本文件里的中文注释与中文字面量会全部变成乱码。
    若发现乱码，执行：
        $p = 'generate-verdicts.ps1'
        $t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
        [IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding $true))
#>

[CmdletBinding()]
param(
    [string]   $BaseUrl     = $env:BLAMEFALL_API_BASE,
    [string]   $ApiKey      = $env:BLAMEFALL_API_KEY,
    [string]   $Model       = 'gemini-2.5-flash',
    [double]   $Temperature = 0.92,

    # 0 在实测网关上表示「不限制」。若你的端点是严格的 OpenAI 兼容实现，
    # 0 会被当成「不许输出任何 token」，此时改成 4000 之类的实际值。
    [int]      $MaxTokens   = 0,

    [string]   $Manifest    = '',
    [string]   $PromptFile  = '',
    [string]   $OutJs       = '',
    [string]   $OutReport   = '',

    # 只做这些 NPC（id），留空表示按 manifest 的缺口自动决定
    [string[]] $Only        = @(),
    # 连同 manifest.existingKeys 里已有的条目一起重做
    [switch]   $Force,
    # 不发起任何网络请求，只打印计划与 prompt
    [switch]   $DryRun,

    [int]      $BatchSize   = 3,     # 每次请求打包几个 NPC（实测 3 个 x 5 类型 = 15 条最稳）
    [int]      $MaxRetry    = 2,     # 单个批次失败后的重试次数
    [int]      $SleepMs     = 600,   # 批次之间的间隔，避免撞限流
    [int]      $TimeoutSec  = 120
)

$ErrorActionPreference = 'Stop'
# 控制台输出中文。5.1 默认代码页会把中文打成问号。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ─────────────────────────────────────────────────────────────
# 路径解析
# ─────────────────────────────────────────────────────────────
$root = Split-Path -Parent $PSScriptRoot          # blamefall/
if (-not $Manifest)   { $Manifest   = Join-Path $PSScriptRoot 'manifest.json' }
if (-not $PromptFile) { $PromptFile = Join-Path $PSScriptRoot 'prompt-lib-batch.txt' }
if (-not $OutJs)      { $OutJs      = Join-Path $root 'data\verdicts.generated.js' }
if (-not $OutReport)  { $OutReport  = Join-Path $root 'docs\generation-report.md' }

function Read-Utf8([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "找不到文件：$path"
    }
    # 显式指定 UTF-8。不指定时 5.1 会按系统 ANSI 代码页读，中文全废。
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8NoBom([string]$path, [string]$text) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # 无 BOM：这些产物要被浏览器的 <script> 和 markdown 渲染器直接读，
    # 带 BOM 的 .js 在某些环境下会让第一个语句解析失败。
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

Write-Host ''
Write-Host '《锅从天降》判定库批量生成' -ForegroundColor Cyan
Write-Host ("  manifest : {0}" -f $Manifest)
Write-Host ("  prompt   : {0}" -f $PromptFile)
Write-Host ("  model    : {0}  temperature {1}  max_tokens {2}" -f $Model, $Temperature, $MaxTokens)
Write-Host ''

$systemPrompt = (Read-Utf8 $PromptFile).Trim()
$manifestText = Read-Utf8 $Manifest

# 解析结果存进 $mf，**不能**叫 $manifest。
#
# PowerShell 变量名不区分大小写，$manifest 与 [string] $Manifest 是同一个变量；
# 而 param 的类型约束在整个脚本作用域内持续生效，给它赋一个 PSCustomObject
# 会被**静默强转成字符串**（不报错），随后 $manifest.npcs 变成对字符串取属性，
# 得到 $null，foreach 零次迭代 —— 整个工作清单为空，脚本只会平静地告诉你
# 「没有需要生成的条目」。这个坑真实踩过一次，排查花的时间比写脚本还长。
$mf = $manifestText | ConvertFrom-Json

# 解析失败时必须吵，不能静默。下面三个字段是后续所有逻辑的地基，
# 任一为空都意味着 manifest 格式变了或文件读错了。
foreach ($req in 'npcs', 'argumentTypes', 'existingKeys') {
    if (@($mf.$req).Count -eq 0) { throw "manifest 解析异常：字段 '$req' 为空。请检查 $Manifest" }
}
Write-Host ("  已解析  : {0} 个 NPC / {1} 种论证类型 / {2} 条已有条目" -f `
    @($mf.npcs).Count, @($mf.argumentTypes).Count, @($mf.existingKeys).Count)

if (-not $DryRun) {
    if (-not $ApiKey) {
        throw '缺少 API 密钥。请先设置 $env:BLAMEFALL_API_KEY（不要写进脚本或提交进仓库）。'
    }
    if (-not $BaseUrl) {
        throw '缺少网关地址。请先设置 $env:BLAMEFALL_API_BASE，例如 https://your-gateway/v1'
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')
}

# ─────────────────────────────────────────────────────────────
# 构建工作清单
# ─────────────────────────────────────────────────────────────
$npcById = @{}
foreach ($n in $mf.npcs) { $npcById[$n.id] = $n }

$have = @{}
foreach ($k in $mf.existingKeys) { $have[$k] = $true }

$typeRules = $mf.rules.typesForKind
$work = New-Object System.Collections.ArrayList

foreach ($n in $mf.npcs) {
    if ($Only.Count -gt 0 -and $Only -notcontains $n.id) { continue }

    $types = $typeRules.($n.kind)
    if (-not $types -or $types.Count -eq 0) {
        Write-Host ("  跳过 {0}（kind={1}，规则规定不入判定库）" -f $n.name, $n.kind) -ForegroundColor DarkGray
        continue
    }

    foreach ($t in $types) {
        $key = "$($n.id)::$t"
        if ($have[$key] -and -not $Force) { continue }
        [void]$work.Add([pscustomobject]@{ Key = $key; Npc = $n; Type = $t })
    }
}

if ($work.Count -eq 0) {
    Write-Host ''
    Write-Host '没有需要生成的条目：manifest.existingKeys 已覆盖全部应有组合。' -ForegroundColor Yellow
    Write-Host '若要重做，用 -Force（全部重做）或 -Only <npcId> -Force（指定 NPC 重做）。'
    Write-Host ''
    exit 0
}

Write-Host ("待生成 {0} 条，覆盖 {1} 个 NPC" -f $work.Count, (($work | ForEach-Object { $_.Npc.id } | Select-Object -Unique).Count)) -ForegroundColor Green

# 全库已用过的手法名，会随每一批一起发给模型。
#
# 这里必须发**名字**而不是组合键。早期版本发的是 existingKeys（形如
# didi::事实型），prompt 却要求「不得与已有手法重名」——模型看不到名字，
# 这条约束等于没写。四批生成里「磁场」一词被复用了 4 次，全靠人工改名修掉。
#
# 它同时是一个跨批次的累加器：批次之间模型互相看不见，
# 每批通过校验的名字都要追加进来，否则第二批会重造第一批的名字。
$usedTechniques = New-Object System.Collections.ArrayList
foreach ($t in @($mf.existingTechniques)) {
    if ($t -and $usedTechniques -notcontains $t) { [void]$usedTechniques.Add($t) }
}
if ($usedTechniques.Count -eq 0) {
    Write-Host '警告：manifest 里没有 existingTechniques 字段，' -ForegroundColor Yellow
    Write-Host '      跨批重名检查将失效。请用新版 scripts/export-manifest.js 重新导出。' -ForegroundColor Yellow
} else {
    Write-Host ("已加载 {0} 个在用手法名用于查重" -f $usedTechniques.Count)
}

# 分批：按 NPC 聚拢，同一 NPC 的所有类型进同一批，保证语气连贯
$batches = New-Object System.Collections.ArrayList

# 必须用 @() 包住。只有一个分组时，管道会把单元素数组展开成一个
# 裸的 GroupInfo 对象，而 GroupInfo **自己就有一个 Count 属性**（组内条目数）：
#   $byNpc.Count  → 不是「1 个分组」而是「5 条」，for 循环多跑一轮
#   $byNpc[1]     → 对标量索引，返回 $null，.Group 也是 $null
# 两者叠加的后果是 chunk 里混进一批空条目，prompt 里会出现
# 「npc_id = （空）」的幽灵组合。实测踩过。
$byNpc = @($work | Group-Object -Property { $_.Npc.id })
for ($i = 0; $i -lt $byNpc.Count; $i += $BatchSize) {
    $end = [Math]::Min($i + $BatchSize - 1, $byNpc.Count - 1)
    $chunk = @()
    for ($j = $i; $j -le $end; $j++) {
        $g = $byNpc[$j]
        if ($null -ne $g) { $chunk += @($g.Group) }
    }
    if (@($chunk).Count -gt 0) { [void]$batches.Add($chunk) }
}
Write-Host ("分 {0} 批，每批最多 {1} 个 NPC" -f $batches.Count, $BatchSize)
Write-Host ''

# ─────────────────────────────────────────────────────────────
# 网络与解析
# ─────────────────────────────────────────────────────────────
function Invoke-Chat([string]$userContent) {
    $payload = [ordered]@{
        model       = $Model
        temperature = $Temperature
        max_tokens  = $MaxTokens
        messages    = @(
            @{ role = 'system'; content = $systemPrompt },
            @{ role = 'user';   content = $userContent }
        )
    }
    $json  = $payload | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)   # 坑 1：必须传字节

    $r = Invoke-WebRequest -Uri "$BaseUrl/chat/completions" -Method Post `
            -Headers @{ Authorization = "Bearer $ApiKey" } `
            -ContentType 'application/json; charset=utf-8' `
            -Body $bytes -UseBasicParsing -TimeoutSec $TimeoutSec

    $text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())  # 坑 2：自己解码
    $obj  = $text | ConvertFrom-Json
    $out  = $obj.choices[0].message.content
    if (-not $out) {
        # 思考型模型在 max_tokens 受限时会只回吐思维链，正式回答为空。
        # 这是本项目禁用一切思考型模型的原因，这里给出明确的错误而不是静默失败。
        $rt = $obj.usage | ConvertTo-Json -Compress -Depth 4
        throw "响应里没有 message.content。usage=$rt"
    }
    return [pscustomobject]@{ Content = $out; Usage = $obj.usage; Raw = $text }
}

function ConvertFrom-ModelJson([string]$raw) {
    if (-not $raw) { return $null }
    $t = $raw.Trim()
    if ($t.StartsWith('```')) {
        $t = $t -replace '^```[a-zA-Z]*\s*', ''
        $t = $t -replace '\s*```$', ''
    }
    # 模型偶尔会在数组前后加一句解释，取最外层的 [ ... ] 跨度
    $s = $t.IndexOf('[')
    $e = $t.LastIndexOf(']')
    if ($s -lt 0 -or $e -le $s) { return $null }
    $t = $t.Substring($s, $e - $s + 1)
    try { return @($t | ConvertFrom-Json) } catch { return $null }
}

$validTypes = @($mf.argumentTypes | ForEach-Object { $_.name })

function Test-VerdictItem($item) {
    $errs = New-Object System.Collections.ArrayList
    if (-not $item) { return @('item is null') }

    $props = @($item.PSObject.Properties | ForEach-Object { $_.Name })

    # 数值泄漏检查：模型只要敢打分，就在这里被抓住
    foreach ($p in $props) {
        if ($p -match '(?i)power|score|persuas|rate|prob|rating|weight') {
            [void]$errs.Add("输出了被禁止的数值字段 '$p'")
        }
    }

    if (-not $item.npc_id) { [void]$errs.Add('缺 npc_id') }
    if ($validTypes -notcontains $item.argument_type) {
        [void]$errs.Add("argument_type '$($item.argument_type)' 不在合法集合内")
    }

    $tn = [string]$item.technique_name
    if (-not $tn)                        { [void]$errs.Add('缺 technique_name') }
    elseif ($tn.Length -gt 6)            { [void]$errs.Add("technique_name 超长（$($tn.Length) 字，上限 6）") }
    elseif ($tn.Length -lt 2)            { [void]$errs.Add('technique_name 过短') }
    elseif ($tn.EndsWith('甩锅'))         { [void]$errs.Add('technique_name 以「甩锅」结尾') }

    $vd = [string]$item.verdict
    if ($vd.Length -lt 8)  { [void]$errs.Add("verdict 过短（$($vd.Length) 字）") }
    if ($vd.Length -gt 90) { [void]$errs.Add("verdict 过长（$($vd.Length) 字，上限 90）") }

    foreach ($f in @('reaction_success', 'reaction_fail')) {
        $v = [string]$item.$f
        if ($v.Length -gt 24) { [void]$errs.Add("$f 超长（$($v.Length) 字，上限 24）") }
    }
    if (-not ([string]$item.reaction_success) -and -not ([string]$item.reaction_fail)) {
        [void]$errs.Add('两条 reaction 全空')
    }

    return $errs
}

function Build-UserPrompt($chunk) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('请为下面这些组合各写一组文案。')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("共 $(@($chunk).Count) 个组合，输出数组必须正好有 $(@($chunk).Count) 个元素。")
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('【组合清单】')

    $i = 0
    foreach ($w in $chunk) {
        $i++
        $n = $w.Npc
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine("$i. npc_id = $($n.id)")
        [void]$sb.AppendLine("   argument_type = $($w.Type)")
        [void]$sb.AppendLine("   NPC 名称 = $($n.name)")
        [void]$sb.AppendLine("   NPC 人设 = $($n.desc)")
        [void]$sb.AppendLine("   难度系数 = $($n.difficulty)（仅供你把握语气强弱，不要输出这个数字）")
        [void]$sb.AppendLine("   道德代价 = $($n.moralCost)")
        if ($n.scene) { [void]$sb.AppendLine("   限定场景 = $($n.scene)") }
        if (@($n.prefers).Count)  { [void]$sb.AppendLine("   他吃这一套 = " + ($n.prefers -join '、')) }
        if (@($n.dislikes).Count) { [void]$sb.AppendLine("   他反感这个 = " + ($n.dislikes -join '、')) }
        if ($n.suspend)   { [void]$sb.AppendLine('   特殊结局 = 锅悬空不落，他既不会接也不会拒，只会把这件事按住') }
        if ($n.formalBonus) { [void]$sb.AppendLine('   特殊机制 = 只对公文腔、书面语买账') }
        $tdef = $mf.argumentTypes | Where-Object { $_.name -eq $w.Type }
        if ($tdef) { [void]$sb.AppendLine("   该论证类型的定义 = $($tdef.desc)") }
    }

    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('【全库已用过的 technique_name】')
    [void]$sb.AppendLine("共 $($usedTechniques.Count) 个。你新起的名字不得与其中任何一个相同或近义，")
    [void]$sb.AppendLine('也不得在本批内部互相重复：')
    [void]$sb.AppendLine(($usedTechniques -join '、'))

    return $sb.ToString()
}

# ─────────────────────────────────────────────────────────────
# 主循环
# ─────────────────────────────────────────────────────────────
$accepted = New-Object System.Collections.ArrayList   # 通过校验的条目
$rejected = New-Object System.Collections.ArrayList   # 被校验拦下的条目（含原因）
$batchLog = New-Object System.Collections.ArrayList   # 每批的耗时与 token

$bi = 0
foreach ($chunk in $batches) {
    $bi++
    $ids = ($chunk | ForEach-Object { $_.Npc.name + '/' + $_.Type }) -join ', '
    Write-Host ("[批次 {0}/{1}] {2} 条  {3}" -f $bi, $batches.Count, @($chunk).Count, $ids)

    $userPrompt = Build-UserPrompt $chunk

    if ($DryRun) {
        Write-Host '---- user prompt (DryRun) ----' -ForegroundColor DarkGray
        Write-Host $userPrompt
        Write-Host '---- end ----' -ForegroundColor DarkGray
        Write-Host ''
        continue
    }

    $attempt = 0
    $ok = $false
    while (-not $ok -and $attempt -le $MaxRetry) {
        $attempt++
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $resp = Invoke-Chat $userPrompt
            $sw.Stop()
            $items = ConvertFrom-ModelJson $resp.Content
            if (-not $items -or $items.Count -eq 0) {
                throw '响应无法解析为 JSON 数组（模型可能用了编号列表或裸键名）'
            }

            [void]$batchLog.Add([pscustomobject]@{
                Batch    = $bi
                Attempt  = $attempt
                Ms       = $sw.ElapsedMilliseconds
                Items    = $items.Count
                PromptTk = $resp.Usage.prompt_tokens
                ComplTk  = $resp.Usage.completion_tokens
                Status   = 'ok'
                Note     = ''
            })

            foreach ($it in $items) {
                $errs = @(Test-VerdictItem $it)
                if ($errs.Count -eq 0) {
                    [void]$accepted.Add($it)
                    # 追加进已用名单，供后续批次的 prompt 避开。
                    # 模型在批次之间没有记忆，不这样做第二批必然重造第一批的名字。
                    $tnNew = [string]$it.technique_name
                    if ($tnNew -and $usedTechniques -notcontains $tnNew) {
                        [void]$usedTechniques.Add($tnNew)
                    }
                } else {
                    [void]$rejected.Add([pscustomobject]@{
                        Key    = "$($it.npc_id)::$($it.argument_type)"
                        Item   = $it
                        Errors = $errs
                        Batch  = $bi
                    })
                }
            }
            Write-Host ("    {0}ms  收到 {1} 条  prompt_tokens={2} completion_tokens={3}" -f `
                        $sw.ElapsedMilliseconds, $items.Count, $resp.Usage.prompt_tokens, $resp.Usage.completion_tokens) -ForegroundColor Green
            $ok = $true
        }
        catch {
            $sw.Stop()
            $msg = $_.Exception.Message
            $status = ''
            try { $status = [int]$_.Exception.Response.StatusCode } catch {}
            Write-Host ("    第 {0} 次尝试失败 {1} {2}" -f $attempt, $status, $msg) -ForegroundColor Red
            [void]$batchLog.Add([pscustomobject]@{
                Batch = $bi; Attempt = $attempt; Ms = $sw.ElapsedMilliseconds
                Items = 0; PromptTk = 0; ComplTk = 0
                Status = 'fail'; Note = "$status $msg"
            })
            if ($attempt -le $MaxRetry) { Start-Sleep -Milliseconds (1200 * $attempt) }
        }
    }
    if (-not $ok) { Write-Host "    批次 $bi 放弃" -ForegroundColor Red }

    if ($bi -lt $batches.Count) { Start-Sleep -Milliseconds $SleepMs }
}

if ($DryRun) {
    Write-Host 'DryRun 结束，未发起任何网络请求。' -ForegroundColor Yellow
    exit 0
}

# ─────────────────────────────────────────────────────────────
# 产出 data/verdicts.generated.js
# ─────────────────────────────────────────────────────────────
function ConvertTo-JsString([string]$s) {
    if ($null -eq $s) { return '""' }
    # 用 String.Replace 而不是 -replace：后者是正则，反斜杠语义完全不同
    $t = $s.Replace('\', '\\').Replace('"', '\"')
    $t = $t.Replace("`r`n", '\n').Replace("`n", '\n').Replace("`r", '\n')
    return '"' + $t + '"'
}

$now = Get-Date -Format 'yyyy-MM-dd HH:mm'
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('/**')
[void]$sb.AppendLine(' * 《锅从天降》 判定库 —— 机器生成版，请勿直接上线')
[void]$sb.AppendLine(' *')
[void]$sb.AppendLine(" * 由 scripts/generate-verdicts.ps1 于 $now 生成")
[void]$sb.AppendLine(" * 模型 $Model  temperature $Temperature  共 $($accepted.Count) 条通过校验，$($rejected.Count) 条被拦下")
[void]$sb.AppendLine(' *')
[void]$sb.AppendLine(' * 与 data/verdicts.js 的关系：')
[void]$sb.AppendLine(' *   verdicts.js           人工精修版，index.html 实际加载的就是它')
[void]$sb.AppendLine(' *   verdicts.generated.js 本文件，机器生成，供人挑选')
[void]$sb.AppendLine(' *')
[void]$sb.AppendLine(' * 采纳流程：diff 两份文件，把满意的条目抄进 verdicts.js，')
[void]$sb.AppendLine(' * 重点检查三件事（这是四批生成里反复出现的三类问题）：')
[void]$sb.AppendLine(' *   1. technique 全库重名')
[void]$sb.AppendLine(' *   2. reaction 写成了第三人称旁白而不是台词')
[void]$sb.AppendLine(' *   3. 多条 verdict 在复读同一个句式或同一个比喻')
[void]$sb.AppendLine(' */')
[void]$sb.AppendLine('(function (root, factory) {')
[void]$sb.AppendLine('  var data = factory();')
[void]$sb.AppendLine('  if (typeof module !== "undefined" && module.exports) module.exports = data;')
[void]$sb.AppendLine('  else root.VERDICTS_GENERATED = data;')
[void]$sb.AppendLine('})(typeof globalThis !== "undefined" ? globalThis : this, function () {')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('  function E(technique, verdict, ok, no) {')
[void]$sb.AppendLine('    return { technique: technique, verdict: verdict, reaction_success: ok, reaction_fail: no };')
[void]$sb.AppendLine('  }')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('  var entries = {')

$sorted = $accepted | Sort-Object -Property @{ Expression = { $_.npc_id } }, @{ Expression = { $_.argument_type } }
$lines = New-Object System.Collections.ArrayList
foreach ($it in $sorted) {
    $line = '    ' + (ConvertTo-JsString "$($it.npc_id)::$($it.argument_type)") + ': E(' +
            (ConvertTo-JsString ([string]$it.technique_name)) + ', ' +
            (ConvertTo-JsString ([string]$it.verdict)) + ', ' +
            (ConvertTo-JsString ([string]$it.reaction_success)) + ', ' +
            (ConvertTo-JsString ([string]$it.reaction_fail)) + ')'
    [void]$lines.Add($line)
}
[void]$sb.AppendLine(($lines -join ",`r`n"))
[void]$sb.AppendLine('  };')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('  return { entries: entries, generic: {} };')
[void]$sb.AppendLine('});')

Write-Utf8NoBom $OutJs $sb.ToString()
Write-Host ''
Write-Host ("已写出 {0}（{1} 条）" -f $OutJs, $accepted.Count) -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────
# 产出 docs/generation-report.md
# ─────────────────────────────────────────────────────────────
$rb = New-Object System.Text.StringBuilder
[void]$rb.AppendLine('# 判定库生成报告')
[void]$rb.AppendLine('')
[void]$rb.AppendLine("生成时间：$now")
[void]$rb.AppendLine('')
[void]$rb.AppendLine('| 项 | 值 |')
[void]$rb.AppendLine('| --- | --- |')
[void]$rb.AppendLine("| 模型 | ``$Model`` |")
[void]$rb.AppendLine("| temperature | $Temperature |")
[void]$rb.AppendLine("| max_tokens | $MaxTokens |")
[void]$rb.AppendLine("| 批次数 | $($batches.Count) |")
[void]$rb.AppendLine("| 请求成功 | $(@($batchLog | Where-Object { $_.Status -eq 'ok' }).Count) |")
[void]$rb.AppendLine("| 请求失败 | $(@($batchLog | Where-Object { $_.Status -eq 'fail' }).Count) |")
[void]$rb.AppendLine("| 通过校验 | $($accepted.Count) |")
[void]$rb.AppendLine("| 被校验拦下 | $($rejected.Count) |")
$tp = ($batchLog | Measure-Object -Property PromptTk -Sum).Sum
$tc = ($batchLog | Measure-Object -Property ComplTk -Sum).Sum
$tm = ($batchLog | Measure-Object -Property Ms -Sum).Sum
[void]$rb.AppendLine("| prompt_tokens 合计 | $tp |")
[void]$rb.AppendLine("| completion_tokens 合计 | $tc |")
[void]$rb.AppendLine('| **API 密钥** | **不在本文件中，也不在任何产物中；只从环境变量读取** |')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('## 请求明细')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('| 批次 | 尝试 | 耗时 ms | 条目 | prompt_tk | completion_tk | 状态 | 备注 |')
[void]$rb.AppendLine('| --- | --- | --- | --- | --- | --- | --- | --- |')
foreach ($b in $batchLog) {
    $note = ([string]$b.Note).Replace('|', '/').Replace("`n", ' ')
    if ($note.Length -gt 90) { $note = $note.Substring(0, 90) + '...' }
    [void]$rb.AppendLine("| $($b.Batch) | $($b.Attempt) | $($b.Ms) | $($b.Items) | $($b.PromptTk) | $($b.ComplTk) | $($b.Status) | $note |")
}
[void]$rb.AppendLine('')
[void]$rb.AppendLine("总耗时 $tm ms。completion_tokens 是选型的关键指标：同等 4 案例任务下，")
[void]$rb.AppendLine('思考型模型会烧掉数倍 token 且在 max_tokens 受限时只回吐思维链、正式回答为空。')
[void]$rb.AppendLine('')

if ($rejected.Count -gt 0) {
    [void]$rb.AppendLine('## 被校验拦下的条目')
    [void]$rb.AppendLine('')
    [void]$rb.AppendLine('这些条目**没有**写进 verdicts.generated.js。')
    [void]$rb.AppendLine('')
    foreach ($r in $rejected) {
        [void]$rb.AppendLine("### ``$($r.Key)``  （批次 $($r.Batch)）")
        [void]$rb.AppendLine('')
        foreach ($e in $r.Errors) { [void]$rb.AppendLine("- $e") }
        [void]$rb.AppendLine('')
        [void]$rb.AppendLine('```json')
        [void]$rb.AppendLine(($r.Item | ConvertTo-Json -Depth 6))
        [void]$rb.AppendLine('```')
        [void]$rb.AppendLine('')
    }
} else {
    [void]$rb.AppendLine('## 被校验拦下的条目')
    [void]$rb.AppendLine('')
    [void]$rb.AppendLine('无。全部条目通过校验。')
    [void]$rb.AppendLine('')
}

[void]$rb.AppendLine('## 校验规则')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('| 规则 | 阈值 | 拦的是什么 |')
[void]$rb.AppendLine('| --- | --- | --- |')
[void]$rb.AppendLine('| 数值字段黑名单 | 字段名含 power/score/persuas/rate/prob/rating/weight | 模型擅自打分。四批生成里荒诞型曾被评出 90-92 分，一旦采用数值系统即崩塌 |')
[void]$rb.AppendLine('| argument_type 白名单 | 必须在 manifest 的五种之内 | 类型漂移 |')
[void]$rb.AppendLine('| technique_name 长度 | 2-6 字 | 模型爱写 7-9 字的华丽长名 |')
[void]$rb.AppendLine('| technique_name 结尾 | 不得以「甩锅」结尾 | 库内会有十几条同尾，读起来像在复读 |')
[void]$rb.AppendLine('| verdict 长度 | 8-90 字 | 过短没信息量，过长挤爆气泡 |')
[void]$rb.AppendLine('| reaction 长度 | 每条不超过 24 字 | 气泡里放不下，且长句往往是旁白体 |')
[void]$rb.AppendLine('| reaction 非全空 | 两条至少有一条 | 空白气泡 |')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('## 仍需人工把关的三件事')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('脚本能挡住格式与长度问题，挡不住语义问题。落盘前必须人工过一遍：')
[void]$rb.AppendLine('')
[void]$rb.AppendLine('1. **technique 全库重名** —— 模型在跨批次时看不到别的批次，容易反复用「磁场」这类词。')
[void]$rb.AppendLine('2. **reaction 写成第三人称旁白** —— 气泡里必须是这个人说的话，不是解说词。')
[void]$rb.AppendLine('3. **verdict 集体复读** —— 同一批里几条点评共用一个句式或一个比喻。')
[void]$rb.AppendLine('   根因通常是 prompt 的字段说明里放了完整示范句，模型当成必抄模板。')

Write-Utf8NoBom $OutReport $rb.ToString()
Write-Host ("已写出 {0}" -f $OutReport) -ForegroundColor Cyan
Write-Host ''
Write-Host ("完成：通过 {0} 条 / 拦下 {1} 条。产物不含任何密钥。" -f $accepted.Count, $rejected.Count) -ForegroundColor Green
Write-Host ''
