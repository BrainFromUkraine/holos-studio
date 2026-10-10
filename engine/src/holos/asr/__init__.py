"""Speech recognition with faster-whisper: word-level timestamps per source.

GPU: on Windows/Linux the CUDA 12 cuBLAS / cuDNN 9 libraries come from the
`nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheels (extra `gpu`); their DLL folders
are registered before CTranslate2 loads. Falls back to CPU int8 when no GPU.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Protocol

from ..project import AsrSettings, Word

# Fillers in the prompt nudge Whisper to transcribe disfluencies verbatim instead of cleaning them up.
FILLER_PROMPT_UK = "Ну, еее, тобто, ммм... як би це сказати, ну, ось. Е-е, а-а, хм."


def build_prompt(s: AsrSettings) -> str:
    parts = [FILLER_PROMPT_UK if s.language == "uk" else "Um, uh, like, you know... hmm."]
    if s.glossary:
        parts.append("Терміни: " + ", ".join(s.glossary) + ".")
    return " ".join(parts)


def register_nvidia_dlls() -> list[str]:
    """Make pip-installed NVIDIA runtime libraries visible to CTranslate2."""
    added = []
    try:
        import nvidia  # namespace package from nvidia-*-cu12 wheels
    except ImportError:
        return added
    for base in list(getattr(nvidia, "__path__", [])):
        for sub in Path(base).iterdir():
            for d in (sub / "bin", sub / "lib"):
                if d.is_dir():
                    if sys.platform == "win32":
                        os.add_dll_directory(str(d))
                        os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
                    else:
                        os.environ["LD_LIBRARY_PATH"] = str(d) + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")
                    added.append(str(d))
    return added


class Transcriber(Protocol):
    def __call__(self, path: str, settings: AsrSettings) -> tuple[list[Word], dict]: ...


@dataclass
class WhisperTranscriber:
    """Loads the model once and transcribes any number of files."""
    settings: AsrSettings
    log: Callable[[str], None] = lambda s: None

    def __post_init__(self):
        register_nvidia_dlls()
        import ctranslate2
        from faster_whisper import WhisperModel
        s = self.settings
        device = s.device
        if device == "auto":
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        compute = s.compute_type
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        t0 = time.time()
        self.model = WhisperModel(s.model, device=device, compute_type=compute)
        self.device, self.compute = device, compute
        self.log(f"model {s.model} on {device} ({compute}) loaded in {time.time() - t0:.0f}s")

    def __call__(self, path: str, settings: AsrSettings) -> tuple[list[Word], dict]:
        t0 = time.time()
        segments, info = self.model.transcribe(
            path, language=settings.language, word_timestamps=True, beam_size=settings.beam_size,
            initial_prompt=build_prompt(settings), condition_on_previous_text=False,
            vad_filter=False, temperature=0.0)
        words: list[Word] = []
        for seg in segments:
            for w in seg.words or []:
                words.append(Word(w=w.word.strip(), start=round(w.start, 3), end=round(w.end, 3),
                                  p=round(w.probability, 3)))
        meta = {"model": settings.model, "language": info.language, "device": self.device,
                "compute_type": self.compute, "audio_s": round(info.duration, 2),
                "seconds": round(time.time() - t0, 2)}
        return words, meta


def cache_key(sha256: str, s: AsrSettings) -> str:
    g = hashlib.sha256("|".join(s.glossary).encode()).hexdigest()[:8] if s.glossary else "0"
    return f"{sha256[:16]}-{s.model}-{s.language}-b{s.beam_size}-g{g}"


def transcribe_sources(items: Iterable[tuple[str, str, str]], settings: AsrSettings, cache_dir: Path,
                       transcriber_factory: Callable[[], Transcriber] | None = None,
                       log: Callable[[str], None] = lambda s: None) -> dict[str, tuple[list[Word], dict]]:
    """items: (source_id, path, sha256). Results are cached on disk per audio content + settings."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    out: dict[str, tuple[list[Word], dict]] = {}
    model: Transcriber | None = None
    for sid, path, sha in items:
        f = cache_dir / f"{cache_key(sha, settings)}.json"
        if f.exists():
            d = json.loads(f.read_text(encoding="utf-8"))
            out[sid] = ([Word(**w) for w in d["words"]], {**d["meta"], "cached": True})
            log(f"{Path(path).name}: cached ({len(d['words'])} words)")
            continue
        if model is None:
            model = transcriber_factory() if transcriber_factory else WhisperTranscriber(settings, log)
        words, meta = model(path, settings)
        f.write_text(json.dumps({"words": [w.model_dump() for w in words], "meta": meta}, ensure_ascii=False),
                     encoding="utf-8")
        rtf = meta["seconds"] / meta["audio_s"] if meta.get("audio_s") else 0
        log(f"{Path(path).name}: {len(words)} words, {meta['seconds']:.1f}s ({rtf:.2f}x realtime)")
        out[sid] = (words, meta)
    return out
