"""Processed recordings for the editor's "Result" playback.

The editor plays each recording itself and jumps over the removed parts, so a manual cut or restore is heard at
once. For "Result" it plays a processed copy of every recording, made the same way as the export: the recording's
own processing (`edit.process_source`: level match, breaths, drop-outs), then the voice chain (mouth clicks, low cut,
de-click, EQ, de-esser, compressor) and the loudness gain. The copy has the recording's exact length, so the editor's
timing is unchanged.

Each copy is cached in `<project>.holos-cache/preview/` under a key of everything that changes its sound; changing a
breath in one recording re-makes only that recording.
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Callable

import numpy as np

from .project import FillEdit, GainEdit, Project

PREVIEW_VERSION = 2
CEILING_DB = -1.0
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def preview_dir(path: str | Path) -> Path:
    path = Path(path)
    d = path.parent / f"{path.stem}.holos-cache" / "preview"
    d.mkdir(parents=True, exist_ok=True)
    return d


def preview_key(p: Project, sid: str) -> str:
    """Hash of everything that changes the processed copy of one recording."""
    from .ops import RENDER_VERSION
    s = p.source(sid)
    A = p.analysis.get(sid)
    edits = [e.model_dump(mode="json", exclude={"reason", "touched"}) for e in p.edits_for(sid)
             if isinstance(e, (GainEdit, FillEdit))]
    data = {"v": PREVIEW_VERSION, "render": RENDER_VERSION, "sha": s.sha256, "sr": p.sample_rate,
            "level_match": p.automation.level_match, "lufs": p.timeline_settings.level_match_lufs,
            "crossfade": p.timeline_settings.crossfade,
            "analysis": A.model_dump(mode="json") if A else None, "edits": edits,
            "chain": [c.model_dump(mode="json") for c in p.chain]}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


def preview_file(path: str | Path, p: Project, sid: str) -> Path:
    return preview_dir(path) / f"{sid}_{preview_key(p, sid)}.wav"


def is_ready(path: str | Path, p: Project, sid: str) -> bool:
    return sid in p.analysis and preview_file(path, p, sid).is_file()


def _lock(f: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(f), threading.Lock())


def ensure(p: Project, path: str | Path, sid: str) -> Path:
    """The processed copy of recording `sid`, made now if it is missing or out of date."""
    import soundfile as sf
    from .dsp import Context, run_chain
    from .edit import process_source
    f = preview_file(path, p, sid)
    with _lock(f):
        if f.is_file():
            return f
        x, _, _ = process_source(p, sid, _any_room_tone(p, sid))
        chain = [c for c in p.chain if c.module != "loudness"]
        y = run_chain(x, chain, Context(sr=p.sample_rate, channels=1))
        target = next((c.params.get("target_lufs") for c in p.chain if c.module == "loudness" and c.enabled), None)
        if target is not None:
            y = y * 10 ** (_loudness_gain(p, sid, y, float(target)) / 20)
        ceil = 10 ** (CEILING_DB / 20)
        over = np.abs(y) > ceil
        if over.any():                                   # soft ceiling instead of the export's limiter
            y = np.where(over, np.sign(y) * (ceil + (1 - ceil) * np.tanh((np.abs(y) - ceil) / (1 - ceil))), y)
        tmp = f.with_suffix(".part.wav")
        sf.write(tmp, y.astype(np.float32), p.sample_rate, subtype="FLOAT")
        tmp.replace(f)
        for old in preview_dir(path).glob(f"{sid}_*.wav"):   # older versions of this recording
            if old != f:
                try:
                    old.unlink()
                except OSError:
                    pass
        return f


def _loudness_gain(p: Project, sid: str, y: np.ndarray, target: float) -> float:
    """Gain (dB) that brings this recording's speech to the export's loudness target. The copy is mono and the player
    sends it to both speakers, which a loudness meter counts 3 dB louder. Recordings are level-matched already, so
    this stays close to one gain for all, like the export's single loudness step."""
    import pyloudnorm as pyln
    A = p.analysis[sid]
    sr = p.sample_rate
    seg = y[int(A.speech_on * sr):int(A.speech_off * sr)]
    nominal = target - p.timeline_settings.level_match_lufs
    if len(seg) < sr:
        return nominal
    lu = float(pyln.Meter(sr).integrated_loudness(seg))
    if not np.isfinite(lu):
        return nominal
    return float(np.clip(target - 3.01 - lu, nominal - 6, nominal + 6))


def _any_room_tone(p: Project, sid: str) -> list[np.ndarray]:
    """Room tone from another recording, for a recording that has none of its own (rare)."""
    A = p.analysis.get(sid)
    if A is None or A.room_tone:
        return []
    from .io import load_mono
    for s in p.sources:
        B = p.analysis.get(s.id)
        if s.id != sid and B and B.room_tone:
            x, sr = load_mono(s.path)
            return [x[int(a * sr):int(b * sr)].copy() for a, b in B.room_tone]
    return []


def prepare(p: Project, path: str | Path, progress: Callable[[str, int, int, str], None] | None = None) -> int:
    """Make every missing processed copy. Returns how many were made."""
    todo = [s for s in p.sources if s.id in p.analysis and not is_ready(path, p, s.id)]
    for i, s in enumerate(todo):
        if progress:
            progress("preview", i, len(todo), Path(s.path).name)
        ensure(p, path, s.id)
    if progress:
        progress("preview", len(todo), len(todo), "done")
    return len(todo)
