# Plan Reader setup: installs optional natural-voice engines and downloads offline Piper voices.
# Windows voices work without running this. Re-run any time; it skips what is already present.
param(
    [string[]]$PiperVoices = @("en_US/lessac/medium/en_US-lessac-medium", "en_GB/alba/medium/en_GB-alba-medium"),
    [switch]$SkipOnline,
    [switch]$SkipOffline
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$py = $null
foreach ($c in @("python", "py")) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
}
if (-not $py) {
    Write-Warning "Python 3 not found. Install it (e.g. 'winget install Python.Python.3.12') and re-run. Windows voices still work."
    exit 1
}

$pkgs = @()
if (-not $SkipOnline)  { $pkgs += "edge-tts" }
if (-not $SkipOffline) { $pkgs += "piper-tts" }
if ($pkgs) {
    Write-Host "Installing Python packages: $($pkgs -join ', ')"
    & $py -m pip install --upgrade --quiet @pkgs
}

if (-not $SkipOffline) {
    $dir = Join-Path $here "artifacts\piper-voices"
    New-Item -ItemType Directory $dir -Force | Out-Null
    $base = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en"
    foreach ($v in $PiperVoices) {
        $name = Split-Path $v -Leaf
        foreach ($ext in ".onnx", ".onnx.json") {
            $out = Join-Path $dir "$name$ext"
            if (Test-Path $out) { continue }
            Write-Host "Downloading $name$ext"
            Invoke-WebRequest "$base/$v$ext" -OutFile $out -UseBasicParsing
        }
    }
}
Write-Host "Done. Restart the GitHub Copilot app to load Plan Reader."
