# Plan Reader (TTS) — GitHub Copilot app canvas extension

Renders a markdown file (default: the current session's `plan.md`) in a side panel and reads it aloud.

- Play / Pause / Stop, previous/next block, click any paragraph to start there
- Highlights the block being read; Space, Esc and arrow keys work as shortcuts
- Speed 0.5–2x, optional skipping of code blocks, auto-reload when the file changes
- Voices (English US/UK and Lithuanian only):
  - **Windows voices**, offline, built in, no setup needed
  - **Piper**, offline natural voices (Lessac US, Alba UK), needs `setup.ps1`
  - **Edge online voices**, natural (Lithuanian Ona/Leonas plus US/UK English), needs `setup.ps1`. The text is sent to Microsoft's read-aloud service.
- Agent actions: `load { path }`, `play`, `stop`

## Install

```powershell
git clone https://github.com/JeMasLT/copilot-plan-reader "$env:USERPROFILE\.copilot\extensions\plan-reader"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.copilot\extensions\plan-reader\setup.ps1"
```

Then restart the GitHub Copilot app and ask it to "open plan reader".

`setup.ps1` requires Python 3. It runs `pip install edge-tts piper-tts` and downloads the Piper voices (about 63 MB each) into `artifacts/piper-voices/`. That folder isn't committed to git. Without the setup, only Windows voices are available. Use `-SkipOnline` or `-SkipOffline` to install just one engine.

To add more offline voices, put any `.onnx` and `.onnx.json` pair from the [Piper voice catalog](https://huggingface.co/rhasspy/piper-voices) (en_US, en_GB or lt_LT) into `artifacts/piper-voices/`.

## Update

```powershell
git -C "$env:USERPROFILE\.copilot\extensions\plan-reader" pull
```
