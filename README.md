# Plan Reader (TTS) — GitHub Copilot app canvas extension

Renders a markdown file (default: the current session's `plan.md`) in a side panel and reads it aloud.

- Play / Pause / Stop, previous/next block, click any paragraph to start there
- File picker listing every `.md` file in the session folder (recursive), plus your 15 most recently opened files. Relative `.md` links in the document open in the reader.
- **📂 Browse…** opens the Windows "Open file" dialog so you can load any markdown file on the PC.
- Highlights the block being read; Space, Esc and arrow keys work as shortcuts
- Speed 0.5–2x, optional skipping of code blocks, auto-reload when the file changes (cheap mtime check, no full re-download)
- Fast jumps: the first chunk of each block is short, the chunk you're waiting for is synthesized before queued prefetches, and stale prefetches are cancelled when you click elsewhere
- Voices (English US/UK and Lithuanian only):
  - **Windows voices**, offline, built in, no setup needed
  - **Piper**, offline natural voices: Lessac (US), Alba (UK), **Ingutė and Reginutė (Lithuanian)**. Needs `setup.ps1`.
  - **Edge online voices**, natural (Lithuanian Ona/Leonas plus US/UK English), needs `setup.ps1`. The text is sent to Microsoft's read-aloud service.
- Agent actions: `load { path }`, `list`, `play`, `stop`

## Install

```powershell
git clone https://github.com/JeMasLT/copilot-plan-reader "$env:USERPROFILE\.copilot\extensions\plan-reader"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.copilot\extensions\plan-reader\setup.ps1"
```

Then restart the GitHub Copilot app and ask it to "open plan reader".

`setup.ps1` requires Python 3. It runs `pip install edge-tts piper-tts` and downloads the four Piper voices (about 63 MB each) into `artifacts/piper-voices/`. That folder isn't committed to git. Without the setup, only Windows voices are available. Use `-SkipOnline` or `-SkipOffline` to install just one engine.

### Lithuanian offline voices

Piper 1.8.0 can't phonemize Lithuanian on its own, so `setup.ps1` also downloads the voice author's phonemizer and wrapper ([RobertasTa/lt_LT-ingute-medium](https://huggingface.co/RobertasTa/lt_LT-ingute-medium)) into `artifacts/piper-lt/`, and `piper_worker.py` runs Lithuanian voices through it. Credits and licences:

- Ingutė (`lt_LT-ingute-medium`), Robertas & Claude, grown from Reginutė. Voice licence: NewGenLTU Open RAIL-D 1.0 (`artifacts/piper-lt/LICENSE-VOICE-ingute`).
- Reginutė (`lt_LT-reginute1-medium`), trained on the LIEPA corpus of Vilnius University. CC BY 4.0.
- Phonemizer code: GPL-3.0 (`artifacts/piper-lt/LICENSE`).

If you publish audio made with these voices, disclose that it's machine-generated (required by Ingutė's licence).

To add more offline voices, put any `.onnx` and `.onnx.json` pair from the [Piper voice catalog](https://huggingface.co/rhasspy/piper-voices) (en_US, en_GB or lt_LT) into `artifacts/piper-voices/`.

## Update

```powershell
git -C "$env:USERPROFILE\.copilot\extensions\plan-reader" pull
```
