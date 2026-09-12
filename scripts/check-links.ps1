# check-links.ps1 —— 演示链接巡检 + README 状态块自动更新
#
# 背景：*.vercel.app 在大陆网络被波浪式间歇封锁（DNS 污染 + SNI RST，见 docs/DEPLOY.md §8），
# 可达性随时在变。README「当前状态」里的链接状态如果靠手写，写下来的那一刻就开始过期。
# 本脚本把这件事变成一条命令：实测两条演示链接 → 重写 README 的 LINK-STATUS 标记块。
#
# 用法（在 scripts/ 目录下）：
#   .\check-links.ps1                # 巡检并更新 README
#   .\check-links.ps1 -NoUpdate      # 只巡检、打印结果，不动 README
#   .\check-links.ps1 -Retries 5     # 不可达时多重试几轮（默认 3 轮，间隔 8s）
#
# 判定标准（与冒烟测试同源，不看状态码看内容）：
#   Vercel 项目域名：GET /api/health 返回 ok=true 才算可达（防「状态码 200 但被劫持」）
#   Pages 镜像：      GET / 的 body 含 ASCII 标记 screen-title（index.html 标题屏的 id；
#                     不用中文标记——字符集解码不可靠，ASCII 无歧义）
#
# 约定：本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 按 ANSI 代码页读取，中文全成乱码。
# 兼容 Windows PowerShell 5.1 与 PowerShell 7。

[CmdletBinding()]
param(
    [string] $ReadmePath = '',   # 留空 = 仓库根的 README.md（下面惰性推导；
                                 # 5.1 里 param 默认值求值时 $PSScriptRoot 可能还是空，不能在 param 块里算）
    [int]    $Retries    = 3,
    [int]    $RetryDelaySec = 8,
    [switch] $NoUpdate
)

$ErrorActionPreference = 'Stop'

if (-not $ReadmePath) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $ReadmePath = Join-Path (Split-Path -Parent $scriptDir) 'README.md'
}

# ---------- 链接清单：唯一真相，README 块由它生成 ----------

$Links = @(
    @{
        Name    = 'vercel'
        Url     = 'https://blamefall-yy3a.vercel.app/'
        Role    = 'AI 裁判完整版（Vercel 项目域名，随项目不走样）'
        Health  = 'https://blamefall-yy3a.vercel.app/api/health'
    },
    @{
        Name    = 'pages'
        Url     = 'https://skrinoo.github.io/blamefall/'
        Role    = '保底可玩版（GitHub Pages 镜像，大陆可达；自由输入自动降级本地兜底裁判）'
        Health  = $null
    }
)

# ---------- 探测 ----------

# 从原始字节流按 UTF-8 解码——$resp.Content 的解码依赖响应头 charset，
# 上游不给 charset 时 5.1 会按 ISO-8859-1 解，中文标记必炸。ASCII 标记 + 原始字节双保险。
function Get-BodyUtf8([string] $url, [int] $timeoutSec) {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
    $bytes = $resp.RawContentStream.ToArray()
    $body = [System.Text.Encoding]::UTF8.GetString($bytes)
    return @{ StatusCode = [int]$resp.StatusCode; Body = $body }
}

function Test-Link($link) {
    # 返回 @{ Reachable; Detail }。Detail 是给人看的一句话，直接进 README 状态列。
    for ($attempt = 1; $attempt -le $Retries; $attempt++) {
        try {
            if ($link.Health) {
                # Vercel：health 端点内容判定，比根页面强——它证明 lambda 活着、prompt 加载了、网关配置了
                $r = Get-BodyUtf8 $link.Health 25
                $json = $r.Body | ConvertFrom-Json
                if ($json.ok -eq $true) {
                    $gw = if ($json.gateway.configured) { '网关已配置' } else { '⚠️ 网关未配置' }
                    return @{
                        Reachable = $true
                        Detail    = ('✅ 可达（health ok=true，model={0}，{1}；attempt {2}/{3}）' -f $json.gateway.model, $gw, $attempt, $Retries)
                    }
                }
                return @{
                    Reachable = $false
                    Detail    = ('⚠️ health 返回 ok=false（{0}）' -f ($r.Body.Substring(0, [Math]::Min(80, $r.Body.Length))))
                }
            } else {
                # Pages：纯静态，body 含 ASCII 标记即算活
                $r = Get-BodyUtf8 $link.Url 25
                if ($r.StatusCode -eq 200 -and $r.Body.Contains('screen-title')) {
                    return @{
                        Reachable = $true
                        Detail    = ('✅ 可达（HTTP 200，页面标记命中；attempt {0}/{1}）' -f $attempt, $Retries)
                    }
                }
                return @{
                    Reachable = $false
                    Detail    = ('⚠️ HTTP {0} 但页面标记未命中——可能被劫持或仓库内容变了' -f $r.StatusCode)
                }
            }
        } catch {
            $msg = $_.Exception.Message
            if ($msg.Length -gt 60) { $msg = $msg.Substring(0, 60) }
            if ($attempt -lt $Retries) {
                Write-Host ('  [{0}] attempt {1}/{2} 失败：{3}，{4}s 后重试' -f $link.Name, $attempt, $Retries, $msg, $RetryDelaySec)
                Start-Sleep -Seconds $RetryDelaySec
            } else {
                return @{
                    Reachable = $false
                    Detail    = ('🔴 本机此刻不可达（{0} 轮重试均失败：{1}）。不可达 ≠ 挂了：封锁是波浪式的，见 DEPLOY §8' -f $Retries, $msg)
                }
            }
        }
    }
}

Write-Host ('巡检 {0} 条链接（Retries={1}，间隔 {2}s）...' -f $Links.Count, $Retries, $RetryDelaySec)
$Results = @()
foreach ($link in $Links) {
    Write-Host ('  [{0}] {1}' -f $link.Name, $link.Url)
    $r = Test-Link $link
    $Results += ,@{ Link = $link; Result = $r }
    Write-Host ('  [{0}] {1}' -f $link.Name, $r.Result.Detail)
}

# ---------- 生成 README 状态块 ----------

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm'
$blockLines = @(
    '<!-- LINK-STATUS:START -->',
    '<!-- 本块由 scripts/check-links.ps1 自动维护，勿手改；手改会在下次运行时被覆盖 -->',
    '',
    ('最近巡检：**{0}**（本机 = 大陆网络；执行 `scripts/check-links.ps1` 可刷新本块）' -f $ts),
    '',
    '| 链接 | 角色 | 状态 |',
    '|---|---|---|'
)
foreach ($item in $Results) {
    $blockLines += ('| `{0}` | {1} | {2} |' -f $item.Link.Url, $item.Link.Role, $item.Result.Detail)
}
$blockLines += @(
    '',
    '> `*.vercel.app` 在大陆网络被**波浪式间歇封锁**（2026-09-12 封锁波内实测 DNS 污染 + SNI RST；',
    '> 窗口期全绿），可达性随时在变 —— 状态列只反映**最近一次巡检时刻**的事实，',
    '> 巡检方法见 [`docs/DEPLOY.md`](docs/DEPLOY.md) §8。',
    '',
    '<!-- LINK-STATUS:END -->'
)
$block = $blockLines -join "`n"

# ---------- 写回 README ----------

if ($NoUpdate) {
    Write-Host ''
    Write-Host '（-NoUpdate：不写 README。以下为将要写入的块）'
    Write-Host $block
    exit 0
}

$rawBytes = [System.IO.File]::ReadAllBytes($ReadmePath)
$hadBom = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
$text = [System.IO.File]::ReadAllText($ReadmePath, [System.Text.Encoding]::UTF8)

# 换行自适应：跟随原文件的主换行符，不造混合换行（否则 git 会报 LF→CRLF 警告）。
$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
if ($nl -eq "`r`n") { $block = $block -replace "`n", "`r`n" }

$startTag = '<!-- LINK-STATUS:START -->'
$endTag   = '<!-- LINK-STATUS:END -->'
$iStart = $text.IndexOf($startTag)
$iEnd   = $text.IndexOf($endTag)
if ($iStart -lt 0 -or $iEnd -lt 0 -or $iEnd -le $iStart) {
    Write-Error ('README 里找不到完整的 {0} ... {1} 标记块：{2}' -f $startTag, $endTag, $ReadmePath)
    exit 1
}

$newText = $text.Substring(0, $iStart) + $block + $text.Substring($iEnd + $endTag.Length)

# 保持原文件的 BOM 状态（README 是无 BOM UTF-8，不能给 GitHub 渲染添乱）
$enc = New-Object System.Text.UTF8Encoding($hadBom)
[System.IO.File]::WriteAllText($ReadmePath, $newText, $enc)

if ($newText -eq $text) {
    Write-Host ('README 无变化（状态与上次巡检一致，时间戳除外）：{0}' -f $ReadmePath)
} else {
    Write-Host ('README 已更新：{0}' -f $ReadmePath)
}

$allOk = -not ($Results | Where-Object { -not $_.Result.Reachable })
if ($allOk) { Write-Host 'RESULT: ALL-REACHABLE' } else { Write-Host 'RESULT: SOME-UNREACHABLE' }
