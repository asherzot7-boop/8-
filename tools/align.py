"""Точные таймкоды слов из твоей озвучки (для субтитров).

    pip install openai-whisper
    python tools/align.py voice/demo.m4a          # создаст voice/demo.words.json

render.mjs подхватит *.words.json рядом с файлом голоса автоматически.
"""
import json
import sys
from pathlib import Path

import whisper


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("Использование: python tools/align.py <голос.m4a|mp3|wav> [модель: base|small|medium]")
    voice = Path(sys.argv[1])
    model = whisper.load_model(sys.argv[2] if len(sys.argv) > 2 else "small")
    result = model.transcribe(str(voice), language="ru", word_timestamps=True)
    words = [
        {"word": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3)}
        for seg in result["segments"]
        for w in seg.get("words", [])
    ]
    out = voice.with_suffix(".words.json")
    out.write_text(json.dumps(words, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(words)} слов → {out}")
    print("Распознано:", result["text"].strip())


if __name__ == "__main__":
    main()
