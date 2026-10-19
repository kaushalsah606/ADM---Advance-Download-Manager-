# Builds assets/icon.ico and extension/icons/icon{16,48,128}.png from assets/logo.png.
# White background is removed (alpha recovered from the blue-on-white artwork). Large sizes use the full "ADM" mark,
# sizes <= 48 use the "D + download arrow" crop because the wide mark is unreadable when tiny.
param([string]$Logo = "$PSScriptRoot\..\assets\logo.png")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class Knock {
  public static Bitmap Crop(Bitmap src, Rectangle r, int size, double fill) {
    var o = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(o)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
      g.Clear(Color.White);
      double s = Math.Min(size * fill / r.Width, size * fill / r.Height);
      int w = (int)(r.Width * s), h = (int)(r.Height * s);
      g.DrawImage(src, new Rectangle((size - w) / 2, (size - h) / 2, w, h), r, GraphicsUnit.Pixel);
    }
    var d = o.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int n = d.Stride * size; byte[] b = new byte[n]; Marshal.Copy(d.Scan0, b, 0, n);
    for (int i = 0; i < n; i += 4) {
      int mx = Math.Max(255 - b[i], Math.Max(255 - b[i + 1], 255 - b[i + 2]));
      if (mx < 6) { b[i] = b[i + 1] = b[i + 2] = b[i + 3] = 0; continue; }
      double a = mx / 255.0;
      for (int k = 0; k < 3; k++) b[i + k] = (byte)Math.Max(0, Math.Min(255, (b[i + k] - 255 * (1 - a)) / a));
      b[i + 3] = (byte)mx;
    }
    Marshal.Copy(b, 0, d.Scan0, n); o.UnlockBits(d); return o;
  }
}
"@ -ReferencedAssemblies System.Drawing
$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Logo))
$full = New-Object System.Drawing.Rectangle 55, 335, 1180, 370     # whole "ADM" mark
$tight = New-Object System.Drawing.Rectangle 535, 335, 320, 370    # "D" with the download arrow
function Png($bmp) { $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); ,$ms.ToArray() }
function Pick([int]$n) { if ($n -ge 64) { [Knock]::Crop($src, $full, $n, 0.96) } else { [Knock]::Crop($src, $tight, $n, 0.92) } }
$sizes = 256, 64, 48, 32, 16
$imgs = foreach ($s in $sizes) { ,(Png (Pick $s)) }
$out = "$PSScriptRoot\..\assets\icon.ico"
$fs = [System.IO.File]::Create($out); $bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $imgs[$i]
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$d.Length); $bw.Write([uint32]$off); $off += $d.Length
}
foreach ($d in $imgs) { $bw.Write([byte[]]$d) }
$bw.Close()
New-Item -ItemType Directory -Force "$PSScriptRoot\..\extension\icons" | Out-Null
foreach ($s in 16, 48, 128) { [System.IO.File]::WriteAllBytes("$PSScriptRoot\..\extension\icons\icon$s.png", [byte[]](Png (Pick $s))) }
$src.Dispose()
Write-Host 'icons written'
