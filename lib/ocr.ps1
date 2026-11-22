# Persistent Windows.Media.Ocr worker: reads image paths or FAST_SCAN commands from stdin, writes JSON to stdout.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition '
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageName(IntPtr hProc, uint flags, StringBuilder buf, ref uint size);

  public static void InitDpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
  }

  public static string GetProcName(uint pid) {
    if (pid == 0) return "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      var sb = new StringBuilder(260);
      uint sz = (uint)sb.Capacity;
      if (!QueryFullProcessImageName(h, 0, sb, ref sz)) return "";
      string full = sb.ToString();
      int slash = full.LastIndexOf("\\");
      string file = slash >= 0 ? full.Substring(slash + 1) : full;
      return file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? file.Substring(0, file.Length - 4) : file;
    } finally { CloseHandle(h); }
  }

  private static bool IsBoxBg(byte r, byte g, byte b) {
    if (r < 65 || r > 215 || g < 70 || g > 220 || b < 75 || b > 225) return false;
    int mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    int mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    return (mx - mn) < 26;
  }

  private static string ReadBoxSockets(byte[] src, int w, int h, int bx, int by, int bw) {
    int y0 = Math.Min(h - 1, by + (int)Math.Round(bw * 0.04));
    int y1 = Math.Min(h - 1, by + (int)Math.Round(bw * 0.21));
    int ySep1 = Math.Min(h - 1, by + (int)Math.Round(bw * 0.15));
    int xStart = Math.Max(0, bx + (int)Math.Round(bw * 0.08));
    int xEnd = Math.Min(w - 1, bx + (int)Math.Round(bw * 0.92));
    int gapLim = Math.Max(4, (int)Math.Round(bw * 0.04));
    int minCw = Math.Max(6, (int)Math.Round(bw * 0.06));
    var clusters = new List<int[]>();
    int c0 = -1, c1 = -1, gap = 0;
    for (int x = xStart; x <= xEnd; x++) {
      bool active = false;
      for (int y = y0; y <= ySep1; y++) {
        int i = (y * w + x) * 4;
        byte b = src[i], g = src[i + 1], r = src[i + 2];
        int mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        int mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx < 48 || mx - mn > 30) { active = true; break; }
      }
      if (active) {
        if (c0 < 0) c0 = x;
        c1 = x; gap = 0;
      } else if (c0 >= 0) {
        if (++gap >= gapLim) { clusters.Add(new int[] { c0, c1 }); c0 = -1; }
      }
    }
    if (c0 >= 0) clusters.Add(new int[] { c0, c1 });
    var res = new List<string>();
    foreach (var c in clusters) {
      if (c[1] - c[0] < minCw) continue;
      int warm = 0, cool = 0, red = 0, green = 0, blue = 0, purple = 0, dark = 0;
      for (int y = y0; y <= y1; y++) {
        for (int x = c[0]; x <= c[1]; x++) {
          int i = (y * w + x) * 4;
          byte b = src[i], g = src[i + 1], r = src[i + 2];
          int mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          if (mx < 48) dark++;
          if (r - b > 35) warm++;
          if (b - r > 35) cool++;
          if (r - g > 55 && r - b > 55) red++;
          else if (g - r > 45 && g - b > 28) green++;
          else if (b - r > 55 && b - g > 20) blue++;
          else if (r - g > 40 && b - g > 40) purple++;
        }
      }
      if (dark < 6 && warm < 4 && cool < 4 && red < 4 && green < 4 && blue < 4 && purple < 4) continue;
      if (warm >= 3 && cool >= 3) { res.Add("prismatic"); continue; }
      string best = "red"; int bestV = red;
      if (green > bestV) { best = "green"; bestV = green; }
      if (blue > bestV) { best = "blue"; bestV = blue; }
      if (purple > bestV) { best = "purple"; bestV = purple; }
      res.Add(bestV >= 4 ? best : "gray");
      if (res.Count >= 3) break;
    }
    return string.Join(",", res.ToArray());
  }

  private static string DetectSockets(byte[] src, int w, int h, double sf) {
    int minRun = (int)Math.Round(75 * sf), maxRun = (int)Math.Round(180 * sf);
    int stepY = Math.Max(1, (int)Math.Round(sf));
    for (int y = 0; y < h; y += stepY) {
      int run = 0, start = 0;
      for (int x = 0; x < w; x++) {
        int i = (y * w + x) * 4;
        if (IsBoxBg(src[i + 2], src[i + 1], src[i])) { if (run == 0) start = x; run++; }
        else {
          if (run >= minRun && run <= maxRun) {
            int yTop = Math.Min(h - 1, y + (int)Math.Round(run * 0.14));
            int yBot = Math.Min(h - 1, y + (int)Math.Round(run * 0.88));
            int i2 = (yTop * w + start + 4) * 4, i3 = (yTop * w + start + run - 5) * 4;
            int i4 = (yBot * w + start + 6) * 4, i5 = (yBot * w + start + run - 7) * 4;
            int il = (yTop * w + Math.Max(0, start - 6)) * 4;
            int ir = (yTop * w + Math.Min(w - 1, start + run + 5)) * 4;
            if (IsBoxBg(src[i2 + 2], src[i2 + 1], src[i2]) && IsBoxBg(src[i3 + 2], src[i3 + 1], src[i3]) &&
                IsBoxBg(src[i4 + 2], src[i4 + 1], src[i4]) && IsBoxBg(src[i5 + 2], src[i5 + 1], src[i5]) &&
                Math.Max(src[il + 2], Math.Max(src[il + 1], src[il])) < 75 &&
                Math.Max(src[ir + 2], Math.Max(src[ir + 1], src[ir])) < 75) {
              string s = ReadBoxSockets(src, w, h, start, y, run);
              if (s.Length > 0) return s;
            }
          }
          run = 0;
        }
      }
    }
    return "";
  }

  public static byte[] FastCaptureBmp(int x, int y, int w, int h, int scale, double sf, out string sockets, out bool allBlack) {
    sockets = ""; allBlack = false;
    using (var raw = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(raw)) {
        g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      }
      var bdRaw = raw.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      byte[] rawBytes = new byte[w * h * 4];
      try { Marshal.Copy(bdRaw.Scan0, rawBytes, 0, rawBytes.Length); } finally { raw.UnlockBits(bdRaw); }

      int nonBlack = 0;
      for (int i = 0; i < rawBytes.Length; i += 4096) {
        if (rawBytes[i] > 2 || rawBytes[i + 1] > 2 || rawBytes[i + 2] > 2) { nonBlack++; break; }
      }
      if (nonBlack == 0) { allBlack = true; return null; }

      sockets = DetectSockets(rawBytes, w, h, sf);

      int ow = w * scale, oh = h * scale;
      int rowSize = ((ow * 3 + 3) / 4) * 4;
      byte[] bmp = new byte[54 + rowSize * oh];
      bmp[0] = 66; bmp[1] = 77;
      Buffer.BlockCopy(BitConverter.GetBytes(bmp.Length), 0, bmp, 2, 4);
      Buffer.BlockCopy(BitConverter.GetBytes(54), 0, bmp, 10, 4);
      Buffer.BlockCopy(BitConverter.GetBytes(40), 0, bmp, 14, 4);
      Buffer.BlockCopy(BitConverter.GetBytes(ow), 0, bmp, 18, 4);
      Buffer.BlockCopy(BitConverter.GetBytes(-oh), 0, bmp, 22, 4);
      bmp[26] = 1; bmp[28] = 24;
      if (scale == 2) {
        for (int yy = 0; yy < h; yy++) {
          int sRow = yy * w * 4;
          int dRow0 = 54 + (yy * 2) * rowSize;
          int dRow1 = dRow0 + rowSize;
          for (int xx = 0; xx < w; xx++) {
            int si = sRow + xx * 4;
            byte b = rawBytes[si], g = rawBytes[si + 1], r = rawBytes[si + 2];
            byte mn = b < g ? (b < r ? b : r) : (g < r ? g : r);
            byte v = mn > 112 ? (byte)0 : (byte)255;
            int dx = xx * 6;
            bmp[dRow0 + dx] = v; bmp[dRow0 + dx + 1] = v; bmp[dRow0 + dx + 2] = v;
            bmp[dRow0 + dx + 3] = v; bmp[dRow0 + dx + 4] = v; bmp[dRow0 + dx + 5] = v;
            bmp[dRow1 + dx] = v; bmp[dRow1 + dx + 1] = v; bmp[dRow1 + dx + 2] = v;
            bmp[dRow1 + dx + 3] = v; bmp[dRow1 + dx + 4] = v; bmp[dRow1 + dx + 5] = v;
          }
        }
      } else {
        for (int yy = 0; yy < h; yy++) {
          int sRow = yy * w * 4;
          int dRow = 54 + yy * rowSize;
          for (int xx = 0; xx < w; xx++) {
            int si = sRow + xx * 4;
            byte b = rawBytes[si], g = rawBytes[si + 1], r = rawBytes[si + 2];
            byte mn = b < g ? (b < r ? b : r) : (g < r ? g : r);
            byte v = mn > 112 ? (byte)0 : (byte)255;
            int di = dRow + xx * 3;
            bmp[di] = v; bmp[di + 1] = v; bmp[di + 2] = v;
          }
        }
      }
      return bmp;
    }
  }
}'
[FgWin]::InitDpi()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$null = [FgWin]::GetAsyncKeyState(0x76); $null = [FgWin]::GetAsyncKeyState(0x77); $null = [FgWin]::GetAsyncKeyState(0x78)
Write-Output '{"ready":true}'

$lastHwnd = [IntPtr]::Zero
$lastFgName = ''
$ocrCount = 0

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $p = $line.Trim()
  if (-not $p) { continue }
  if ($p -eq 'CHECK_FG') {
    try {
      $h = [FgWin]::GetForegroundWindow()
      if ($h -ne $lastHwnd) {
        $lastHwnd = $h
        [uint32]$procId = 0
        [FgWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
        $lastFgName = [FgWin]::GetProcName($procId)
      }
      $f7 = (([FgWin]::GetAsyncKeyState(0x76) -band 0x8001) -ne 0)
      $f8 = (([FgWin]::GetAsyncKeyState(0x77) -band 0x8001) -ne 0)
      $f9 = (([FgWin]::GetAsyncKeyState(0x78) -band 0x8001) -ne 0)
      $esc = $lastFgName.Replace('\','\\').Replace('"','\"')
      Write-Output "{`"fg`":`"$esc`",`"f7`":$($f7.ToString().ToLower()),`"f8`":$($f8.ToString().ToLower()),`"f9`":$($f9.ToString().ToLower())}"
    } catch { Write-Output '{"fg":""}' }
    continue
  }
  if ($p.StartsWith('FAST_SCAN ')) {
    $ms = $null; $ras = $null; $bmp = $null
    try {
      $parts = $p.Split(' ')
      $fx = [int]$parts[1]; $fy = [int]$parts[2]; $fw = [int]$parts[3]; $fh = [int]$parts[4]
      $fscale = [int]$parts[5]; $fsf = [double]$parts[6]
      $sockOut = ''; $allBlk = $false
      $bmpBytes = [FgWin]::FastCaptureBmp($fx, $fy, $fw, $fh, $fscale, $fsf, [ref]$sockOut, [ref]$allBlk)
      if ($allBlk -or $bmpBytes -eq $null) {
        Write-Output '{"fallback":true}'
        continue
      }
      $ms = New-Object System.IO.MemoryStream(,$bmpBytes)
      $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $txt = ($res.Lines | ForEach-Object { $_.Text }) -join "`n"
      $sockArr = if ($sockOut) { $sockOut.Split(',') } else { $null }
      Write-Output (@{ text = $txt; sockets = $sockArr } | ConvertTo-Json -Compress)
    } catch {
      Write-Output '{"fallback":true}'
    } finally {
      if ($bmp -ne $null) { try { $bmp.Dispose() } catch {} }
      if ($ras -ne $null) { try { $ras.Dispose() } catch {} }
      if ($ms -ne $null) { try { $ms.Dispose() } catch {} }
      $bmp = $null; $ras = $null; $dec = $null; $res = $null; $ms = $null; $bmpBytes = $null
      $ocrCount++
      if (($ocrCount % 25) -eq 0) { [GC]::Collect() }
    }
    continue
  }
  $fs = $null; $ras = $null; $bmp = $null
  try {
    $fs = [IO.File]::OpenRead($p)
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fs)
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $txt = ($res.Lines | ForEach-Object { $_.Text }) -join "`n"
    Write-Output (@{ text = $txt } | ConvertTo-Json -Compress)
  } catch {
    Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  } finally {
    if ($bmp -ne $null) { try { $bmp.Dispose() } catch {} }
    if ($ras -ne $null) { try { $ras.Dispose() } catch {} }
    if ($fs -ne $null) { try { $fs.Dispose() } catch {} }
    $bmp = $null; $ras = $null; $dec = $null; $res = $null; $fs = $null
    $ocrCount++
    if (($ocrCount % 30) -eq 0) { [GC]::Collect() }
  }
}
