<#
.SYNOPSIS
  Convert any video (.MOV, .MTS, .AVI, .MKV …) to a web-ready .mp4 — locally,
  with no file-size limit and no upload.

.DESCRIPTION
  Wraps ffmpeg, which is already installed on this machine. Because the work
  happens on your own CPU/GPU, a 1.4 GB source is no different from a 14 GB
  one: nothing is uploaded, nothing is metered, and nothing asks for a card.

  Output is H.264 + AAC in an MP4 with `+faststart`, which is the combination
  every browser, phone, and social platform accepts without transcoding.

.PARAMETER Path
  The source video. Positional, so `.\Convert-Video.ps1 clip.MOV` works.

.PARAMETER Output
  Destination .mp4. Defaults to the source name with an .mp4 extension,
  written next to the source. Refuses to overwrite unless -Force is given.

.PARAMETER Quality
  high      — near-visually-lossless, largest file (CRF 20)
  balanced  — the default; the usual choice for sharing or archiving (CRF 23)
  small     — aggressive, for email or slow connections (CRF 28)

.PARAMETER MaxWidth
  Downscale so the width is at most this many pixels; height follows the
  source aspect ratio. Skipped entirely if the source is already narrower,
  so this never upscales. 1920 is a sensible ceiling for most uses.

.PARAMETER Fast
  Encode on the Intel Quick Sync hardware encoder instead of the CPU.
  Several times faster, at a modest cost in quality per megabyte. Worth it
  for long footage; not worth it for a short web hero clip.

.PARAMETER Start
  Seek to this timestamp before encoding (`00:01:30` or plain seconds).

.PARAMETER Duration
  Encode only this many seconds from -Start.

.PARAMETER Force
  Overwrite the output file if it already exists.

.EXAMPLE
  .\Convert-Video.ps1 'C:\Users\HENDO\Videos\GX010042.MOV'
  Converts alongside the source, balanced quality.

.EXAMPLE
  .\Convert-Video.ps1 big.MOV -MaxWidth 1920 -Fast
  1080p ceiling, hardware-encoded — the fastest way through a multi-GB file.

.EXAMPLE
  .\Convert-Video.ps1 big.MOV -Start 00:02:15 -Duration 15 -Quality high
  Pulls a high-quality 15-second excerpt starting at 2:15.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [string] $Path,

  [Parameter(Position = 1)]
  [string] $Output,

  [ValidateSet('high', 'balanced', 'small')]
  [string] $Quality = 'balanced',

  [ValidateRange(160, 7680)]
  [int] $MaxWidth,

  [switch] $Fast,

  [string] $Start,

  [double] $Duration,

  [switch] $Force
)

$ErrorActionPreference = 'Stop'

function Format-Size([long] $bytes) {
  if ($bytes -ge 1GB) { return '{0:N2} GB' -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
  return '{0:N0} KB' -f ($bytes / 1KB)
}

# ── Preflight ───────────────────────────────────────────────────────────────
foreach ($tool in 'ffmpeg', 'ffprobe') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool is not on PATH. Install it with:  winget install Gyan.FFmpeg"
  }
}

$src = Get-Item -LiteralPath $Path
if ($src.PSIsContainer) { throw "$Path is a folder, not a video file." }

if (-not $Output) {
  $Output = Join-Path $src.DirectoryName ($src.BaseName + '.mp4')
}
# Resolve to a full path so ffmpeg writes where the user expects regardless of
# the current directory.
$Output = [System.IO.Path]::GetFullPath(
  [System.IO.Path]::Combine((Get-Location).Path, $Output))

if ($Output -eq $src.FullName) {
  throw 'Output would overwrite the source. Pass a different -Output path.'
}
if ((Test-Path -LiteralPath $Output) -and -not $Force) {
  throw "$Output already exists. Pass -Force to overwrite it."
}
$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

# ── Inspect the source ──────────────────────────────────────────────────────
# One ffprobe call for everything we need; -v error keeps the banner out of it.
$probe = & ffprobe -v error -select_streams v:0 `
  -show_entries 'stream=width,height,codec_name:format=duration' `
  -of json -- $src.FullName | ConvertFrom-Json

$stream  = $probe.streams[0]
$srcW    = [int] $stream.width
$srcSecs = [double] $probe.format.duration

Write-Host ''
Write-Host "  Source   $($src.Name)"
Write-Host "           $(Format-Size $src.Length) · $($stream.codec_name) · ${srcW}x$($stream.height) · $([TimeSpan]::FromSeconds($srcSecs).ToString('hh\:mm\:ss'))"

# ── Build the encode ────────────────────────────────────────────────────────
$ff = @('-hide_banner', '-loglevel', 'warning', '-stats')

# -ss before -i makes ffmpeg jump straight to the keyframe rather than decoding
# everything up to that point. On a multi-GB file this is the difference
# between seconds and many minutes.
if ($Start) { $ff += @('-ss', $Start) }
$ff += @('-i', $src.FullName)
if ($PSBoundParameters.ContainsKey('Duration')) { $ff += @('-t', "$Duration") }

# `0:a?` — the ? makes the audio stream optional, so silent footage still works.
$ff += @('-map', '0:v:0', '-map', '0:a?')

# Only downscale; never enlarge a source that is already smaller than -MaxWidth.
# -2 keeps the height even, which H.264 requires with 4:2:0 chroma.
if ($MaxWidth -and $srcW -gt $MaxWidth) {
  $ff += @('-vf', "scale=${MaxWidth}:-2")
  Write-Host "  Scaling  ${srcW}px wide -> ${MaxWidth}px"
}
elseif ($MaxWidth) {
  Write-Host "  Scaling  skipped (source is already ${srcW}px wide)"
}

if ($Fast) {
  # Quick Sync uses -global_quality rather than CRF, on a coarser scale.
  $q = @{ high = 20; balanced = 25; small = 32 }[$Quality]
  $ff += @('-c:v', 'h264_qsv', '-global_quality', "$q", '-preset', 'slow')
  $encoder = "h264_qsv (Intel Quick Sync, global_quality $q)"
}
else {
  $crf = @{ high = 20; balanced = 23; small = 28 }[$Quality]
  $ff += @('-c:v', 'libx264', '-crf', "$crf", '-preset', 'medium')
  $encoder = "libx264 (CPU, CRF $crf)"
}

# yuv420p is the compatibility floor — it flattens 10-bit iPhone/HEVC footage
# that Windows Media Player, older Safari, and most social uploads refuse.
# +faststart relocates the index to the front so playback can begin before the
# file has fully downloaded.
$ff += @(
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart'
)
if ($Force) { $ff += '-y' }
$ff += $Output

Write-Host "  Encoder  $encoder"
Write-Host "  Output   $Output"
Write-Host ''

$clock = [System.Diagnostics.Stopwatch]::StartNew()
& ffmpeg @ff
$clock.Stop()

if ($LASTEXITCODE -ne 0) {
  throw "ffmpeg exited with code $LASTEXITCODE — the output may be incomplete."
}

# ── Report ──────────────────────────────────────────────────────────────────
$out     = Get-Item -LiteralPath $Output
$saved   = 100 - ($out.Length / $src.Length * 100)
$elapsed = $clock.Elapsed.ToString('hh\:mm\:ss')

Write-Host ''
Write-Host "  Done in $elapsed"
Write-Host "  $(Format-Size $src.Length)  ->  $(Format-Size $out.Length)   ($([math]::Round($saved,1))% smaller)"
Write-Host ''
