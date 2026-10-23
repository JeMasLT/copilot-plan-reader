# Plan Reader setup: installs optional natural-voice engines and downloads offline Piper voices.
# Windows voices work without running this. Re-run any time; it skips what is already present.
param(
    [string[]]$PiperVoices = @(
        "en/en_US/lessac/medium/en_US-lessac-medium",
        "en/en_GB/alba/medium/en_GB-alba-medium",
        "lt/lt_LT/ingute/medium/lt_LT-ingute-medium",
        "lt/lt_LT/reginute1/medium/lt_LT-reginute1-medium"
    ),
    [switch]$SkipOnline,
    [switch]$SkipOffline
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
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

function Get-File($url, $out) {
    if (Test-Path $out) { return }
    Write-Host "Downloading $(Split-Path $out -Leaf)"
    Invoke-WebRequest $url -OutFile $out -UseBasicParsing
}

if (-not $SkipOffline) {
    $dir = Join-Path $here "artifacts\piper-voices"
    New-Item -ItemType Directory $dir -Force | Out-Null
    $base = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    foreach ($v in $PiperVoices) {
        $name = Split-Path $v -Leaf
        foreach ($ext in ".onnx", ".onnx.json") { Get-File "$base/$v$ext" (Join-Path $dir "$name$ext") }
    }

    # Lithuanian voices need the author's phonemizer until Piper ships it built in (1.9.0).
    if ($PiperVoices -match "lt_LT") {
        $lt = Join-Path $here "artifacts\piper-lt"
        New-Item -ItemType Directory $lt -Force | Out-Null
        $ing = "https://huggingface.co/RobertasTa/lt_LT-ingute-medium/resolve/main"
        $reg = "https://huggingface.co/RobertasTa/lt_LT-reginute1-medium/resolve/main"
        foreach ($f in "phonemize_lithuanian.py", "skaiciu_pletiklis.py", "synth_reginute.py", "lt_kirciai.tsv",
                       "lt_kreipiniai.tsv", "lt_raides.tsv", "zodziai_trumpi.txt", "LICENSE") {
            Get-File "$ing/$f" (Join-Path $lt $f)
        }
        Get-File "$ing/lt_LT-ingute-medium.onnx.json" (Join-Path $lt "lt_LT-ingute-medium.onnx.json")
        Get-File "$ing/LICENSE-VOICE" (Join-Path $lt "LICENSE-VOICE-ingute")
        Get-File "$reg/lt_LT-reginute1-medium.onnx.json" (Join-Path $lt "lt_LT-reginute1-medium.onnx.json")
        Get-File "$reg/README.md" (Join-Path $lt "README-reginute.md")
    }
}
Write-Host "Done. Restart the GitHub Copilot app to load Plan Reader."
