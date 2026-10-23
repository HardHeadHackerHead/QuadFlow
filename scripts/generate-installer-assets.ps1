# Generate NSIS installer branding assets (header BMP, sidebar BMP) from
# src-tauri/icons/icon.png. Run after changing the app icon.
#
# Output:
#   src-tauri/installer-assets/header.bmp     150x57   24-bit
#   src-tauri/installer-assets/sidebar.bmp    164x314  24-bit
#
# NSIS Modern UI requires 24-bit BMP (no alpha) — System.Drawing handles
# the down-conversion when saving as Bmp.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AssetsDir   = Join-Path $ProjectRoot "src-tauri\installer-assets"
$IconPng     = Join-Path $ProjectRoot "src-tauri\icons\icon.png"

if (-not (Test-Path $IconPng)) {
    Write-Host "ERROR: icon.png not found at $IconPng" -ForegroundColor Red
    exit 1
}
New-Item -ItemType Directory -Path $AssetsDir -Force | Out-Null

Add-Type -AssemblyName System.Drawing

# Brand gradient: #1a0d2e (top) -> #4a1d6e (bottom)
$colorTop    = [System.Drawing.Color]::FromArgb(26,  13, 46)   # #1a0d2e
$colorBottom = [System.Drawing.Color]::FromArgb(74,  29, 110)  # #4a1d6e
$colorAccent = [System.Drawing.Color]::FromArgb(180, 120, 240) # subtle purple highlight
$colorText   = [System.Drawing.Color]::FromArgb(245, 240, 255) # near-white

function New-GradientBitmap {
    param([int]$Width, [int]$Height)
    $bmp = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $rect  = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $colorTop, $colorBottom, ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
    return @{ Bitmap = $bmp; Graphics = $g }
}

function Add-IconScaled {
    param($Graphics, $IconImage, [int]$X, [int]$Y, [int]$Size)
    $Graphics.DrawImage($IconImage, $X, $Y, $Size, $Size)
}

# Load source icon
$icon = [System.Drawing.Image]::FromFile($IconPng)

# -----------------------------------------------------------------------------
# 1. Header — 150x57
#    Layout: [icon 40x40] [QuadFlow wordmark, vertically centered]
# -----------------------------------------------------------------------------
$headerW = 150; $headerH = 57
$h = New-GradientBitmap -Width $headerW -Height $headerH

# Subtle accent line on the right edge
$pen = New-Object System.Drawing.Pen $colorAccent, 1
$h.Graphics.DrawLine($pen, $headerW - 1, 0, $headerW - 1, $headerH - 1)
$pen.Dispose()

$iconSize = 40
$iconX = 8
$iconY = [int](($headerH - $iconSize) / 2)
Add-IconScaled -Graphics $h.Graphics -IconImage $icon -X $iconX -Y $iconY -Size $iconSize

$wordmarkFont   = New-Object System.Drawing.Font "Segoe UI Semibold", 13, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$wordmarkBrush  = New-Object System.Drawing.SolidBrush $colorText
$wordmarkSize   = $h.Graphics.MeasureString("QuadFlow", $wordmarkFont)
$wordmarkX      = $iconX + $iconSize + 6
$wordmarkY      = [int](($headerH - $wordmarkSize.Height) / 2)
$h.Graphics.DrawString("QuadFlow", $wordmarkFont, $wordmarkBrush, $wordmarkX, $wordmarkY)
$wordmarkFont.Dispose(); $wordmarkBrush.Dispose()

$headerOut = Join-Path $AssetsDir "header.bmp"
$h.Bitmap.Save($headerOut, [System.Drawing.Imaging.ImageFormat]::Bmp)
$h.Graphics.Dispose(); $h.Bitmap.Dispose()
Write-Host "  Wrote $headerOut" -ForegroundColor Green

# -----------------------------------------------------------------------------
# 2. Sidebar — 164x314
#    Layout: [large icon centered, top]
#            [wordmark]
#            [tagline]
# -----------------------------------------------------------------------------
$sideW = 164; $sideH = 314
$s = New-GradientBitmap -Width $sideW -Height $sideH

# Centered icon, upper third
$bigIconSize = 100
$bigIconX    = [int](($sideW - $bigIconSize) / 2)
$bigIconY    = 38
Add-IconScaled -Graphics $s.Graphics -IconImage $icon -X $bigIconX -Y $bigIconY -Size $bigIconSize

# Wordmark, just below icon
$titleFont  = New-Object System.Drawing.Font "Segoe UI Semibold", 22, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = New-Object System.Drawing.SolidBrush $colorText
$titleSize  = $s.Graphics.MeasureString("QuadFlow", $titleFont)
$titleX     = [int](($sideW - $titleSize.Width) / 2)
$titleY     = $bigIconY + $bigIconSize + 14
$s.Graphics.DrawString("QuadFlow", $titleFont, $titleBrush, $titleX, $titleY)
$titleFont.Dispose(); $titleBrush.Dispose()

# Thin accent rule under wordmark
$pen = New-Object System.Drawing.Pen $colorAccent, 1
$ruleY = [int]($titleY + 36)
$ruleW = 80
$ruleX = [int](($sideW - $ruleW) / 2)
$s.Graphics.DrawLine($pen, $ruleX, $ruleY, $ruleX + $ruleW, $ruleY)
$pen.Dispose()

# Tagline, two lines
$taglineLine1 = "Multi-Agent"
$taglineLine2 = "Terminal Manager"
$taglineFont  = New-Object System.Drawing.Font "Segoe UI", 11, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$taglineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(210, 195, 235))

$t1Size = $s.Graphics.MeasureString($taglineLine1, $taglineFont)
$t1X    = [int](($sideW - $t1Size.Width) / 2)
$t1Y    = $ruleY + 10
$s.Graphics.DrawString($taglineLine1, $taglineFont, $taglineBrush, $t1X, $t1Y)

$t2Size = $s.Graphics.MeasureString($taglineLine2, $taglineFont)
$t2X    = [int](($sideW - $t2Size.Width) / 2)
$t2Y    = $t1Y + 16
$s.Graphics.DrawString($taglineLine2, $taglineFont, $taglineBrush, $t2X, $t2Y)
$taglineFont.Dispose(); $taglineBrush.Dispose()

$sidebarOut = Join-Path $AssetsDir "sidebar.bmp"
$s.Bitmap.Save($sidebarOut, [System.Drawing.Imaging.ImageFormat]::Bmp)
$s.Graphics.Dispose(); $s.Bitmap.Dispose()
Write-Host "  Wrote $sidebarOut" -ForegroundColor Green

$icon.Dispose()

# -----------------------------------------------------------------------------
# 3. Installer .ico — reuse the existing app .ico so the installer .exe
#    (the file the user double-clicks) carries the QuadFlow icon instead of
#    the default NSIS one.
# -----------------------------------------------------------------------------
$srcIco  = Join-Path $ProjectRoot "src-tauri\icons\icon.ico"
$destIco = Join-Path $AssetsDir "installer.ico"
Copy-Item $srcIco $destIco -Force
Write-Host "  Wrote $destIco (copied from icon.ico)" -ForegroundColor Green

Write-Host ""
Write-Host "Installer assets ready in src-tauri/installer-assets/" -ForegroundColor Cyan
