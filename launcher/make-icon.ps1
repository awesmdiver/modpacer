# Builds ModPacer's own icon files from the logo (the simplified 512 px PNG, launcher\modpacer-icon-simple-512.png):
#   launcher\modpacer.ico      16, 24, 32, 48, 64, 128 and 256 px, PNG frames (never scaled up past the 512 source)
#   web\public\favicon.png     64 px, the browser tab icon
# High-quality bicubic resampling, transparent rounded corners kept. Re-run only when the logo changes; both outputs are committed.
# Usage: pwsh launcher\make-icon.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $PSScriptRoot "modpacer-icon-simple-512.png"
$src = [System.Drawing.Image]::FromFile($srcPath)

function New-Frame([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY) # no light fringe at the edges
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    , $ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = $sizes | ForEach-Object { , (New-Frame $_) }
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]; $b = $frames[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$b.Length); $bw.Write([uint32]$offset); $offset += $b.Length
}
foreach ($b in $frames) { $bw.Write($b) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot "modpacer.ico"), $out.ToArray())
Write-Host "Wrote launcher\modpacer.ico"

[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot "..\web\public\favicon.png"), (New-Frame 64))
Write-Host "Wrote web\public\favicon.png"
$src.Dispose()
