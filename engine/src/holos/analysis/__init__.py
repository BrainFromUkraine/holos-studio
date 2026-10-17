"""Source analysis: speech span, room tone, breaths, long pauses, gate drop-outs.

Produces measurements (`SourceAnalysis`) and *suggested* edits. Nothing here
changes audio; applying edits happens in `holos.edit`.
"""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln

from ..project import AnalysisSettings, FillEdit, GainEdit, PauseEdit, SourceAnalysis
from .features import HOP, WIN, Frames, frame_features, runs, voicing

__all__ = ["analyze_source", "detect_breaths", "BREATH_VERSION"]

BREATH_VERSION = 2          # 2: quiet, non-periodic stretches (no VAD) - finds quick breaths between phrases
BREATH_BELOW_SPEECH = 22.0  # a breath is at least this far below the speech level (dB)
BREATH_MAX_VOICING = 0.45   # ...and not periodic (voice is)


def detect_breaths(rms: np.ndarray, voiced: np.ndarray, sid: str, on: float, off: float, sp_med: float,
                   room: float, settings: AnalysisSettings) -> list[GainEdit]:
    """Breaths: stretches of 60 ms - 1.5 s that are far below the speech level, above the room, and not periodic.

    Learned from marked examples: quick breaths between phrases are often inside what the voice detector calls
    speech, so it is not used here; periodicity tells voice from breath noise instead. Holes up to 30 ms are
    bridged only when they are just as quiet (holes up to 50 ms), and frames rising towards a word are
    trimmed off the edges, so a span never reaches into a word.
    """
    n = min(len(rms), len(voiced))
    rms, voiced = rms[:n], voiced[:n]
    top = sp_med - BREATH_BELOW_SPEECH
    # very quiet frames need no periodicity check: nothing 30 dB under the speech is a word worth keeping
    cand = (rms > room + 5) & (rms < top) & ((voiced < BREATH_MAX_VOICING) | (rms < sp_med - 30))
    c = cand.copy()
    for a, b in runs(~cand):
        if b - a <= 5 and a > 0 and b < n and (rms[a:b] < top).all():     # quiet but briefly periodic
            c[a:b] = True
    edits: list[GainEdit] = []
    for a, b in runs(c):
        while b - a > 2 and rms[b - 1] > top - 8:     # edge frames rising towards a word: leave them alone
            b -= 1
        while b - a > 2 and rms[a] > top - 8:
            a += 1
        s, e = a * HOP + WIN / 2 - HOP / 2, b * HOP + WIN / 2 - HOP / 2     # frame centres
        if not (0.06 <= e - s <= 1.5) or s < on - 0.6 or e > off + 0.6:
            continue
        peak = float(rms[a:b].max())
        if peak < room + 10:                          # just room noise
            continue
        edits.append(GainEdit(id=f"{sid}-b{len(edits) + 1}", source=sid, start=round(s, 3), end=round(e, 3),
                              db=settings.breath_db, reason=f"breath (peak {peak:.1f} dBFS)"))
    return edits


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

    # --- breaths: quiet, non-periodic stretches ---------------------------
    edits: list = detect_breaths(rms, voicing(x, sr), sid, on, off, sp_med, room, settings)
    breath_spans = [(int(e.start / HOP), int(np.ceil(e.end / HOP))) for e in edits]

    # --- pauses: every one from MIN_PAUSE is recorded; automation decides which get shortened ----
    from ..automation import MIN_PAUSE
    k = 0
    for a, b in runs(~speech):
        if a > a0 and b < b0 and (b - a) * HOP >= min(MIN_PAUSE, settings.pause_max):
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
