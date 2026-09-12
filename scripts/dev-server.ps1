<#
.SYNOPSIS
    《锅从天降》本地开发服务器（零依赖，PowerShell 手写 TCP + HTTP/1.1）

.DESCRIPTION
    存在的理由很具体：**开发机上没有 Node**，所以 `vercel dev` 跑不了，
    而 file:// 双击打开的页面又永远是离线模式（autoSameOrigin 只在 http(s) 下生效）。
    结果是「在线裁判」这条链路在本地根本没法验证 —— 而它恰恰是演示时要给评委看的部分。

    这个脚本用 System.Net.Sockets.TcpListener 手写 HTTP，把项目目录挂到
    http://127.0.0.1:<Port>/，于是：

      1. engine/api.js 的 autoSameOrigin() 会把 apiBase 填成这个 origin → 在线模式
      2. /api/judge 由本脚本应答，客户端整条链路（fetch → validate → finishThrow）全部走通
      3. 顺带可以用 http:// 协议观察页面，file:// 下的一些行为差异也能对照

    为什么不用 HttpListener：它走 HTTP.sys 内核驱动，绑定 URL 前缀在非管理员账户下
    通常需要 netsh http add urlacl 授权。TcpListener 直接绑 TCP 端口，不受此限制。

    两种模式：

      Mock 模式（默认，不需要任何密钥）
          /api/judge 返回一条固定的、能通过 validate() 全字段校验的假判定。
          technique_name 带递增计数，这样在开发者面板里一眼就能看出
          「这是 mock 在应答」而不是「兜底引擎刚好返回了同样的文案」。

      Proxy 模式（设了 BLAMEFALL_API_BASE + BLAMEFALL_API_KEY 时自动启用）
          /api/judge 真转发到网关，返回体与 api/judge.mjs 完全同构。
          于是部署之前就能用真模型端到端测，还能顺手掐表实测延迟。

.PARAMETER Port
    监听端口，默认 8200。

    最初默认是 8123，在本机直接绑定失败。排查结果值得记一笔：
    Windows 的 TCP 端口排除范围是**零散的**，不是成段保留，而 8123 恰好
    是一个单点排除（`netsh int ipv4 show excludedportrange protocol=tcp`
    在本机输出里它自己占一行：`8123  8123`）。绑定报的是 WSAEACCES
    而不是 WSAEADDRINUSE，netstat 里则表现为 PID 4（内核）在 LISTENING。

    所以遇到绑定失败别猜，直接查排除表，选一个不在表里的端口。

.PARAMETER MockLatencyMs
    Mock 模式下人为注入的延迟，默认 400ms。
    调成 2000 可以验证「客户端 1850ms 超时 → 切兜底」这条降级路径。

.EXAMPLE
    .\dev-server.ps1
    # 然后浏览器打开 http://127.0.0.1:8123/ ，按 ` 键看开发者面板

.EXAMPLE
    .\dev-server.ps1 -MockLatencyMs 2000
    # 验证超时降级：AI 判定应当被丢弃，面板里出现「兜底引擎」而不是「AI 裁判返回」

.NOTES
    本文件保存为 UTF-8 with BOM。PowerShell 5.1 在没有 BOM 时会按系统 ANSI
    代码页读取 .ps1，届时中文字面量（包括 mock 判定文案）会全部变成乱码。

    静态文件一律发 charset=utf-8。这不是可选项：data/verdicts.js 里全是中文，
    浏览器若按本地代码页解析 JS，判定库会整体乱码，而且不报任何错。

    仅用于本地开发。它没有任何鉴权，绝不要暴露到公网。
#>

[CmdletBinding()]
param(
    [int]    $Port           = 8200,
    [string] $Root           = '',
    [int]    $MockLatencyMs  = 400,
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'

# ── 定位项目根 ──────────────────────────────────────────────
if (-not $Root) {
    # 脚本在 scripts/ 下，项目根是它的上一级
    $Root = Split-Path -Parent $PSScriptRoot
}
$Root = (Resolve-Path $Root).Path

if (-not (Test-Path (Join-Path $Root 'index.html'))) {
    throw "在 '$Root' 下找不到 index.html，请用 -Root 指定项目根目录。"
}

# ── Proxy 模式判定 ──────────────────────────────────────────
$gwBase = ([string]$env:BLAMEFALL_API_BASE).TrimEnd('/')
$gwKey  = [string]$env:BLAMEFALL_API_KEY
$proxy  = ($gwBase -and $gwKey)
$gwModel = if ($env:BLAMEFALL_MODEL) { $env:BLAMEFALL_MODEL } else { 'gemini-2.5-flash' }

# ── MIME 表 ─────────────────────────────────────────────────
# 每个都带 charset=utf-8，理由见 .NOTES
$MIME = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.mjs'  = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2'= 'font/woff2'
}

# Mock 判定的计数器。带进 technique_name，
# 让「mock 在应答」与「兜底引擎碰巧返回同样文案」这两种情况可以区分。
$script:MockSeq = 0

function Write-Log([string]$msg) {
    if (-not $Quiet) { Write-Host $msg }
}

# 在字节序列里找 header 与 body 的分隔符 CRLFCRLF (13,10,13,10)。
# 返回分隔符起始下标，找不到返回 -1（Count < 4 时循环不执行，也是 -1）。
function Find-HeaderEnd($list) {
    $last = $list.Count - 4
    for ($i = 0; $i -le $last; $i++) {
        if ($list[$i] -eq 13 -and $list[$i + 1] -eq 10 -and
            $list[$i + 2] -eq 13 -and $list[$i + 3] -eq 10) {
            return $i
        }
    }
    return -1
}

# ── HTTP 响应 ───────────────────────────────────────────────
# 一律 Connection: close，不做 keep-alive。
# 本地开发服务器追求的是「行为可预测」，不是吞吐量。
function Send-Response($stream, [int]$status, [string]$statusText, [byte[]]$body, [string]$contentType) {
    $head = "HTTP/1.1 $status $statusText`r`n" +
            "Content-Type: $contentType`r`n" +
            "Content-Length: $($body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Access-Control-Allow-Origin: *`r`n" +
            "Connection: close`r`n`r`n"
    $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($headBytes, 0, $headBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

function Send-Json($stream, [int]$status, [string]$statusText, $obj) {
    # 必须自己序列化成 UTF-8 字节。若把字符串交给 StreamWriter 默认编码，
    # 中文会变成问号 —— 与 Invoke-RestMethod 的字符串 body 坑同源。
    $json  = $obj | ConvertTo-Json -Depth 12 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Send-Response $stream $status $statusText $bytes 'application/json; charset=utf-8'
}

function Send-Text($stream, [int]$status, [string]$statusText, [string]$text, [string]$contentType) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    Send-Response $stream $status $statusText $bytes $contentType
}

# ── /api/judge ──────────────────────────────────────────────
function Invoke-Judge($stream, [string]$reqBody, $headers) {
    # 请求级凭据覆盖（对齐生产 api/_gateway.mjs 的 gatewayConfig(req)）：
    # 带了 x-bf-key / x-bf-model 就用玩家的，否则回落服务端 env；base 始终只认 env（防 SSRF）。
    $reqKey    = if ($headers) { ([string]$headers['x-bf-key']).Trim() }   else { '' }
    $reqModel  = if ($headers) { ([string]$headers['x-bf-model']).Trim() } else { '' }
    $effKey    = if ($reqKey)   { $reqKey }   else { $gwKey }
    $effModel  = if ($reqModel) { $reqModel } else { $gwModel }
    $keySource = if ($reqKey)   { 'request' } elseif ($gwKey) { 'env' } else { 'none' }

    $payload = $null
    try { $payload = $reqBody | ConvertFrom-Json } catch { }
    if (-not $payload) {
        Send-Json $stream 400 'Bad Request' @{ error = @{ code = 'bad_json' } }
        return
    }
    $reason = [string]$payload.reason
    if (-not $reason.Trim()) {
        Send-Json $stream 400 'Bad Request' @{ error = @{ code = 'reason_required' } }
        return
    }

    if ($proxy) {
        # ── 真转发 ──────────────────────────────────────
        # 请求体必须传 UTF-8 字节，响应必须自己从 RawContentStream 解码。
        # 这两个坑在 scripts/generate-verdicts.ps1 里也规避了，改动时请勿简化掉。
        $sysPromptPath = Join-Path $Root 'prompts\judge-v3.txt'
        if (-not (Test-Path $sysPromptPath)) {
            Send-Json $stream 500 'Internal Server Error' @{ error = @{ code = 'prompt_file_missing' } }
            return
        }
        $sysPrompt = [IO.File]::ReadAllText($sysPromptPath, [Text.Encoding]::UTF8).Trim()

        $npcDesc = [string]$payload.npcDesc
        $target  = if ($npcDesc) { "$([string]$payload.npcName)（$npcDesc）" } else { [string]$payload.npcName }
        $userPrompt = "判定这一次甩锅。`n`n锅（背锅事件）：$([string]$payload.potText)`n甩锅对象：$target`n玩家给出的理由：$reason"

        $upBody = [ordered]@{
            model       = $effModel
            temperature = 0.85
            max_tokens  = 0
            messages    = @(
                @{ role = 'system'; content = $sysPrompt },
                @{ role = 'user';   content = $userPrompt }
            )
        } | ConvertTo-Json -Depth 12 -Compress

        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            $r = Invoke-WebRequest -Uri "$gwBase/chat/completions" -Method Post `
                     -Headers @{ Authorization = "Bearer $effKey" } `
                     -ContentType 'application/json; charset=utf-8' `
                     -Body ([Text.Encoding]::UTF8.GetBytes($upBody)) `
                     -UseBasicParsing -TimeoutSec 30
            $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
            $obj  = $text | ConvertFrom-Json
            $content = $obj.choices[0].message.content
            $sw.Stop()
            if (-not $content) {
                Send-Json $stream 502 'Bad Gateway' @{ error = @{ code = 'empty_content'; usage = $obj.usage } }
                return
            }
            Write-Log ("  [judge:proxy] {0}ms · {1} chars" -f $sw.ElapsedMilliseconds, $content.Length)
            # 与 api/judge.mjs 同构：raw 是客户端唯一会读的字段
            Send-Json $stream 200 'OK' @{ raw = [string]$content; latencyMs = $sw.ElapsedMilliseconds; model = $effModel; keySource = $keySource; usage = $obj.usage }
        } catch {
            $sw.Stop()
            Write-Log ("  [judge:proxy] 失败 {0}ms · {1}" -f $sw.ElapsedMilliseconds, $_.Exception.Message)
            Send-Json $stream 502 'Bad Gateway' @{ error = @{ code = 'upstream_error'; latencyMs = $sw.ElapsedMilliseconds } }
        }
        return
    }

    # ── Mock ────────────────────────────────────────────
    if ($MockLatencyMs -gt 0) { Start-Sleep -Milliseconds $MockLatencyMs }
    $script:MockSeq++

    # 这条假判定逐字段对着 engine/api.js 的 validate() 写，必须全部通过：
    #   argument_type ∈ 五类型 / persuasiveness 0-100 / technique_name 非空
    #   verdict.trim().length >= 8 / reaction_success 与 reaction_fail 至少一个非空
    #
    # persuasiveness 随 reason 长度浮动，是为了在开发者面板上看见变化的数字 ——
    # 一个恒定不变的 S 值没法证明「判定真的走了一遍」。
    $s = 55 + [Math]::Min(35, $reason.Length)
    $mock = [ordered]@{
        argument_type    = '事实型'
        persuasiveness   = $s
        technique_name   = "本地模拟判定$($script:MockSeq)"
        verdict          = "本地模拟判定$($script:MockSeq)：这是 dev-server.ps1 的 mock 响应，用于在没有 Node 的机器上验证在线链路"
        reaction_success = '…好，那这次算我的。'
        reaction_fail    = '这个理由我可不能认。'
    }
    $raw = $mock | ConvertTo-Json -Depth 6 -Compress
    $mockModel = if ($reqModel) { $reqModel } else { 'mock' }
    Write-Log ("  [judge:mock] seq={0} S={1} key={2} model={3} latency={4}ms" -f $script:MockSeq, $s, $keySource, $mockModel, $MockLatencyMs)
    Send-Json $stream 200 'OK' @{ raw = $raw; latencyMs = $MockLatencyMs; model = $mockModel; keySource = $keySource; usage = $null }
}

# ── 静态文件 ────────────────────────────────────────────────
function Send-File($stream, [string]$urlPath) {
    if ($urlPath -eq '/' -or $urlPath -eq '') { $urlPath = '/index.html' }

    # 去掉查询串与片段，再做 URL 解码
    $clean = ($urlPath -split '[?#]')[0]
    try { $clean = [Uri]::UnescapeDataString($clean) } catch { }

    $rel = $clean.TrimStart('/') -replace '/', '\'
    $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))

    # 路径穿越防护。虽然是本地服务器，但 ../ 逃逸会让整个磁盘可读，
    # 而演示时这个端口很可能开着，机器还连着投影。
    if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $stream 403 'Forbidden' '403 Forbidden' 'text/plain; charset=utf-8'
        return
    }
    if (-not (Test-Path $full -PathType Leaf)) {
        Send-Text $stream 404 'Not Found' "404 Not Found: $clean" 'text/plain; charset=utf-8'
        return
    }

    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    $ct  = if ($MIME.ContainsKey($ext)) { $MIME[$ext] } else { 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($full)
    Send-Response $stream 200 'OK' $bytes $ct
    Write-Log ("  [file] {0} · {1} bytes · {2}" -f $clean, $bytes.Length, $ct)
}

# ── 主循环 ──────────────────────────────────────────────────
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)

try {
    $listener.Start()
} catch {
    # 必须把底层 SocketException 的错误码翻出来。两种情况的处置方式完全不同：
    #
    #   AccessDenied (10013)        端口被 HTTP.sys 保留，或被权限/防火墙挡住。
    #                               netstat 里表现为 PID 4 在 LISTENING。
    #                               → 换端口。绝对不要去 kill PID 4，那是内核。
    #   AddressAlreadyInUse (10004) 真的有用户态进程在听。
    #                               → 找 PID 或换端口。
    #
    # 早期版本一律报「端口可能已被占用」——那是猜的，而且猜错了会把人
    # 引到错误的排查方向上（本项目实测就是 WSAEACCES，不是占用）。
    $sockErr = $null
    $ex = $_.Exception
    while ($ex) {
        if ($ex -is [System.Net.Sockets.SocketException]) { $sockErr = $ex.SocketErrorCode; break }
        $ex = $ex.InnerException
    }
    $hint = switch ($sockErr) {
        'AccessDenied'        { "端口在系统排除表里，或权限不足（netstat 里显示为 PID 4 就是这种）。换一个端口。" }
        'AddressAlreadyInUse' { "端口已有进程在监听。用 netstat -ano | findstr :$Port 找 PID。" }
        default               { "换端口重试。" }
    }
    throw "无法监听 127.0.0.1:$Port —— SocketErrorCode=$sockErr。$hint`n" +
          "例如：.\dev-server.ps1 -Port 8321`n" +
          "想看系统保留了哪些端口段：netsh int ipv4 show excludedportrange protocol=tcp"
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host '  《锅从天降》本地开发服务器' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ("  项目根  : {0}" -f $Root)
Write-Host ("  地址    : http://127.0.0.1:{0}/" -f $Port) -ForegroundColor Green
if ($proxy) {
    Write-Host ("  模式    : PROXY → {0} · 模型 {1}" -f $gwBase, $gwModel) -ForegroundColor Yellow
    Write-Host '            /api/judge 会真调网关，可端到端测真 AI 判定并掐表' -ForegroundColor Yellow
} else {
    Write-Host ("  模式    : MOCK · 延迟 {0}ms" -f $MockLatencyMs) -ForegroundColor Yellow
    Write-Host '            设 BLAMEFALL_API_BASE + BLAMEFALL_API_KEY 后重启即切 PROXY' -ForegroundColor Yellow
}
Write-Host '  停止    : Ctrl+C'
Write-Host ''

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $stream = $client.GetStream()

            # ── 按字节读请求 ─────────────────────────
            # 这里不能用 StreamReader 读 body。Content-Length 是**字节数**，
            # 而 StreamReader.Read(buf, i, n) 的 n 是**字符数**：
            # UTF-8 下一个汉字 3 字节却只算 1 字符，于是按字节数去要字符
            # 会永远差一截，StreamReader 就阻塞等更多数据，直到
            # ReceiveTimeout 抛「无法从传输连接中读取数据」。
            #
            # 纯 ASCII 的 body 字节数 == 字符数，所以这个 bug 只在中文请求体上出现。
            # 实测现象刚好把它暴露得很干净：空 reason 的 ASCII 请求正常返回 400，
            # 带中文的正式请求直接把连接挂死。
            $bytes = New-Object System.Collections.Generic.List[byte]
            $chunk = New-Object byte[] 4096
            $headEnd = -1
            while ($bytes.Count -lt 65536) {
                $n = $stream.Read($chunk, 0, $chunk.Length)
                if ($n -le 0) { break }
                $bytes.AddRange([byte[]]$chunk[0..($n - 1)])
                $headEnd = Find-HeaderEnd $bytes
                if ($headEnd -ge 0) { break }
            }
            if ($headEnd -lt 0) { continue }   # 请求头不完整或超过 64KB，直接断开

            # 请求头全是 ASCII（非 ASCII 的 header 值必须经 RFC 2047 编码），
            # 所以这里按 ASCII 解码是安全的。body 才需要 UTF-8。
            $headText = [Text.Encoding]::ASCII.GetString($bytes.GetRange(0, $headEnd).ToArray())
            $lines = $headText -split "`r`n"

            $parts = $lines[0] -split ' '
            if ($parts.Count -lt 2) { continue }
            $method = $parts[0].ToUpperInvariant()
            $path   = $parts[1]

            $headers = @{}
            for ($i = 1; $i -lt $lines.Count; $i++) {
                $idx = $lines[$i].IndexOf(':')
                if ($idx -gt 0) {
                    $headers[$lines[$i].Substring(0, $idx).Trim().ToLowerInvariant()] = $lines[$i].Substring($idx + 1).Trim()
                }
            }

            Write-Log ("{0} {1}" -f $method, $path)

            # body：先按 Content-Length 把**字节**补齐，再整体 UTF-8 解码。
            # 顺序不能反：先解码再补齐会在多字节字符中间截断，得到一堆 U+FFFD。
            $body = ''
            $bodyStart = $headEnd + 4
            if ($headers.ContainsKey('content-length')) {
                $len = 0
                [void][int]::TryParse($headers['content-length'], [ref]$len)
                if ($len -gt 0 -and $len -lt 1MB) {
                    while (($bytes.Count - $bodyStart) -lt $len) {
                        $need = [Math]::Min($chunk.Length, $len - ($bytes.Count - $bodyStart))
                        $n = $stream.Read($chunk, 0, $need)
                        if ($n -le 0) { break }
                        $bytes.AddRange([byte[]]$chunk[0..($n - 1)])
                    }
                    $avail = [Math]::Min($len, $bytes.Count - $bodyStart)
                    if ($avail -gt 0) {
                        $body = [Text.Encoding]::UTF8.GetString($bytes.GetRange($bodyStart, $avail).ToArray())
                    }
                }
            }

            $apiPath = ($path -split '[?#]')[0].TrimEnd('/').ToLowerInvariant()

            if ($apiPath -eq '/api/judge') {
                if ($method -ne 'POST') {
                    Send-Json $stream 405 'Method Not Allowed' @{ error = @{ code = 'method_not_allowed' } }
                } else {
                    Invoke-Judge $stream $body $headers
                }
            }
            elseif ($apiPath -eq '/api/health') {
                # 与 api/health.mjs 同构，只是数据来源是本地
                Send-Json $stream 200 'OK' ([ordered]@{
                    ok        = $true
                    service   = 'blamefall-judge-devserver'
                    mode      = if ($proxy) { 'proxy' } else { 'mock' }
                    gateway   = [ordered]@{
                        configured      = [bool]$proxy
                        baseConfigured  = [bool]$gwBase
                        keyConfigured   = [bool]$gwKey
                        model           = if ($proxy) { $gwModel } else { 'mock' }
                        temperature     = 0.85
                        mockLatencyMs   = $MockLatencyMs
                    }
                    prompt    = [ordered]@{
                        loaded = (Test-Path (Join-Path $Root 'prompts\judge-v3.txt'))
                        source = 'prompts/judge-v3.txt'
                    }
                    note      = 'dev-server.ps1 的本地应答，与生产端点 api/*.mjs 同构但不同实现'
                })
            }
            elseif ($apiPath -eq '/api/genpot') {
                # 与 api/genpot.mjs 同构的 mock：让客户端 PotGen 缓冲链路在没网关时也能端到端测。
                # 两口锅覆盖不同 targetRole，验证 sanitize 与 next() 都走得通。
                $gReqKey   = ([string]$headers['x-bf-key']).Trim()
                $gReqModel = ([string]$headers['x-bf-model']).Trim()
                $gKeySrc   = if ($gReqKey) { 'request' } elseif ($gwKey) { 'env' } else { 'none' }
                $gModel    = if ($gReqModel) { $gReqModel } else { 'mock' }
                Send-Json $stream 200 'OK' ([ordered]@{
                    pots = @(
                        [ordered]@{
                            id='gen-mock-1'; scene='mock 小组'; weight=1
                            text='mock 锅一：群文件里那版方案被人改坏了，没人承认。'
                            options=[ordered]@{ '事实型'='改坏那版的提交记录是他的账号'; '情感型'='我这几天盯着这版眼睛都熬红了'; '转移型'='方案评审本来就没留痕流程'; '反向型'='是他上次说直接覆盖就行'; '荒诞型'='那晚机房跳闸，文件自己坏的' }
                            targetRole=[ordered]@{ '事实型'='npc'; '情感型'='self'; '转移型'='institution'; '反向型'='npc'; '荒诞型'='any' }
                            ownershipOverride=[ordered]@{ moyu=0.7; roommate=0.3 }
                        },
                        [ordered]@{
                            id='gen-mock-2'; scene='mock 宿舍'; weight=1
                            text='mock 锅二：冰箱里那盒牛奶过期三天了没人扔。'
                            options=[ordered]@{ '事实型'='牛奶是他上周买回来没开封的'; '情感型'='我这周真的一次都没开过冰箱'; '转移型'='值日表压根没写谁清冰箱'; '反向型'='是他让我别动他东西的'; '荒诞型'='咱这冰箱自带时间加速' }
                            targetRole=[ordered]@{ '事实型'='npc'; '情感型'='self'; '转移型'='institution'; '反向型'='npc'; '荒诞型'='any' }
                        }
                    )
                    requested = 2; returned = 2; latencyMs = 0; model = $gModel; keySource = $gKeySrc
                })
            }
            elseif ($apiPath -eq '/api/probe') {
                # 与 api/probe.mjs 同构的 mock：验证「选模型 + 检测可用性」这条链路。
                # 关键契约：上游失败也回 200（「不可用」是要展示给用户的正常结论，不是服务错误）。
                # 生产的 503（base+key 全缺）在这里不复现 —— dev-server 永远有一个 mock 上游，
                # 这样才能在浏览器里同时测到「✓ 可用」和「✗ 不可用」两条 UI 分支。
                $pReqKey   = ([string]$headers['x-bf-key']).Trim()
                $pReqModel = ([string]$headers['x-bf-model']).Trim()
                $pKeySrc   = if ($pReqKey) { 'request' } elseif ($proxy) { 'env' } else { 'none' }
                $pModel    = if ($pReqModel) { $pReqModel } elseif ($proxy) { $gwModel } else { 'mock-model' }

                $sw = [Diagnostics.Stopwatch]::StartNew()
                if ($MockLatencyMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min($MockLatencyMs, 300)) }
                $sw.Stop()
                $lat = [Math]::Max(1, $sw.ElapsedMilliseconds)

                # 失败模拟：填特定前缀的假 key，就能在浏览器里看到「✗ 不可用」提醒，
                # 逐个验证前端 probeErrMsg 的错误码映射，无需真的烧网关：
                #   bad402* → 余额不足 / bad404* → 模型不存在 / badtime* → 上游超时 / bad|invalid|expired* → Key 无效
                $simErr = $null
                if     ($pReqKey -match '^bad402')  { $simErr = 'http_402' }
                elseif ($pReqKey -match '^bad404')  { $simErr = 'http_404' }
                elseif ($pReqKey -match '^badtime') { $simErr = 'timeout' }
                elseif ($pReqKey -match '^(bad|invalid|expired)') { $simErr = 'http_401' }

                if ($simErr) {
                    Send-Json $stream 200 'OK' ([ordered]@{ ok = $false; model = $pModel; keySource = $pKeySrc; latencyMs = $lat; error = $simErr })
                    Write-Log ("  [probe:mock] FAIL sim={0} · key={1} model={2}" -f $simErr, $pKeySrc, $pModel)
                } else {
                    Send-Json $stream 200 'OK' ([ordered]@{ ok = $true; model = $pModel; keySource = $pKeySrc; latencyMs = $lat; reply = 'OK' })
                    Write-Log ("  [probe:mock] OK · key={0} model={1} {2}ms" -f $pKeySrc, $pModel, $lat)
                }
            }
            else {
                Send-File $stream $path
            }
        } catch {
            Write-Log ("  [err] {0}" -f $_.Exception.Message)
        } finally {
            try { $client.Close() } catch { }
        }
    }
} finally {
    $listener.Stop()
    Write-Host ''
    Write-Host '服务器已停止。' -ForegroundColor Cyan
}
