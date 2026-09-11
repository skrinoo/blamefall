<#
.SYNOPSIS
    纵向拼接两张带重叠区的截图（卷宗页一屏截不完，分两张截）。

.DESCRIPTION
    原理：上图的最后 SigRows 行必然出现在下图顶部某处（重叠区）。
    先用「上图最后一行」的采样签名在下图顶部做粗匹配，
    再对候选位置做 SigRows 行逐行验证，得到重叠高度 overlap。
    输出高度 = topH + botH - overlap。

    PNG 无损，同一页面滚动截图的像素应当逐字相同，容差只给 2。

.PARAMETER Top
    上半张截图路径（含页面头部）。
.PARAMETER Bottom
    下半张截图路径（含页面尾部）。
.PARAMETER Out
    输出文件路径。
.PARAMETER MaxOverlap
    重叠区搜索上限（像素行）。

.NOTES
    本机没有 Node / Python，图像操作只能走 System.Drawing (GDI+)。
    用法：
        .\stitch-shots.ps1 -Top a.png -Bottom b.png -Out ..\docs\shots\03-report.png
#>
param(
    [Parameter(Mandatory = $true)][string]$Top,
    [Parameter(Mandatory = $true)][string]$Bottom,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$SigRows    = 24,
    [int]$MaxOverlap = 1400,
    [int]$StepX      = 8,
    [int]$Tolerance  = 2,
    # 两次截图之间窗口宽度可能差几个像素（滚动条出现/消失），
    # 居中内容会横向平移，所以匹配必须搜横向偏移 xoff。
    [int]$MaxXOff    = 6,
    # 只在有文字的列区间里比对：左右大片同色背景会让不匹配的行
    # 扫完整个 margin 才失败，限定内容带能让早退立刻生效。
    [int]$XStart     = 700,
    [int]$XEnd       = 1800
)

# ⚠️ 局部变量绝不允许与 param 同名（大小写不区分）：
# [string]$Top 会把后面的 $top 静默强转成字符串（DEVLOG §7 坑 4，
# 本脚本第一版就栽在这里：$top.H 变 null，报出「宽度不一致 top= 」）。
# 所以这里用 $imgT / $imgB / $imgO，不用 $top / $bot / $out。

Add-Type -AssemblyName System.Drawing

function Read-Bitmap([string]$path) {
    $bmp  = New-Object System.Drawing.Bitmap($path)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $lock = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = New-Object byte[] ($lock.Stride * $bmp.Height)
    [System.Runtime.InteropServices.Marshal]::Copy($lock.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($lock)
    return @{ Bmp = $bmp; Px = $bytes; Stride = $lock.Stride; W = $bmp.Width; H = $bmp.Height }
}

# 两行在内容带采样列上逐字节比对。$xoff > 0 表示 top 的内容相对 bot 右移。
# 不分配中间数组，靠早退提速。
function Row-Eq($a, [int]$ya, $b, [int]$yb, [int]$tol, [int]$xoff) {
    $oa = $ya * $a.Stride
    $ob = $yb * $b.Stride
    $xa = [Math]::Max(0, $xoff)
    $xb = [Math]::Max(0, -$xoff)
    $lim = [Math]::Min($XEnd, [Math]::Min($a.W - $xa, $b.W - $xb))
    for ($x = [Math]::Max($XStart, 0); $x -lt $lim; $x += $StepX) {
        $ia = $oa + ($x + $xa) * 4
        $ib = $ob + ($x + $xb) * 4
        if ([Math]::Abs($a.Px[$ia]     - $b.Px[$ib])     -gt $tol) { return $false }
        if ([Math]::Abs($a.Px[$ia + 1] - $b.Px[$ib + 1]) -gt $tol) { return $false }
        if ([Math]::Abs($a.Px[$ia + 2] - $b.Px[$ib + 2]) -gt $tol) { return $false }
    }
    return $true
}

$imgT = Read-Bitmap $Top
$imgB = Read-Bitmap $Bottom

$cap = [Math]::Min($MaxOverlap, [Math]::Min($imgT.H, $imgB.H) - $SigRows)

# 粗匹配：上图最后一行 == 下图第 (s + SigRows - 1) 行，横向偏移一起搜
$candidates = @()
for ($xoff = -$MaxXOff; $xoff -le $MaxXOff; $xoff++) {
    for ($s = 0; $s -le ($cap - $SigRows); $s++) {
        if (Row-Eq $imgT ($imgT.H - 1) $imgB ($s + $SigRows - 1) $Tolerance $xoff) {
            $candidates += ,@($s, $xoff)
        }
    }
}
if ($candidates.Count -eq 0) {
    throw "没找到重叠区（搜了 s=0..$($cap - $SigRows)、xoff=-$MaxXOff..$MaxXOff）。若两图确实不重叠，请重截。"
}

# 验证：从候选位置起 SigRows 行逐行比对。取 s 最大的通过者 ——
# 背景大面积同色时小偏移可能假通过，真重叠是「还能继续对齐」的最大那个。
$bestS = -1; $bestX = 0
foreach ($c in $candidates) {
    $s = $c[0]; $xoff = $c[1]
    if ($s -le $bestS) { continue }   # 只关心更大的重叠
    $ok = $true
    for ($k = 0; $k -lt $SigRows; $k++) {
        if (-not (Row-Eq $imgT ($imgT.H - $SigRows + $k) $imgB ($s + $k) $Tolerance $xoff)) { $ok = $false; break }
    }
    if ($ok) { $bestS = $s; $bestX = $xoff }
}
if ($bestS -lt 0) { throw "粗匹配有 $($candidates.Count) 个候选，但 SigRows=$SigRows 行验证全灭。" }
$overlap = $bestS + $SigRows
$xoff    = $bestX

Write-Output ("粗匹配候选 {0} 个，overlap = {1} 行，xoff = {2} px（top {3}x{4} / bottom {5}x{6}）" -f `
    $candidates.Count, $overlap, $xoff, $imgT.W, $imgT.H, $imgB.W, $imgB.H)

$canvasH = $imgT.H + $imgB.H - $overlap
$imgO  = New-Object System.Drawing.Bitmap($imgT.W, $canvasH)
$g    = [System.Drawing.Graphics]::FromImage($imgO)
# 预填背景色：xoff ≠ 0 时下图会留出一条 |xoff| 像素的未覆盖边，
# 不填就是 PNG 透明区（查看器里显示成白条）。取上图左上角像素当背景色。
# Px 是 32bppArgb 小端：[0]=B [1]=G [2]=R。
$g.Clear([System.Drawing.Color]::FromArgb(255, $imgT.Px[2], $imgT.Px[1], $imgT.Px[0]))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.DrawImage($imgT.Bmp, 0, 0, $imgT.W, $imgT.H)
# 下图按 xoff 落位：宽度差几个像素时边缘会被裁掉一点，
# 裁掉的是同色背景网格，肉眼不可见。
$g.DrawImage($imgB.Bmp, $xoff, $imgT.H - $overlap, $imgB.W, $imgB.H)
$g.Dispose()

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$imgO.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

Write-Output ("拼接完成：{0} x {1}（top {2} + bottom {3} - overlap {4}）→ {5}" -f `
    $imgO.Width, $imgO.Height, $imgT.H, $imgB.H, $overlap, $Out)

$imgO.Dispose(); $imgT.Bmp.Dispose(); $imgB.Bmp.Dispose()
