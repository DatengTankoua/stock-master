<#
  Référencement — génère, avec System.Drawing (déjà disponible sur Windows,
  aucun package ajouté), à partir des images OFFICIELLES du dépôt (jamais
  redessinées, mise à l'échelle uniforme, jamais d'étirement) :

  1. public/marketing/og-stock-master-{fr,en}.jpg — aperçu de partage
     1200 × 630 (Open Graph, X, WhatsApp) : logo officiel sur fond blanc et
     vraie capture de l'écran Analyse (boutique fictive) dans la langue de
     la page. JPEG, poids réduit (WhatsApp ignore les aperçus trop lourds).
  2. public/brand/stock-master-logo-horizontal-720.png — logo horizontal
     ramené à 720 px de large (affiché à 230 px au plus : net jusqu'à
     l'échelle 3), au lieu du PNG source de 2172 px préchargé sur chaque
     page publique.

  À relancer si le logo ou les captures changent :
  `powershell -NoProfile -File web/scripts/generate-seo-images.ps1`
#>
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$public = Join-Path $root "public"
$logoPath = Join-Path $public "brand\stock-master-logo-horizontal.png"

function New-Graphics([System.Drawing.Bitmap]$bitmap) {
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return $g
}

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Save-Jpeg([System.Drawing.Bitmap]$bitmap, [string]$dest, [long]$quality) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq "image/jpeg" }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter (
    [System.Drawing.Imaging.Encoder]::Quality, $quality)
  $bitmap.Save($dest, $codec, $params)
}

# ─── 1. Aperçus de partage ──────────────────────────────────────────────────
$captures = @{
  fr = Join-Path $public "marketing\capture-analyse-ventes-mobile-fr.png"
  en = Join-Path $public "marketing\capture-analytics-sales-mobile-en.png"
}
$navy = [System.Drawing.ColorTranslator]::FromHtml("#062B5C")
$frame = [System.Drawing.ColorTranslator]::FromHtml("#021A3A")

foreach ($locale in "fr", "en") {
  $logo = [System.Drawing.Image]::FromFile($logoPath)
  $capture = [System.Drawing.Image]::FromFile($captures[$locale])
  $canvas = New-Object System.Drawing.Bitmap 1200, 630, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = New-Graphics $canvas
  try {
    $g.Clear([System.Drawing.Color]::White)

    # Panneau bleu marine à droite (couleur de la marque).
    $brush = New-Object System.Drawing.SolidBrush $navy
    $g.FillRectangle($brush, 700, 0, 500, 630)
    $brush.Dispose()

    # Logo officiel : largeur 600, hauteur dérivée du ratio réel.
    $logoW = 600
    $logoH = [Math]::Round($logoW * $logo.Height / $logo.Width)
    $g.DrawImage($logo, 50, [Math]::Round((630 - $logoH) / 2), $logoW, $logoH)

    # Capture réelle dans un cadre de téléphone (mêmes proportions).
    $capH = 560
    $capW = [Math]::Round($capH * $capture.Width / $capture.Height)
    $capX = 700 + [Math]::Round((500 - $capW) / 2)
    $capY = 35
    $border = 6
    $outer = New-RoundedPath ($capX - $border) ($capY - $border) ($capW + 2 * $border) ($capH + 2 * $border) 30
    $frameBrush = New-Object System.Drawing.SolidBrush $frame
    $g.FillPath($frameBrush, $outer)
    $frameBrush.Dispose()
    $outer.Dispose()
    $inner = New-RoundedPath $capX $capY $capW $capH 24
    $g.SetClip($inner)
    $g.DrawImage($capture, $capX, $capY, $capW, $capH)
    $g.ResetClip()
    $inner.Dispose()
  } finally {
    $g.Dispose()
    $logo.Dispose()
    $capture.Dispose()
  }
  $dest = Join-Path $public "marketing\og-stock-master-$locale.jpg"
  Save-Jpeg $canvas $dest 86
  $canvas.Dispose()
  Write-Output "$dest ($((Get-Item $dest).Length) octets)"
}

# ─── 2. Logo horizontal allégé ──────────────────────────────────────────────
$logo = [System.Drawing.Image]::FromFile($logoPath)
try {
  $w = 720
  $h = [Math]::Round($w * $logo.Height / $logo.Width)
  $small = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = New-Graphics $small
  try {
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($logo, 0, 0, $w, $h)
  } finally { $g.Dispose() }
  $dest = Join-Path $public "brand\stock-master-logo-horizontal-720.png"
  $small.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  Write-Output "$dest ${w}x$h ($((Get-Item $dest).Length) octets)"
} finally { $logo.Dispose() }
