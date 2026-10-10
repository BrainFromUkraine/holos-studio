"""Source analysis: speech span, room tone, breaths, long pauses, gate drop-outs.

Produces measurements (`SourceAnalysis`) and *suggested* edits. Nothing here
changes audio; applying edits happens in `holos.edit`.
"""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln

from ..project import AnalysisSettings, FillEdit, GainEdit, PauseEdit, SourceAnalysis
from .features import HOP, Frames, frame_features, runs

__all__ = ["analyze_source"]


def analyze_source(x: np.ndarray, sr: int, sid: str, settings: AnalysisSettings,
                   frames: Frames | None = None) -> tuple[SourceAnalysis, list]:
    F = frames or frame_features(x, sr)
    rms, speech, N = F.rms_db, F.speech, F.n
    if not speech.any():                       # music, tone, silence: keep the file whole, suggest nothing
        lufs = float(pyln.Meter(sr).integrated_loudness(x)) if len(x) > sr else -70.0
        dur = len(x) / sr
        return SourceAnalysis(speech_on=0.0, speech_off=round(dur, 3), speech_level_db=float(np.median(rms)) if N else -90.0,
                              room_db=float(np.percentile(rms, 10)) if N else -90.0,
                              loudness_lufs=round(lufs if np.isfinite(lufs) else -70.0, 2)), []
    sp_med = float(np.median(rms[speech]))
    nsl = rms[(~speech) & (rms > -82)]
    room = float(np.percentile(nsl, 20)) if len(nsl) else -75.0

    sr_runs = runs(speech)
    a0, b0 = sr_runs[0][0], sr_runs[-1][1]
    while a0 > 0 and rms[a0 - 1] > room + 6:           # true onset by level
        a0 -= 1
    while b0 < N - 1 and rms[b0] > room + 6:           # true offset by level
        b0 += 1
    on, off = a0 * HOP, b0 * HOP

    # --- breaths: non-speech, noise-like, well below speech ---------------
    cand = (~speech) & (rms > room + 8) & (rms < min(sp_med - 20, -44)) \
        & ((F.hi > 0.25) | (F.flat > 0.08)) & (F.lo < 0.6)
    c = cand.copy()
    for a, b in runs(~cand):                            # close holes <= 40 ms
        if b - a <= 4 and a > 0 and b < N:
            c[a:b] = True
    edits: list = []
    breath_spans = []
    for a, b in runs(c):
        if not (0.12 <= (b - a) * HOP <= 1.5) or a < a0 - 60 or b > b0 + 60:
            continue
        med = np.median(rms[a:b])
        while b - a > 8 and rms[b - 1] > med + 8:       # don't eat word onset
            b -= 1
        while b - a > 8 and rms[a] > med + 8:           # or word tail
            a += 1
        s, e = a * HOP, b * HOP + 0.02
        breath_spans.append((a, b))
        edits.append(GainEdit(id=f"{sid}-b{len(breath_spans)}", source=sid, start=round(s, 3), end=round(e, 3),
                              db=settings.breath_db, reason=f"breath (peak {rms[a:b].max():.1f} dBFS)"))

    # --- long pauses -------------------------------------------------------
    k = 0
    for a, b in runs(~speech):
        if a > a0 and b < b0 and (b - a) * HOP >= settings.pause_max:
            k += 1
            edits.append(PauseEdit(id=f"{sid}-p{k}", source=sid, start=round(a * HOP, 3), end=round(b * HOP, 3),
                                   target=settings.pause_target, reason=f"pause {(b - a) * HOP:.2f}s"))

    # --- room tone pieces (clean, non-breath) -----------------------------
    rt_mask = (~speech) & (rms > room - 4) & (rms < room + 5)
    for a, b in breath_spans:
        rt_mask[a:b + 3] = False
    room_tone = [(round(a * HOP, 3), round(b * HOP, 3)) for a, b in runs(rt_mask) if (b - a) * HOP >= 0.15]

    # --- gate drop-outs (far below room tone) ------------------------------
    k = 0
    for a, b in runs(rms < room - 6):
        if b - a >= 3 and a * HOP > on - 0.1 and b * HOP < off + 0.2:
            k += 1
            edits.append(FillEdit(id=f"{sid}-h{k}", source=sid, start=round(max(0.0, a * HOP - 0.01), 3),
                                  end=round(b * HOP + 0.04, 3), reason="gate drop-out"))

    span = x[int(on * sr):int(off * sr)]
    lufs = float(pyln.Meter(sr).integrated_loudness(span))
    A = SourceAnalysis(speech_on=round(on, 3), speech_off=round(off, 3), speech_level_db=round(sp_med, 2),
                       room_db=round(room, 2), loudness_lufs=round(lufs, 2), room_tone=room_tone)
    return A, edits
