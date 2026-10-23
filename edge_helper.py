"""Helper for the plan-reader extension: Edge online neural voices via edge-tts.

Usage:
  python edge_helper.py check
  python edge_helper.py voices
  python edge_helper.py speak <voice> <rate e.g. +10%> <outfile>   (text on stdin, UTF-8)
"""
import asyncio
import json
import sys


async def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    import edge_tts  # noqa: raises ImportError if missing

    if cmd == "check":
        print(json.dumps({"ok": True}))
    elif cmd == "voices":
        voices = await edge_tts.list_voices()
        out = [
            {
                "name": v.get("ShortName"),
                "locale": v.get("Locale"),
                "gender": v.get("Gender"),
                "friendly": v.get("FriendlyName"),
            }
            for v in voices
        ]
        sys.stdout.write(json.dumps(out))
    elif cmd == "speak":
        voice, rate, outfile = sys.argv[2], sys.argv[3], sys.argv[4]
        text = sys.stdin.buffer.read().decode("utf-8")
        await edge_tts.Communicate(text, voice, rate=rate).save(outfile)
        print(json.dumps({"ok": True}))
    else:
        raise SystemExit("unknown command")


try:
    asyncio.run(main())
except ImportError:
    sys.stderr.write("edge-tts not installed")
    sys.exit(3)
