<#
.SYNOPSIS
  Encode the five hero-video assets the homepage expects, straight from raw
  camera footage.

.DESCRIPTION
  index.html asks for four video files and a poster:

      video/hero.webm          1080p VP9    desktop
      video/hero.mp4           1080p H.264  desktop fallback
      video/hero-mobile.webm    720p VP9    phones
      video/hero-mobile.mp4     720p H.264  phone fallback
      images/hero-poster.webp   frame 1     paints instantly

  This runs all five encodes in one pass with the settings documented in
  SETUP.md §3. Feed it the original .MOV — there is no need to convert the
  whole file to MP4 first. ffmpeg input-seeks, so a 1.4 GB source costs
  no more than a small one; it never decodes the parts you didn't ask for.

  The poster is deliberately pulled from the finished hero.mp4 rather than
  from the source, so it is byte-for-byte the first frame of playback and
  the handoff from image to video is invisible.

.PARAMETER Path
  Raw source footage. Any format ffmpeg reads (.MOV, .MTS, .MP4 …).

.PARAMETER Start
  Where your chosen loop begins — `00:01:24` or plain seconds. Defaults to
  the start of the file.

.PARAMETER Duration
  Loop length in seconds. Defaults to 15. Keep it in the 10-15 range: the
  clip is muted background texture behind a dark overlay, and every extra
  second is weight every visitor pays for.

.PARAMETER Seamless
  Make the clip loop with no visible jump.

  A moving camera is never back where it started after 15 seconds, so a
  straight cut from the last frame to the first always jumps. This grabs
  Duration + Crossfade seconds and dissolves the tail into the head, so the
  frame at the end of the loop is literally the same frame the loop restarts
  on. The seam becomes a slow dissolve instead of a cut.

  Costs you nothing in output length — the result is still exactly Duration
  seconds. Use it for any handheld, drone, or dolly footage.

.PARAMETER Crossfade
  Length of that dissolve in seconds. Default 1.2, which reads as a gentle
  drift. Go longer (2-3) for fast camera movement where a short blend still
  reads as a jump; shorter (0.5) for near-static footage.

.PARAMETER TargetMB
  Size budget for each desktop file, in MB. Default 3.5.

  This is a budget, not a quality setting: both encodes run two-pass at a
  bitrate computed from it, so the output lands within a few percent of the
  number you ask for regardless of how hard the footage is. CRF cannot do
  that — the same CRF produces wildly different sizes on a static interior
  and a moving drone shot.

  The budget is PER FILE, not per pair. A visitor downloads either the WebM
  or the MP4, never both: Chrome, Edge and Firefox take the WebM, Safari
  takes the MP4. The phone tier is encoded at 40% of this.

.PARAMETER Width
  Desktop width in pixels, default 1600 (phones get 1280).

  Deliberately below 1920. At a fixed byte budget, fewer pixels each get
  more bits, and for busy footage that trade is worth taking — 1920 spends
  its budget on visible blocking, while 1600 upscales cleanly. The hero is
  scaled to cover the viewport and sits under a dark overlay, so the nominal
  resolution drop is invisible and the artifact reduction is not.

.PARAMETER Force
  Overwrite existing hero files.

.EXAMPLE
  tools\Build-HeroVideo.ps1 _source\GX010042.MOV -Start 00:02:15
  Takes 15 seconds from 2:15 and writes all five assets.

.NOTES
  Pick a segment that loops cleanly — the end should resemble the beginning,
  since playback cuts straight back to the first frame with no crossfade.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [string] $Path,

  [string] $Start = '0',

  [ValidateRange(3, 60)]
  [double] $Duration = 15,

  [switch] $Seamless,

  [ValidateRange(0.3, 4)]
  [double] $Crossfade = 1.2,

  [ValidateRange(0.5, 20)]
  [double] $TargetMB = 3.5,

  [ValidateRange(640, 3840)]
  [int] $Width = 1600,

  [switch] $Force
)

$ErrorActionPreference = 'Stop'

# Anchor every output to the repo root (the parent of tools/) so the script
# behaves the same whether it is run from the root or from inside tools/.
$root = Split-Path $PSScriptRoot -Parent

function Format-Size([long] $bytes) {
  if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
  return '{0:N0} KB' -f ($bytes / 1KB)
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'ffmpeg is not on PATH. Install it with:  winget install Gyan.FFmpeg'
}

$src = Get-Item -LiteralPath $Path

$targets = @(
  (Join-Path $root 'video\hero.webm'),
  (Join-Path $root 'video\hero.mp4'),
  (Join-Path $root 'video\hero-mobile.webm'),
  (Join-Path $root 'video\hero-mobile.mp4'),
  (Join-Path $root 'images\hero-poster.webp')
)
if (-not $Force) {
  $clash = $targets | Where-Object { Test-Path -LiteralPath $_ }
  if ($clash) {
    throw "These already exist — pass -Force to replace them:`n  " +
          (($clash | ForEach-Object { Split-Path $_ -Leaf }) -join "`n  ")
  }
}

foreach ($d in 'video', 'images') {
  $dir = Join-Path $root $d
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
}

Write-Host ''
Write-Host "  Source    $($src.Name)  ($(Format-Size $src.Length))"
Write-Host "  Segment   ${Duration}s from $Start"
if ($Seamless) {
  Write-Host "  Loop      seamless (${Crossfade}s dissolve, tail into head)"
} else {
  Write-Host '  Loop      hard cut — pass -Seamless if the restart jumps'
}
Write-Host ''

# -ss ahead of -i is a keyframe seek: ffmpeg jumps to the offset instead of
# decoding everything before it. This is what keeps a multi-GB source cheap.
# -an strips audio outright — the hero is permanently muted, so shipping an
# audio track would be pure waste.
# With -Seamless we must pull Crossfade seconds *beyond* the requested loop,
# because those extra frames are what gets dissolved back over the opening.
$grab = if ($Seamless) { $Duration + $Crossfade } else { $Duration }

$common = @('-hide_banner', '-loglevel', 'error', '-stats',
            '-ss', $Start, '-i', $src.FullName, '-t', "$grab", '-an')

# Build the video filter for a given output width.
#
# Plain mode is a straight scale. Seamless mode splits the grabbed clip into
# three spans and reassembles them so the loop point is a repeat of one frame:
#
#     head  = 0 .. C          the opening, which the tail dissolves into
#     mid   = C .. D          the untouched middle
#     tail  = D .. D+C        the overshoot, dissolved over head
#
#     output = xfade(tail -> head) ++ mid          (length D, unchanged)
#
# The output ends on source time D and restarts on source time D — the same
# instant — so the wrap is invisible. setpts=PTS-STARTPTS on each span resets
# timestamps to zero, without which trim leaves gaps that stall xfade.
function New-Filter([int] $width) {
  $scale = "scale=${width}:-2"
  if (-not $Seamless) { return "$scale,format=yuv420p" }

  $c = $Crossfade
  $d = $Duration
  $e = $Duration + $Crossfade
  return (
    "[0:v]setpts=PTS-STARTPTS,split=3[a][b][c];" +
    "[a]trim=0:$c,setpts=PTS-STARTPTS[head];" +
    "[b]trim=${c}:$d,setpts=PTS-STARTPTS[mid];" +
    "[c]trim=${d}:$e,setpts=PTS-STARTPTS[tail];" +
    "[tail][head]xfade=transition=fade:duration=${c}:offset=0[seam];" +
    "[seam][mid]concat=n=2:v=1:a=0,$scale,format=yuv420p[vout]"
  )
}

# Convert a size budget into the bitrate that fills it over this clip length.
# 1 MB = 1048576 bytes = 8388608 bits; ffmpeg's -b:v is in kbit/s (1000 bits).
function Get-Bitrate([double] $mb) {
  [int] [math]::Round($mb * 8388608 / $Duration / 1000)
}

$mobileMB = $TargetMB * 0.4

$jobs = @(
  @{ Name = 'hero.webm';        Width = $Width; MB = $TargetMB
     Out  = Join-Path $root 'video\hero.webm'
     Codec = @('-c:v', 'libvpx-vp9', '-row-mt', '1')
     Final = @() },

  @{ Name = 'hero.mp4';         Width = $Width; MB = $TargetMB
     Out  = Join-Path $root 'video\hero.mp4'
     Codec = @('-c:v', 'libx264', '-preset', 'slow')
     Final = @('-movflags', '+faststart') },

  @{ Name = 'hero-mobile.webm'; Width = 1280;   MB = $mobileMB
     Out  = Join-Path $root 'video\hero-mobile.webm'
     Codec = @('-c:v', 'libvpx-vp9', '-row-mt', '1')
     Final = @() },

  @{ Name = 'hero-mobile.mp4';  Width = 1280;   MB = $mobileMB
     Out  = Join-Path $root 'video\hero-mobile.mp4'
     Codec = @('-c:v', 'libx264', '-preset', 'slow')
     Final = @('-movflags', '+faststart') }
)

# Two-pass writes a stats file next to -passlogfile. Keep it in TEMP so a
# failed run cannot leave .log turds in the repo.
$passLog = Join-Path ([System.IO.Path]::GetTempPath()) "hero-pass-$PID"

$clock = [System.Diagnostics.Stopwatch]::StartNew()

try {
  foreach ($j in $jobs) {
    $kbps = Get-Bitrate $j.MB
    Write-Host ("  Encoding  {0,-18} {1} wide, {2} kbps" -f $j.Name, $j.Width, $kbps)

    $filter = New-Filter $j.Width
    # -filter_complex names its output, so it needs an explicit -map; the
    # simple -vf path has no name to map.
    $filterArgs = if ($Seamless) { @('-filter_complex', $filter, '-map', '[vout]') }
                  else           { @('-vf', $filter) }

    # Pass 1 measures the clip and writes the stats file; pass 2 spends the
    # budget where pass 1 found the hard frames. This is what makes the
    # output size predictable — a single pass cannot know what is coming.
    & ffmpeg @common @filterArgs @($j.Codec) -b:v "${kbps}k" `
             -passlogfile $passLog -pass 1 -f null NUL
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg pass 1 failed on $($j.Name) (exit $LASTEXITCODE)." }

    & ffmpeg @common @filterArgs @($j.Codec) -b:v "${kbps}k" `
             -passlogfile $passLog -pass 2 @($j.Final) -y $j.Out
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg pass 2 failed on $($j.Name) (exit $LASTEXITCODE)." }
  }
}
finally {
  Remove-Item "$passLog*" -Force -ErrorAction SilentlyContinue
}

# Poster comes from the finished desktop MP4, not the source, so it matches
# frame 1 of playback exactly.
$poster = Join-Path $root 'images\hero-poster.webp'
Write-Host '  Encoding  hero-poster.webp ...'
& ffmpeg -hide_banner -loglevel error -i (Join-Path $root 'video\hero.mp4') `
         -frames:v 1 -c:v libwebp -quality 82 -y $poster
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on the poster (exit $LASTEXITCODE)." }

$clock.Stop()

Write-Host ''
Write-Host "  Done in $($clock.Elapsed.ToString('hh\:mm\:ss'))"
Write-Host ''

foreach ($t in $targets) {
  $f = Get-Item -LiteralPath $t
  '    {0,-24} {1}' -f $f.Name, (Format-Size $f.Length) | Write-Host
}

# Report what a visitor actually downloads, which is ONE video plus the
# poster — never both codecs. Summing the four files would roughly triple
# the apparent weight and describe a download nobody performs.
$poster  = (Get-Item (Join-Path $root 'images\hero-poster.webp')).Length
$deskMax = (Get-Item (Join-Path $root 'video\hero.webm')).Length,
           (Get-Item (Join-Path $root 'video\hero.mp4')).Length |
           Measure-Object -Maximum | Select-Object -ExpandProperty Maximum
$mobMax  = (Get-Item (Join-Path $root 'video\hero-mobile.webm')).Length,
           (Get-Item (Join-Path $root 'video\hero-mobile.mp4')).Length |
           Measure-Object -Maximum | Select-Object -ExpandProperty Maximum

Write-Host ''
Write-Host '  What one visitor actually downloads (worst codec + poster):'
Write-Host "    desktop                $(Format-Size ($deskMax + $poster))"
Write-Host "    phone                  $(Format-Size ($mobMax + $poster))"
Write-Host ''

Write-Host '  Preview locally, then deploy:'
Write-Host '    python -m http.server 8000     # then open http://localhost:8000'
Write-Host '    vercel --prod'
Write-Host ''
