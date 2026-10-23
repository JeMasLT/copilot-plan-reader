"""Persistent Piper worker for the plan-reader extension (offline neural voices).

Protocol: one JSON object per line on stdin:
  {"id": 1, "model": "<path to .onnx>", "text": "...", "out": "<path to .wav>"}
Replies one JSON line per request on stdout:
  {"id": 1, "ok": true} or {"id": 1, "ok": false, "error": "..."}
"""
import json
import sys
import wave

try:
    from piper import PiperVoice
except ImportError:
    sys.stderr.write("piper-tts not installed")
    sys.exit(3)

voices = {}

sys.stdout.write(json.dumps({"ready": True}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        model = req["model"]
        voice = voices.get(model)
        if voice is None:
            voice = voices[model] = PiperVoice.load(model)
        if not req.get("out"):
            reply = {"id": req.get("id"), "ok": True}  # warm-up only
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
            continue
        tmp = req["out"] + ".part"
        with wave.open(tmp, "wb") as wav:
            voice.synthesize_wav(req["text"], wav)
        import os
        os.replace(tmp, req["out"])
        reply = {"id": req.get("id"), "ok": True}
    except Exception as e:  # noqa: BLE001
        reply = {"id": req.get("id"), "ok": False, "error": str(e)[-300:]}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
