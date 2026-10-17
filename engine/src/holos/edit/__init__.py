"""Timeline assembly: apply accepted edits to sources and join clips into one program.

Per clip: level match → gain edits (breaths) → fill drop-outs with room tone →
cuts / pause shortening (equal-power crossfades). Clips are joined back to back: the silence at a
join comes from the recordings themselves and is as long as any other shortened pause (`join_pause`).
Returns the program signal plus a map of where every applied edit landed.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..io import load_mono
from ..project import CutEdit, FillEdit, GainEdit, PauseEdit, Project

LEAD_PAD = 0.02         # kept before the first word of a recording
TAIL_PAD = 0.08         # kept after the last word of the last recording (the episode tail follows)
JOIN_PAUSE_OFF = 0.7    # silence at a join between recordings when pause shortening is off


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


def join_pause(p: Project) -> float:
    """Silence between the last word of one recording and the first word of the next."""
    a = p.automation
    return max(0.0, a.pause_target) if a.pauses else JOIN_PAUSE_OFF


def edge_pads(p: Project) -> list[tuple[float, float]]:
    """(lead, tail) kept around the speech of every recording, in timeline order.

    Recordings are joined back to back with a crossfade, so the silence at a join is
    tail(i) + lead(i+1) - crossfade; both pads are chosen to make it `join_pause`. The silence is the
    recordings' own; when one of them has too little, the neighbour gives more.
    """
    xf = p.timeline_settings.crossfade
    need = join_pause(p) + xf
    room: list[tuple[float, float]] = []          # silence available before / after the speech
    for clip in p.timeline:
        A = p.analysis.get(clip.source)
        end = min(clip.end, p.source(clip.source).duration)
        if A is None:
            room.append((0.0, 0.0))
        else:
            room.append((max(0.0, A.speech_on - clip.start), max(0.0, end - A.speech_off)))
    pads = [[LEAD_PAD, TAIL_PAD] for _ in p.timeline]
    for i in range(len(pads) - 1):
        nxt_lead = min(LEAD_PAD, room[i + 1][0], need)
        tail = min(room[i][1], need - nxt_lead)
        pads[i][1] = max(0.0, tail)
        pads[i + 1][0] = max(0.0, min(room[i + 1][0], need - pads[i][1]))
    return [(a, b) for a, b in pads]


def process_source(p: Project, sid: str, fallback_room: list[np.ndarray] | None = None
                   ) -> tuple[np.ndarray, list[np.ndarray], float]:
    """One whole recording with everything that changes its sound but not its timing: level match, breath edits
    (lowered or replaced with room tone), drop-outs filled with room tone. Used by the renderer (before the cuts)
    and by the editor's "Result" playback, so both sound the same.

    Returns the signal (same length as the recording), its own room-tone pieces and the level-match gain (dB).
    `fallback_room`: room tone to use when this recording has none of its own.
    """
    sr = p.sample_rate
    ts = p.timeline_settings
    src = p.source(sid)
    A = p.analysis[sid]
    x, fsr = load_mono(src.path)
    if fsr != sr:
        raise ValueError(f"{src.path}: sample rate {fsr} != project {sr} (resampling not supported yet)")
    g_db = (ts.level_match_lufs - A.loudness_lufs) if p.automation.level_match else 0.0
    x = x * db2a(g_db)
    edits = p.edits_for(sid)

    # gain edits (breaths etc.)
    env = np.ones(len(x))
    for e in edits:
        if isinstance(e, GainEdit) and not e.room:
            a, b = int(e.start * sr), int(e.end * sr)
            if b > a:
                env[a:b] = np.minimum(env[a:b], _ramp_env(b - a, db2a(e.db), int(0.02 * sr)))
    x = x * env

    own = [x[int(s * sr):int(e * sr)].copy() for s, e in A.room_tone]
    rt_local = RoomTone(own or list(fallback_room or []), sr, ts.crossfade)

    # fill drop-outs with room tone
    if rt_local:
        for e in edits:
            if isinstance(e, FillEdit):
                a, b = int(e.start * sr), min(len(x), int(e.end * sr))
                if b <= a:
                    continue
                L = b - a
                x[a:b] += rt_local.take(L / sr + 0.01)[:L] * _fade_window(L, int(0.02 * sr))

    # breaths to remove: crossfade to room tone (15 ms ramps), the timing stays
    for e in edits:
        if isinstance(e, GainEdit) and e.room:
            a, b = int(e.start * sr), min(len(x), int(e.end * sr))
            if b <= a:
                continue
            L = b - a
            w = _fade_window(L, int(0.015 * sr))
            fill = rt_local.take(L / sr + 0.01)[:L] if rt_local else x[a:b] * db2a(e.db)
            x[a:b] = x[a:b] * (1 - w) + fill * w
    return x, own, g_db


def build_program(p: Project) -> Program:
    sr = p.sample_rate
    ts = p.timeline_settings
    xf = int(ts.crossfade * sr)
    prog = Program(audio=np.zeros(0), sr=sr)
    clips_audio: list[tuple[np.ndarray, list, float, str]] = []
    rt_pieces: list[np.ndarray] = []
    pads = edge_pads(p)

    for ci, clip in enumerate(p.timeline):
        x, own, g_db = process_source(p, clip.source, rt_pieces)
        rt_pieces.extend(own)
        prog.level_gain_db[clip.source] = round(g_db, 2)
        A = p.analysis[clip.source]
        edits = p.edits_for(clip.source)

        a0, b0, removals = clip_plan(clip, A, edits, ts.crossfade, len(x) / sr, *pads[ci])
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

    # join clips back to back (the pause at each join is the recordings' own silence, see edge_pads);
    # room tone only before the first and after the last one
    rt = RoomTone(rt_pieces, sr, ts.crossfade)
    out = rt.take(ts.lead_in)
    fade = int(0.015 * sr)
    for seg, emap, a0, sid in clips_audio:
        seg = seg.copy()
        seg[:fade] *= np.linspace(0, 1, fade)
        start = len(out) / sr - ts.crossfade
        out = crossjoin(out, seg, xf)
        prog.clip_starts.append((sid, round(start, 3)))
        for e, t in emap:
            prog.placements.append(Placement(e.id, e.type, sid, e.start, round(start + t, 3)))
    out = crossjoin(out, rt.take(ts.tail + 2 * ts.crossfade), xf)
    tail = int(min(0.8, ts.tail) * sr)
    out[-tail:] *= np.linspace(1, 0, tail) ** 2
    prog.audio = out
    return prog


def clip_plan(clip, A, edits, xf: float, dur: float, lead: float = LEAD_PAD,
              tail: float = TAIL_PAD) -> tuple[float, float, list[tuple[float, float]]]:
    """Kept range [a0, b0] of a source and the merged removals inside it (seconds).
    `lead` / `tail`: silence kept before the first and after the last word (see edge_pads)."""
    a0 = max(clip.start, A.speech_on - lead)
    b0 = min(clip.end, A.speech_off + tail, dur)
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
    pads = edge_pads(p)
    out, t = {}, ts.lead_in - ts.crossfade
    for i, clip in enumerate(p.timeline):
        A = p.analysis[clip.source]
        a0, b0, rem = clip_plan(clip, A, p.edits_for(clip.source), ts.crossfade, p.source(clip.source).duration,
                                *pads[i])
        start = t
        seg = (b0 - a0) - sum(ce - cs for cs, ce in rem) - ts.crossfade * len(rem)
        t = start + seg - ts.crossfade         # the next clip starts inside this one's crossfade
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
