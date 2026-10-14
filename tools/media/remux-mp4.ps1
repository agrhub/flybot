# Re-encode a video recorded in Chrome (fragmented MP4, no duration in its header) into a plain
# MP4 that PowerPoint and Windows players accept, with Windows' own encoder (no ffmpeg needed).
# Usage: powershell -NoProfile -File remux-mp4.ps1 <in.mp4> <out.mp4> [bitrate, default 1200000] [width height, default 1280 720] [-Audio]
# -Audio keeps the sound (AAC, 48 kHz stereo), e.g. for a smaller copy of the commercial.
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Bitrate = 1200000,
    [int]$Width = 1280,
    [int]$Height = 720,
    [switch]$Audio
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]

$extensions = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
function Await-Operation($operation, [Type]$resultType) {
    $method = ($extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod($resultType)
    $task = $method.Invoke($null, @($operation)); $task.Wait(-1) | Out-Null; $task.Result
}
function Await-Progress($action, [Type]$progressType) {
    $method = ($extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1' })[0].MakeGenericMethod($progressType)
    $task = $method.Invoke($null, @($action)); $task.Wait(-1) | Out-Null
}

$inPath = (Resolve-Path $In).Path
$outFull = [System.IO.Path]::GetFullPath($Out)
$source = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inPath)) ([Windows.Storage.StorageFile])
$folder = Await-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([System.IO.Path]::GetDirectoryName($outFull))) ([Windows.Storage.StorageFolder])
$target = Await-Operation ($folder.CreateFileAsync([System.IO.Path]::GetFileName($outFull), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

# H.264; the tour has no sound, the commercial keeps its own
$quality = if ($Height -ge 1080) { [Windows.Media.MediaProperties.VideoEncodingQuality]::HD1080p } else { [Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p }
$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4($quality)
if ($Audio) { $profile.Audio = [Windows.Media.MediaProperties.AudioEncodingProperties]::CreateAac(48000, 2, 160000) } else { $profile.Audio = $null }
$profile.Video.Bitrate = $Bitrate
$profile.Video.Width = $Width
$profile.Video.Height = $Height

$transcoder = New-Object Windows.Media.Transcoding.MediaTranscoder
$prepared = Await-Operation ($transcoder.PrepareFileTranscodeAsync($source, $target, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if (-not $prepared.CanTranscode) { throw "Cannot transcode: $($prepared.FailureReason)" }
Await-Progress ($prepared.TranscodeAsync()) ([double])
$size = [math]::Round((Get-Item $outFull).Length / 1KB)
"$outFull ($size KB)"
