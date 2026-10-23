# Generates the navigation voice cues with the Windows built-in speech engine
# (SAPI 5). No internet, no extra install.
#
# THIS FILE IS INTENTIONALLY PURE ASCII -- same reason as 启动游戏.bat:
# cmd/powershell mangle non-ASCII text depending on the console code page.
# The Chinese lines live in tools/voice-lines.json, which is read as UTF-8.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-voice.ps1
#   powershell ... -File tools/make-voice.ps1 -Rate 3 -Out assets/audio/voice
#
# Rate is SAPI's -10..10 (0 is normal, higher is faster).
# Voice defaults to the first Chinese voice found.

param(
  [string]$Lines = "tools/voice-lines.json",
  [string]$Out = "assets/audio/voice",
  [int]$Rate = 2,
  [int]$Format = 12,
  [string]$Only = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Lines)) { throw "cannot find $Lines" }
$json = Get-Content -Path $Lines -Encoding UTF8 -Raw | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$voice = New-Object -ComObject SAPI.SpVoice
# Speed. Forgetting this line is why three runs at different rates produced
# byte-identical files once -- the parameter was printed but never applied.
$voice.Rate = $Rate

# Prefer a Chinese voice; fall back to whatever is default.
$chosen = $null
$i = 0
foreach ($t in $voice.GetVoices()) {
  $desc = $t.GetDescription()
  if ($desc -match "Chinese") { $chosen = $t; break }
  $i++
}
if ($chosen -ne $null) { $voice.Voice = $chosen }
Write-Output ("voice : " + $voice.Voice.GetDescription())
Write-Output ("rate  : " + $Rate + "   format: " + $Format)
Write-Output ""

foreach ($p in $json.PSObject.Properties) {
  if ($Only -ne "" -and $p.Name -ne $Only) { continue }

  $path = Join-Path $Out ($p.Name + ".wav")
  if (Test-Path $path) { Remove-Item $path -Force }

  $fs = New-Object -ComObject SAPI.SpFileStream
  $fs.Format.Type = $Format
  $fs.Open($path, 3, $false)   # 3 = SSFMCreateForWrite
  $voice.AudioOutputStream = $fs
  $voice.Speak($p.Value) | Out-Null
  $fs.Close()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($fs) | Out-Null

  $bytes = (Get-Item $path).Length
  Write-Output ("  {0,-20} {1,9} B" -f $p.Name, $bytes)
}

Write-Output ""
Write-Output "done."
