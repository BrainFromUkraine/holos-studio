# Download the pinned uv.exe and ffmpeg.exe into app/src-tauri/resources/bin (Windows; used by CI and local builds).
#
#   pwsh scripts/fetch-binaries.ps1
#
# Bump a version: change it here together with its SHA-256 (Get-FileHash <zip> -Algorithm SHA256).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar

$UvVersion = "0.11.32"
$UvSha256 = "acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984"
# FFmpeg "essentials" build by Gyan Doshi (GPL: includes libx264 used by the video templates, libmp3lame, aac).
$FfmpegVersion = "8.0.1"
$FfmpegSha256 = "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673"

$Root = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $Root "app/src-tauri/resources/bin"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("holos-bin-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Bin, $Tmp | Out-Null

function Get-Verified($Url, $Sha256, $Out) {
    Write-Host "GET $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Out
    $actual = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Sha256) { throw "SHA-256 mismatch for ${Url}: $actual" }
}

try {
    $uvZip = Join-Path $Tmp "uv.zip"
    Get-Verified "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" $UvSha256 $uvZip
    Expand-Archive $uvZip -DestinationPath (Join-Path $Tmp "uv")
    Copy-Item (Join-Path $Tmp "uv/uv.exe") (Join-Path $Bin "uv.exe") -Force

    $ffZip = Join-Path $Tmp "ffmpeg.zip"
    Get-Verified "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/ffmpeg-$FfmpegVersion-essentials_build.zip" $FfmpegSha256 $ffZip
    Expand-Archive $ffZip -DestinationPath (Join-Path $Tmp "ffmpeg")
    $ffDir = Join-Path $Tmp "ffmpeg/ffmpeg-$FfmpegVersion-essentials_build"
    Copy-Item (Join-Path $ffDir "bin/ffmpeg.exe") (Join-Path $Bin "ffmpeg.exe") -Force
    Copy-Item (Join-Path $ffDir "LICENSE") (Join-Path $Bin "FFMPEG-LICENSE.txt") -Force
    Copy-Item (Join-Path $ffDir "README.txt") (Join-Path $Bin "FFMPEG-README.txt") -Force

    & (Join-Path $Bin "uv.exe") --version
    & (Join-Path $Bin "ffmpeg.exe") -hide_banner -version | Select-Object -First 1
    Get-ChildItem $Bin | Format-Table Name, Length
}
finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
