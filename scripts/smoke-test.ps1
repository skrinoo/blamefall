<#
.SYNOPSIS
    《锅从天降》端到端冒烟测试

.DESCRIPTION
    对任何一个部署（本地 dev-server 或 Vercel 生产）跑同一套断言。

    为什么需要它：这个项目的在线链路有一个极其讨厌的性质 ——
    **它坏了也看不出来**。/api/judge 返回 500、502、503、超时，
    客户端 engine/api.js 一律 resolve(null) 然后静默切本地兜底引擎，
    玩家侧画面完全正常，只是文案换了一套。演示时你根本不会发现 AI 没通。

    所以「能玩」不等于「在线链路通」。这个脚本把那些静默失败全部拽到台面上。

.PARAMETER BaseUrl
    被测地址。默认 http://127.0.0.1:8200（scripts/dev-server.ps1 的默认端口）。
    生产：.\smoke-test.ps1 -BaseUrl https://your-app.vercel.app

.EXAMPLE
    .\dev-server.ps1                                  # 终端 A
    .\smoke-test.ps1                                  # 终端 B

.EXAMPLE
    .\smoke-test.ps1 -BaseUrl https://blamefall.vercel.app

.NOTES
    关于「第二套校验逻辑」：test 4.2 会复现 engine/api.js 的 validate() 契约。
    这与 api/health.mjs 里刻意**不做**字段裁决并不矛盾 ——
    冒烟测试的职责就是独立复现被测契约，否则它测不出契约被破坏；
    而 health 是运行时诊断，报告事实即可，裁决权属于客户端。

    本文件保存为 UTF-8 with BOM（PowerShell 5.1 中文要求）。
#>

[CmdletBinding()]
param(
    [string] $BaseUrl = 'http://127.0.0.1:8200'
)

$ErrorActionPreference = 'Continue'
$BaseUrl = $BaseUrl.TrimEnd('/')

$script:Pass = 0
$script:Fail = 0

function Ok([string]$name, [string]$detail) {
    $script:Pass++
    Write-Host ("  [PASS] {0}" -f $name) -ForegroundColor Green
    if ($detail) { Write-Host ("         {0}" -f $detail) -ForegroundColor DarkGray }
}
function Bad([string]$name, [string]$detail) {
    $script:Fail++
    Write-Host ("  [FAIL] {0}" -f $name) -ForegroundColor Red
    if ($detail) { Write-Host ("         {0}" -f $detail) -ForegroundColor Red }
}
function Check([bool]$cond, [string]$name, [string]$detail, [string]$failDetail) {
    if ($cond) { Ok $name $detail } else { Bad $name $(if ($failDetail) { $failDetail } else { $detail }) }
}

# 取响应。必须自己从 RawContentStream 按 UTF-8 解码 ——
# 网关/本地服务器常不发 charset，PowerShell 5.1 会把 UTF-8 当 Latin-1 解，
# 中文全成乱码，然后断言会以一个莫名其妙的理由失败。
function Get-Raw([string]$url, [string]$method, [byte[]]$bodyBytes) {
    try {
        $p = @{ Uri = $url; Method = $method; UseBasicParsing = $true; TimeoutSec = 40 }
        if ($bodyBytes) {
            $p.Body = $bodyBytes
            $p.ContentType = 'application/json; charset=utf-8'
        }
        $r = Invoke-WebRequest @p
        return [pscustomobject]@{
            Status  = [int]$r.StatusCode
            Type    = [string]$r.Headers['Content-Type']
            Text    = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
            Error   = $null
        }
    } catch {
        $st = $null
        if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Status = $st; Type = $null; Text = $null; Error = $_.Exception.Message }
    }
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  《锅从天降》冒烟测试' -ForegroundColor Cyan
Write-Host ("  目标：{0}" -f $BaseUrl) -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '1. 静态资源与编码' -ForegroundColor Yellow
# ─────────────────────────────────────────────────────────────

$r = Get-Raw "$BaseUrl/" 'GET'
Check ($r.Status -eq 200) '首页 200' "status=$($r.Status)" "status=$($r.Status) err=$($r.Error)"
Check ($r.Type -like '*charset=utf-8*') '首页声明 charset=utf-8' $r.Type "Content-Type=$($r.Type)"
Check ($r.Text -like '*<script src="engine/api.js"*') '首页引用 engine/api.js' '' '加载顺序可能被改动'

$r = Get-Raw "$BaseUrl/data/verdicts.js" 'GET'
Check ($r.Status -eq 200) '判定库可达' "status=$($r.Status)"
# 这条是整套测试里最重要的编码断言：
# 判定库全是中文，若 charset 缺失或被按 Latin-1 解，中文会整体乱码，
# 而游戏画面看起来「正常」（只是文案变成一堆符号），极难发现。
Check ($r.Text -like '*事实型*') '判定库中文未乱码' '能在响应里搜到「事实型」' '中文乱码：检查 Content-Type 是否带 charset=utf-8'

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '2. 路径穿越防护' -ForegroundColor Yellow
# ─────────────────────────────────────────────────────────────

$r = Get-Raw "$BaseUrl/../README.md" 'GET'
# 允许 403（挡住了）或 404（规范化后找不到），也允许 200 但内容必须是 blamefall 自己的
# README（因为 ../ 从 /README.md 出发其实还在项目内）。
# 真正要挡的是逃出项目根，所以下面用编码过的 ..%2f 再测一次。
Check ($r.Status -in 200, 403, 404) '../README.md 未暴露异常' "status=$($r.Status)"

$r = Get-Raw "$BaseUrl/..%2f..%2f..%2fwindows%2fwin.ini" 'GET'
Check ($r.Status -ne 200) '编码穿越 ..%2f 被挡' "status=$($r.Status)" "status=$($r.Status) —— 项目根之外的文件可被读取！"

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '3. /api/health' -ForegroundColor Yellow
# ─────────────────────────────────────────────────────────────

$r = Get-Raw "$BaseUrl/api/health" 'GET'
Check ($r.Status -in 200, 503) 'health 可达（200 或 503 都算正常）' "status=$($r.Status)" "status=$($r.Status) err=$($r.Error)"

$h = $null
if ($r.Text) { try { $h = $r.Text | ConvertFrom-Json } catch { } }
Check ($null -ne $h) 'health 返回合法 JSON' '' 'JSON 解析失败'

if ($h) {
    Check ($null -ne $h.gateway) 'health 报告 gateway 状态' '' ''
    Check ($null -ne $h.prompt) 'health 报告 prompt 加载状态' '' ''

    # 安全断言：这个端点公网可达，绝不能吐密钥。
    # 只允许出现「配没配」的布尔，不允许出现值。
    $leak = ($r.Text -match 'sk-[A-Za-z0-9]{8,}')
    Check (-not $leak) 'health 响应不含密钥样式字符串' '' '响应里出现 sk- 开头的长串！'
}

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '4. /api/judge' -ForegroundColor Yellow
# ─────────────────────────────────────────────────────────────

# 这个 reason 恰好 10 个字符。dev-server 的 mock 用
#   S = 55 + min(35, reason.Length)
# 算说服力，所以中文编码链路完好时 S 必然是 65。
# 若服务端按 Latin-1 解 UTF-8 字节，这 10 个汉字会变成 30 个字符 → S = 85。
# 一个数字同时验证了「请求体编码」「服务端解码」「响应编码」三段链路。
#
# ⚠️ 这里的 JSON 是**手拼的**，刻意不用 ConvertTo-Json。
# PowerShell 5.1 的 ConvertTo-Json 会把所有非 ASCII 字符转义成 \uXXXX，
# 发出去就是纯 ASCII 字节 —— 那样即使服务端按 Latin-1 解码也不会出错，
# 下面那条编码断言就永远为真，等于没测。要测编码就必须发真的中文字节。
$reason = '这部分是他上周认领的'
$payload = '{"potText":"小组作业的 PPT 没人做，明天就要交",' +
           '"npcName":"学弟学妹",' +
           '"npcDesc":"讨好型，几乎不会拒绝",' +
           '"reason":"' + $reason + '"}'

$r = Get-Raw "$BaseUrl/api/judge" 'POST' ([Text.Encoding]::UTF8.GetBytes($payload))
Check ($r.Status -eq 200) 'judge 返回 200' "status=$($r.Status)" "status=$($r.Status) err=$($r.Error)"

$j = $null
if ($r.Text) { try { $j = $r.Text | ConvertFrom-Json } catch { } }
Check ($null -ne $j) 'judge 返回合法 JSON' '' 'JSON 解析失败'

if ($j -and $j.raw) {
    Ok 'judge 返回 raw 字段' "len=$($j.raw.Length)"
    if ($j.latencyMs) { Ok 'judge 报告实测延迟' "latencyMs=$($j.latencyMs)" }

    # ── 4.2 复现 engine/api.js 的 validate() 契约 ──────────
    $o = $null
    try { $o = $j.raw | ConvertFrom-Json } catch { }
    Check ($null -ne $o) '4.2.1 raw 可解析为 JSON' '' "raw 原文：$($j.raw)"

    if ($o) {
        $types = @('事实型', '情感型', '转移型', '反向型', '荒诞型')
        Check ($types -contains $o.argument_type) '4.2.2 argument_type 合法' "$($o.argument_type)"
        Check ($o.persuasiveness -is [int] -or $o.persuasiveness -is [long] -or $o.persuasiveness -is [double]) `
              '4.2.3 persuasiveness 是数值' "$($o.persuasiveness)"
        Check ($o.persuasiveness -ge 0 -and $o.persuasiveness -le 100) `
              '4.2.4 persuasiveness 在 0-100' "$($o.persuasiveness)"
        Check (-not [string]::IsNullOrWhiteSpace($o.technique_name)) '4.2.5 technique_name 非空' "$($o.technique_name)"
        Check (([string]$o.verdict).Trim().Length -ge 8) '4.2.6 verdict 长度 >= 8' "len=$(([string]$o.verdict).Trim().Length)"
        Check ($o.reaction_success -or $o.reaction_fail) '4.2.7 至少一个 reaction 非空' ''
        Check ($o.technique_name -notlike '*甩锅') '4.2.8 technique_name 不以「甩锅」结尾' "$($o.technique_name)"

        # 编码链路的精确断言。仅对 dev-server 的 mock 模式有意义
        # （真模型的 S 值不由此公式决定），所以只在 model=mock 时检查。
        if ($j.model -eq 'mock') {
            Check ($o.persuasiveness -eq 65) '4.2.9 中文编码链路完好（mock S 应为 65）' `
                  "S=$($o.persuasiveness)，reason 10 字" `
                  "S=$($o.persuasiveness) 而不是 65 —— 请求体或服务端解码把中文当成了 Latin-1"
        }
    }
} else {
    Bad 'judge 返回 raw 字段' "响应：$($r.Text)"
}

# 空 reason 必须被拒绝
$r2 = Get-Raw "$BaseUrl/api/judge" 'POST' ([Text.Encoding]::UTF8.GetBytes((@{ reason = '   ' } | ConvertTo-Json -Compress)))
Check ($r2.Status -eq 400) '空 reason 返回 400' "status=$($r2.Status)" "status=$($r2.Status)"

# 方法不允许
$r3 = Get-Raw "$BaseUrl/api/judge" 'GET'
Check ($r3.Status -eq 405) 'judge 拒绝 GET（405）' "status=$($r3.Status)" "status=$($r3.Status)"

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '5. 安全' -ForegroundColor Yellow
# ─────────────────────────────────────────────────────────────

$all = @(($r.Text), ($r2.Text), ($r3.Text)) -join "`n"
Check (-not ($all -match 'sk-[A-Za-z0-9]{8,}')) '所有 judge 响应不含密钥样式字符串' ''
Check (-not ($all -match 'Bearer\s+[A-Za-z0-9]')) '所有 judge 响应不回显 Authorization' ''

# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan
$total = $script:Pass + $script:Fail
if ($script:Fail -eq 0) {
    Write-Host ("  全部通过：{0}/{1}" -f $script:Pass, $total) -ForegroundColor Green
} else {
    Write-Host ("  通过 {0} / 失败 {1} / 共 {2}" -f $script:Pass, $script:Fail, $total) -ForegroundColor Red
}
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ''

if ($script:Fail -gt 0) { exit 1 }
exit 0
