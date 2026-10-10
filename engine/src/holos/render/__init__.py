"""Render a project: timeline → processing chain → files → verification report."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np

from ..dsp import Context, run_chain
from ..edit import build_program
from ..io import ebur128, encode_mp3, write_wav
from ..project import Project, dump_json


def dropouts(x: np.ndarray, sr: int, below_db: float = -71.0, min_ms: int = 30, skip_tail_s: float = 1.2) -> list:
    """Short stretches far below room tone (audible holes)."""
    h = int(sr * 0.01)
    body = x[: max(0, len(x) - int(skip_tail_s * sr))]
    k = len(body) // h
    if k == 0:
        return []
    L = 10 * np.log10((body[: k * h].reshape(k, h) ** 2).mean(1) + 1e-14)
    out, start = [], None
    for i, low in enumerate(L < below_db):
        if low and start is None:
            start = i
        if not low and start is not None:
            if (i - start) * 10 >= min_ms:
                out.append({"t": round(start * 0.01, 2), "ms": (i - start) * 10, "min_db": round(float(L[start:i].min()), 1)})
            start = None
    return out


def render(p: Project, out_dir: str | Path, name: str = "render",
           progress: Callable[[str], None] | None = None) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    say = progress or (lambda s: None)

    say("timeline")
    prog = build_program(p)
    log: dict = {}
    ctx = Context(sr=p.sample_rate, channels=p.export.channels, log=log)
    y = run_chain(prog.audio, p.chain, ctx, progress=say)

    files = {}
    wav = out_dir / f"{name}.wav"
    say("export")
    write_wav(str(wav), y, p.sample_rate, p.export.wav_bits, p.export.channels)
    files["wav"] = str(wav)
    if p.export.mp3:
        mp3 = out_dir / f"{name}.mp3"
        encode_mp3(str(wav), str(mp3), p.export.mp3_kbps)
        files["mp3"] = str(mp3)

    say("verify")
    report = {
        "files": files,
        "duration_s": round(len(y) / p.sample_rate, 3),
        "measured": {k: ebur128(v) for k, v in files.items()},
        "dropouts": dropouts(y, p.sample_rate),
        "processing": log,
        "level_match_db": prog.level_gain_db,
        "clips": [{"source": s, "start": t} for s, t in prog.clip_starts],
        "edits_applied": [vars(pl) for pl in prog.placements],
    }
    if not p.export.wav:
        wav.unlink()
        files.pop("wav")
    dump_json(report, out_dir / f"{name}_report.json")
    return report
