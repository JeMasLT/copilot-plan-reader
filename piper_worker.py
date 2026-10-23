"""Persistent Piper worker for the plan-reader extension (offline neural voices).

Protocol: one JSON object per line on stdin:
  {"id": 1, "model": "<path to .onnx>", "text": "...", "out": "<path to .wav>"}
  (omit "out" to only pre-load the voice)
Replies one JSON line per request on stdout:
  {"id": 1, "ok": true} or {"id": 1, "ok": false, "error": "..."}

Lithuanian voices (lt_LT-*) need the voice author's phonemizer, which lives in
artifacts/piper-lt/ together with a "text"-type config for each voice. If that
config exists, the voice is driven through ReginuteSynth instead of plain Piper.
"""
import json
import os
import sys
import wave

try:
    from piper import PiperVoice
except ImportError:
    sys.stderr.write("piper-tts not installed")
    sys.exit(3)

HERE = os.path.dirname(os.path.abspath(__file__))
LT_DIR = os.path.join(HERE, "artifacts", "piper-lt")

voices = {}  # model path -> callable(text, out_path)
_lt = None


def lithuanian_tools():
    global _lt
    if _lt is None:
        sys.path.insert(0, LT_DIR)
        from phonemize_lithuanian import LithuanianPhonemizer
        from skaiciu_pletiklis import isplesk
        from synth_reginute import ReginuteSynth, i_int16
        _lt = (LithuanianPhonemizer(), isplesk, ReginuteSynth, i_int16)
    return _lt


def load(model):
    name = os.path.basename(model)[: -len(".onnx")]
    lt_config = os.path.join(LT_DIR, name + ".onnx.json")
    if name.startswith("lt_") and os.path.exists(lt_config):
        phonemizer, expand, ReginuteSynth, i_int16 = lithuanian_tools()
        voice = PiperVoice.load(model, config_path=lt_config)
        synth = ReginuteSynth(voice, phonemizer, length_scale=voice.config.length_scale, expand_text=expand)

        def speak(text, out):
            audio = synth.synthesize(text)
            with wave.open(out, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(synth.sr)
                w.writeframes(i_int16(audio))

        return speak

    voice = PiperVoice.load(model)

    def speak(text, out):
        with wave.open(out, "wb") as w:
            voice.synthesize_wav(text, w)

    return speak


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
        speak = voices.get(model)
        if speak is None:
            speak = voices[model] = load(model)
        if req.get("out"):
            tmp = req["out"] + ".part"
            speak(req["text"], tmp)
            os.replace(tmp, req["out"])
        reply = {"id": req.get("id"), "ok": True}
    except Exception as e:  # noqa: BLE001
        reply = {"id": req.get("id"), "ok": False, "error": str(e)[-300:]}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
