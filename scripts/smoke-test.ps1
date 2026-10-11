# Windows smoke test of a built installer: silent per-user install → first run (uv setup) → engine answers
# → graceful close stops the engine → relaunch → hard kill of the app stops the engine (Job Object).
#
#   pwsh scripts/smoke-test.ps1 -Installer "app/src-tauri/target/release/bundle/nsis/Holos Studio_0.2.0_x64-setup.exe"
#
# Meant for CI (a clean machine); on your own PC it installs Holos Studio and creates its ~5 GB environment.
# Results are also printed as GitHub annotations.

param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = "Stop"
$Install = Join-Path $env:LOCALAPPDATA "Holos Studio"
$Data = Join-Path $env:LOCALAPPDATA "com.brainfromukraine.holos"

function Note($msg) { Write-Output "::notice title=Smoke test::$msg" }

function Get-EngineProcs {
    # holos.exe (uv launcher) and the python.exe it runs — everything started from our data folder.
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Data, [StringComparison]::OrdinalIgnoreCase) }
}

function Wait-Engine($app, [int]$minutes) {
    $deadline = (Get-Date).AddMinutes($minutes)
    while ($true) {
        $eng = Get-CimInstance Win32_Process -Filter "Name='holos.exe'" | Where-Object { $_.CommandLine -match "serve --port (\d+)" } | Select-Object -First 1
        if ($eng) {
            $port = [regex]::Match($eng.CommandLine, "--port (\d+)").Groups[1].Value
            try { return Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3 } catch { }
        }
        if ($app.HasExited) { throw "app exited (code $($app.ExitCode)) before the engine answered" }
        if ((Get-Date) -gt $deadline) { throw "engine did not answer within $minutes min" }
        Start-Sleep -Seconds 5
    }
}

function Wait-NoEngine([string]$when) {
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-EngineProcs)) { return }
        Start-Sleep -Seconds 1
    }
    $left = (Get-EngineProcs | ForEach-Object { $_.Name }) -join ", "
    throw "engine processes still running after ${when}: $left"
}

try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process -FilePath $Installer -ArgumentList "/S" -Wait
    foreach ($f in "bin\uv.exe", "bin\ffmpeg.exe", "engine\pyproject.toml", "engine\uv.lock", "engine\src\holos\__init__.py", "engine\src\holos\assets\silero_vad.onnx") {
        if (-not (Test-Path (Join-Path $Install $f))) { throw "installed app is missing $f" }
    }
    $exe = Get-ChildItem $Install -Filter *.exe | Where-Object { $_.Name -notmatch "^uninstall" } | Select-Object -First 1
    $size = "{0:N0} MB" -f ((Get-ChildItem $Install -Recurse | Measure-Object Length -Sum).Sum / 1MB)
    Note "installed $($exe.Name) to $Install ($size) in $([int]$sw.Elapsed.TotalSeconds) s"

    # First run: setup + start.
    $sw.Restart()
    $app = Start-Process -FilePath $exe.FullName -PassThru
    $health = Wait-Engine $app 30
    $envSize = "{0:N1} GB" -f ((Get-ChildItem $Data -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB)
    Note "first run: engine $($health.version) ready in $([int]$sw.Elapsed.TotalSeconds) s · asr=$($health.asr) · ffmpeg=$($health.ffmpeg) · auth=$($health.auth) · data $envSize"
    if (-not $health.auth) { throw "engine runs without a token" }
    if (-not $health.ffmpeg) { throw "engine does not see the bundled ffmpeg" }

    # Graceful close (title-bar X) → the app kills the engine.
    $app.Refresh()
    $app.CloseMainWindow() | Out-Null
    if (-not $app.WaitForExit(30000)) { throw "app did not close" }
    Wait-NoEngine "closing the window"
    Note "window close: app and engine stopped"

    # Second run: no setup, fast start. Then hard kill → the Job Object takes the engine down.
    $sw.Restart()
    $app = Start-Process -FilePath $exe.FullName -PassThru
    $null = Wait-Engine $app 5
    Note "second run: engine ready in $([int]$sw.Elapsed.TotalSeconds) s (no setup)"
    Stop-Process -Id $app.Id -Force
    Wait-NoEngine "killing the app"
    Note "app killed: engine stopped with it"
}
catch {
    $log = Join-Path $Data "engine.log"
    $tail = if (Test-Path $log) { (Get-Content $log -Tail 40) -join "%0A" } else { "(no engine.log)" }
    Write-Output "::error title=Smoke test failed::$($_.Exception.Message)%0A%0Aengine.log:%0A$tail"
    exit 1
}
