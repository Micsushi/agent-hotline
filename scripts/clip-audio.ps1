<#
.SYNOPSIS
  Clip a section out of an audio file with ffmpeg. Re-encodes for a frame-
  accurate cut. Optional fade in/out so a looping jingle doesn't click.

.EXAMPLE
  # 12-second clip starting at 0:48
  ./scripts/clip-audio.ps1 -InputFile "$HOME\Downloads\Drake_-_Hotline_Bling_(MP3.cc).mp3" -Start 0:48 -Duration 12 -Output packages\desktop\public\hotline-bling.mp3

.EXAMPLE
  # Clip between two timestamps, with a 0.4s fade at each end
  ./scripts/clip-audio.ps1 -InputFile in.mp3 -Start 1:05 -End 1:20 -Fade 0.4 -Output out.mp3
#>
param(
  [Parameter(Mandatory = $true)] [string] $InputFile,
  [Parameter(Mandatory = $true)] [string] $Start,   # seconds or H:MM:SS / MM:SS
  [string] $Duration,                               # seconds (use this OR -End)
  [string] $End,                                    # seconds or timestamp
  [Parameter(Mandatory = $true)] [string] $Output,
  [double] $Fade = 0,                               # fade in+out length, seconds
  [double] $FadeIn = -1,                            # overrides -Fade for fade in
  [double] $FadeOut = -1,                           # overrides -Fade for fade out
  [double] $Volume = 1,                             # linear gain, e.g. 0.45 lowers without normalizing
  [int] $Bitrate = 192
)

$ErrorActionPreference = "Stop"

function Resolve-Ffmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  throw "ffmpeg not found. Open a new terminal (PATH was updated on install) or install with: winget install --id Gyan.FFmpeg -e --source winget"
}

$ffmpeg = Resolve-Ffmpeg
if (-not (Test-Path $InputFile)) { throw "Input not found: $InputFile" }

# Build the time selection. Put -ss before -i so MP3 downloads with unusual
# frame timestamps seek to the intended audible range instead of exporting
# silence from sparse decoded frames.
$ffArgs = @("-y", "-ss", $Start, "-i", $InputFile)
if ($Duration) { $ffArgs += @("-t", $Duration) }
elseif ($End)  { $ffArgs += @("-to", $End) }

$filters = @()
if ($Volume -ne 1) {
  if ($Volume -lt 0) { throw "Volume must be 0 or greater." }
  $filters += "volume=$Volume"
}

$fadeInDuration = if ($FadeIn -ge 0) { $FadeIn } else { $Fade }
$fadeOutDuration = if ($FadeOut -ge 0) { $FadeOut } else { $Fade }
if ($fadeInDuration -gt 0) {
  $filters += "afade=t=in:st=0:d=${fadeInDuration}"
}
if ($fadeOutDuration -gt 0) {
  # Fade-out needs an absolute start time within the clip; derive it from the
  # clip length when -Duration is given, else just fade in.
  if ($Duration) {
    $outStart = [double]$Duration - $fadeOutDuration
    $filters += "afade=t=out:st=${outStart}:d=${fadeOutDuration}"
  }
}

if ($filters.Count -gt 0) {
  $ffArgs += @("-af", ($filters -join ","))
}

$ffArgs += @("-c:a", "libmp3lame", "-b:a", "$($Bitrate)k", $Output)

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
Write-Host "ffmpeg $($ffArgs -join ' ')" -ForegroundColor DarkGray
# ffmpeg writes its banner to stderr; don't let that abort the script when the
# caller redirects stderr (2>&1). Judge success by the real exit code instead.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $ffmpeg @ffArgs
$code = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($code -ne 0) { throw "ffmpeg exited with code $code" }
Write-Host "Wrote $Output" -ForegroundColor Green
