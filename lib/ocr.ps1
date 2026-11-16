# Persistent Windows.Media.Ocr worker: reads image paths from stdin, writes JSON {"text":...} to stdout.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
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
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Write-Output '{"ready":true}'

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $p = $line.Trim()
  if (-not $p) { continue }
  if ($p -eq 'CHECK_FG') {
    try {
      [uint32]$procId = 0
      $h = [FgWin]::GetForegroundWindow()
      [FgWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
      $f7 = (([FgWin]::GetAsyncKeyState(0x76) -band 0x8000) -ne 0)
      $f8 = (([FgWin]::GetAsyncKeyState(0x77) -band 0x8000) -ne 0)
      $f9 = (([FgWin]::GetAsyncKeyState(0x78) -band 0x8000) -ne 0)
      Write-Output (@{ fg = "$name"; f7 = $f7; f8 = $f8; f9 = $f9 } | ConvertTo-Json -Compress)
    } catch { Write-Output '{"fg":""}' }
    continue
  }
  try {
    $fs = [IO.File]::OpenRead($p)
    try {
      $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fs)
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $txt = ($res.Lines | ForEach-Object { $_.Text }) -join "`n"
      Write-Output (@{ text = $txt } | ConvertTo-Json -Compress)
    } finally { $fs.Dispose() }
  } catch {
    Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  }
}
