"""Timeline assembly: apply accepted edits to sources and join clips into one program.

Per clip: level match → gain edits (breaths) → fill drop-outs with room tone →
cuts / pause shortening (equal-power crossfades). Clips are joined over room tone.
Returns the program signal plus a map of where every applied edit landed.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..io import load_mono
from ..project import CutEdit, FillEdit, GainEdit, PauseEdit, Project


def db2a(d: float) -> float:
    return 10 ** (d / 20)


def equal_power(n: int) -> tuple[np.ndarray, np.ndarray]:
    t = np.linspace(0, np.pi / 2, n)
    return np.sin(t), np.cos(t)


def crossjoin(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    """Concatenate with an n-sample equal-power crossfade (output shorter by n)."""
    n = min(n, len(a), len(b))
    if n == 0:
        return np.concatenate([a, b])
    fi, fo = equal_power(n)
    return np.concatenate([a[:-n], a[-n:] * fo + b[:n] * fi, b[n:]])


class RoomTone:
    """Loops captured room-tone pieces (with crossfades) to any length."""

    def __init__(self, pieces: list[np.ndarray], sr: int, xf: float):
        self.pieces = sorted([p for p in pieces if len(p) > 0.15 * sr], key=len, reverse=True)[:20]
        self.sr, self.n = sr, int(xf * sr)
        self._k = 0

    def __bool__(self) -> bool:
        return bool(self.pieces)

    def take(self, seconds: float) -> np.ndarray:
        need = int(seconds * self.sr)
        if not self.pieces:
            return np.zeros(need)
        out = self.pieces[self._k % len(self.pieces)]
        i = self._k + 1
        while len(out) < need + self.n:
            out = crossjoin(out, self.pieces[i % len(self.pieces)], self.n)
            i += 1
        self._k += 1
        return out[:need]


@dataclass
class Placement:
    edit_id: str
    type: str
    source: str
    src_start: float
    out_start: float


@dataclass
class Program:
    audio: np.ndarray
    sr: int
    clip_starts: list[tuple[str, float]] = field(default_factory=list)
    placements: list[Placement] = field(default_factory=list)
    level_gain_db: dict[str, float] = field(default_factory=dict)


def _ramp_env(n: int, gain: float, ramp: int) -> np.ndarray:
    seg = np.full(n, gain)
    r = max(1, min(ramp, n // 3))
    seg[:r] = np.linspace(1, gain, r)
    seg[-r:] = np.linspace(gain, 1, r)
    return seg


def build_program(p: Project) -> Program:
    sr = p.sample_rate
    ts = p.timeline_settings
    xf = int(ts.crossfade * sr)
    prog = Program(audio=np.zeros(0), sr=sr)
    clips_audio: list[tuple[np.ndarray, list, float, str]] = []
    rt_pieces: list[np.ndarray] = []

    for clip in p.timeline:
        src = p.source(clip.source)
        A = p.analysis[clip.source]
        x, fsr = load_mono(src.path)
        if fsr != sr:
            raise ValueError(f"{src.path}: sample rate {fsr} != project {sr} (resampling not supported yet)")
        g_db = ts.level_match_lufs - A.loudness_lufs
        prog.level_gain_db[clip.source] = round(g_db, 2)
        x = x * db2a(g_db)
        edits = p.edits_for(clip.source)

        # gain edits (breaths etc.)
        env = np.ones(len(x))
        for e in edits:
            if isinstance(e, GainEdit):
                a, b = int(e.start * sr), int(e.end * sr)
                if b > a:
                    env[a:b] = np.minimum(env[a:b], _ramp_env(b - a, db2a(e.db), int(0.02 * sr)))
        x = x * env

        own = [x[int(s * sr):int(e * sr)].copy() for s, e in A.room_tone]
        rt_pieces.extend(own)
        rt_local = RoomTone(own or rt_pieces, sr, ts.crossfade)

        # fill drop-outs with room tone
        if rt_local:
            for e in edits:
                if isinstance(e, FillEdit):
                    a, b = int(e.start * sr), min(len(x), int(e.end * sr))
                    if b <= a:
                        continue
                    L = b - a
                    x[a:b] += rt_local.take(L / sr + 0.01)[:L] * _fade_window(L, int(0.02 * sr))

        a0, b0, removals = clip_plan(clip, A, edits, ts.crossfade, len(x) / sr)
        pieces, cur = [], a0
        for cs, ce in removals:
            pieces.append(x[int(cur * sr):int(cs * sr)])
            cur = ce
        pieces.append(x[int(cur * sr):int(b0 * sr)])
        pieces = [pc for pc in pieces if len(pc)]
        seg = pieces[0] if pieces else np.zeros(int(0.05 * sr))
        for pc in pieces[1:]:
            seg = crossjoin(seg, pc, xf)

        def mapt(t: float, _a0=a0, _rem=removals) -> float:
            return map_time(t, _a0, _rem, ts.crossfade)

        clips_audio.append((seg, [(e, mapt(e.start)) for e in edits], a0, clip.source))

    # join clips over room tone
    rt = RoomTone(rt_pieces, sr, ts.crossfade)
    out = rt.take(ts.lead_in)
    fade = int(0.015 * sr)
    for i, (seg, emap, a0, sid) in enumerate(clips_audio):
        seg = seg.copy()
        seg[:fade] *= np.linspace(0, 1, fade)
        start = len(out) / sr - ts.crossfade
        out = crossjoin(out, seg, xf)
        prog.clip_starts.append((sid, round(start, 3)))
        for e, t in emap:
            prog.placements.append(Placement(e.id, e.type, sid, e.start, round(start + t, 3)))
        gap = ts.gap_between if i < len(clips_audio) - 1 else ts.tail
        out = crossjoin(out, rt.take(gap + 2 * ts.crossfade), xf)
    tail = int(min(0.8, ts.tail) * sr)
    out[-tail:] *= np.linspace(1, 0, tail) ** 2
    prog.audio = out
    return prog


def clip_plan(clip, A, edits, xf: float, dur: float) -> tuple[float, float, list[tuple[float, float]]]:
    """Kept range [a0, b0] of a source and the merged removals inside it (seconds)."""
    a0 = max(clip.start, A.speech_on - 0.02)
    b0 = min(clip.end, A.speech_off + 0.08, dur)
    rem: list[tuple[float, float]] = []
    for e in edits:
        if isinstance(e, PauseEdit):
            excess = (e.end - e.start) - e.target
            if excess > 0:
                mid = (e.start + e.end) / 2
                rem.append((mid - excess / 2, mid + excess / 2))
        elif isinstance(e, CutEdit):
            rem.append((e.start, e.end))
    merged: list[list[float]] = []
    for cs, ce in sorted(rem):
        cs, ce = max(cs, a0), min(ce, b0)
        if ce <= cs:
            continue
        if merged and cs <= merged[-1][1] + xf:
            merged[-1][1] = max(merged[-1][1], ce)
        else:
            merged.append([cs, ce])
    # a removal reaching the end of the kept range simply moves the end
    if merged and merged[-1][1] >= b0 - 1e-6:
        b0 = merged.pop()[0]
    if merged and merged[0][0] <= a0 + 1e-6:
        a0 = merged.pop(0)[1]
    return a0, b0, [(a, b) for a, b in merged]


def map_time(t: float, a0: float, removals: list[tuple[float, float]], xf: float) -> float:
    """Source time → time inside the assembled clip."""
    o = t - a0
    for cs, ce in removals:
        if t >= ce:
            o -= (ce - cs) + xf          # removed audio plus the crossfade overlap
        elif t > cs:
            o -= t - cs
    return o


def timeline_map(p: Project) -> dict[str, tuple[float, float, float, list]]:
    """Without loading audio: per source (clip start in program, a0, b0, removals)."""
    ts = p.timeline_settings
    out, t = {}, ts.lead_in - ts.crossfade
    for i, clip in enumerate(p.timeline):
        A = p.analysis[clip.source]
        a0, b0, rem = clip_plan(clip, A, p.edits_for(clip.source), ts.crossfade, p.source(clip.source).duration)
        start = t
        seg = (b0 - a0) - sum(ce - cs for cs, ce in rem) - ts.crossfade * len(rem)
        gap = ts.gap_between if i < len(p.timeline) - 1 else ts.tail
        t = start + seg + gap
        out[clip.source] = (start, a0, b0, rem)
    return out


def program_time(p: Project, sid: str, t: float, tmap=None) -> float:
    tmap = tmap or timeline_map(p)
    start, a0, b0, rem = tmap[sid]
    return start + map_time(min(max(t, a0), b0), a0, rem, p.timeline_settings.crossfade)


def _fade_window(n: int, r: int) -> np.ndarray:
    w = np.ones(n)
    r = max(1, min(r, n // 3))
    w[:r] = np.linspace(0, 1, r)
    w[-r:] = np.linspace(1, 0, r)
    return w
