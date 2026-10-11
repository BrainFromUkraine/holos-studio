"""Edit suggestions from the transcript (+ audio): retakes, repeats, fillers, fragments.

Everything produced here is a *suggestion* (status "suggested"); the user decides.
Cut boundaries are snapped to the quietest point between words so cuts land in gaps.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable
from difflib import SequenceMatcher

import numpy as np

from ..analysis.features import HOP, Frames, runs
from ..project import CutEdit, Project, SourceAnalysis, Word

# "м" / "мм" are left out on purpose: in tech talk they are metres / millimetres
FILLERS = {"е", "ее", "еее", "ееее", "е-е", "е-е-е", "ем", "емм", "ммм", "мммм", "хм", "гм",
           "а-а", "а-а-а", "eh", "uh", "um", "hmm", "mm"}
_PUNCT = re.compile(r"[.,!?…:;«»\"()\[\]–—]+")
_APOS = re.compile(r"[’ʼ`´]")


PREFIX = {"retake": "t", "repeat": "r", "filler": "f", "fragment": "x", "unclear": "u", "sound": "g"}


def norm(w: str) -> str:
    w = _APOS.sub("'", w.lower()).strip()
    return _PUNCT.sub("", w).strip("-'")


_LAT = {"sh": "ш", "ch": "ч", "zh": "ж", "kh": "х", "ts": "ц", "ya": "я", "yu": "ю", "oo": "у", "ee": "і",
        "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "і", "j": "дж",
        "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р", "s": "с", "t": "т",
        "u": "у", "v": "в", "w": "в", "x": "кс", "y": "і", "z": "з"}
_UA_FOLD = str.maketrans({"и": "і", "ї": "і", "й": "і", "є": "е", "ґ": "г", "щ": "ш", "ь": None, "'": None, "-": None})


def sound_key(text: str) -> str:
    """Rough phonetic spelling so 'CrowdSupply' and 'крауд саплай' compare as similar."""
    t = norm(text).replace(" ", "")
    out, i = [], 0
    while i < len(t):
        if t[i:i + 2] in _LAT:
            out.append(_LAT[t[i:i + 2]]); i += 2
        else:
            out.append(_LAT.get(t[i], t[i])); i += 1
    return "".join(out).translate(_UA_FOLD)


def is_fragment(w: str) -> bool:
    return w.rstrip().endswith(("...", "…"))


@dataclass
class Snapper:
    """Moves a cut point to the quietest sustained spot near the word boundary.

    Whisper word times can be ~0.1-0.3 s off, so the search spans ±0.25 s around the
    nominal gap; a smoothed (50 ms) level plus a small distance penalty picks a real pause
    instead of a short consonant closure."""
    frames: Frames | None
    pad: float = 0.25
    penalty_db: float = 8.0      # per `pad` seconds away from the nominal gap

    def between(self, a: float, b: float) -> float:
        if b < a:
            a, b = b, a
        if self.frames is None:
            return round((a + b) / 2, 3)
        rms = self.frames.rms_db
        i, j = max(0, int((a - self.pad) / HOP)), min(self.frames.n, int((b + self.pad) / HOP) + 1)
        if j - i < 3:
            return round((a + b) / 2, 3)
        sm = np.convolve(rms[i:j], np.ones(5) / 5, mode="same")
        t = (np.arange(i, j) * HOP + 0.015)
        dist = np.maximum(0, np.maximum(a - t, t - b))
        k = int(np.argmin(sm + self.penalty_db * dist / self.pad))
        return round(float(t[k]), 3)


def _gap_before(words: list[Word], i: int) -> tuple[float, float]:
    return (words[i - 1].end if i > 0 else max(0.0, words[i].start - 0.3), words[i].start)


def _context(words: list[Word], i: int, j: int, n: int = 6) -> tuple[str, str, str]:
    t = lambda ws: " ".join(w.w for w in ws)
    return t(words[max(0, i - n):i]), t(words[i:j]), t(words[j:j + n])


def find_repeats(words: list[Word], min_len: int = 3, window: int = 60) -> list[tuple[int, int, int]]:
    """(i, j, k): words[i:j] is an abandoned attempt restarted at j (k matching words)."""
    T = [norm(w.w) for w in words]
    n, out, j = len(T), [], 1
    while j < n:
        best = None
        for i in range(max(0, j - window), j):
            k = 0
            while j + k < n and i + k < j and T[i + k] and T[i + k] == T[j + k]:
                k += 1
            # a real restart repeats right after the abandoned attempt (maybe with a broken-off word);
            # parallel phrases with new content between them ("Pi 4 на 2 гігабайти …, Pi 5 на 2 гігабайти") are normal speech
            extra = j - i - k                       # words between the end of the match and the restart
            broken = any(is_fragment(words[q].w) for q in range(i + k, j))
            ok = (k >= 5 and extra <= k) or (k >= min_len and (extra <= 3 or (broken and extra <= 6)))
            if ok and any(len(T[i + q]) > 3 for q in range(k)):
                if best is None or k > best[2] or (k == best[2] and i < best[0]):
                    best = (i, j, k)
        if best:
            out.append(best)
            j = best[1] + best[2]
        else:
            j += 1
    return out


def find_retake(prev: list[Word], nxt: list[Word], head: int = 8, min_match: int = 3,
                look_back: int = 120) -> tuple[int, int] | None:
    """Start index in `prev` whose tail is redone at the start of `nxt`, and matched-word count."""
    if not prev or not nxt:
        return None
    A = [norm(w.w) for w in prev]
    B = [norm(w.w) for w in nxt[:head]]
    best = None
    for i in range(max(0, len(A) - look_back), len(A)):
        seg = A[i:i + len(B)]
        if len(seg) < min_match:
            continue
        sm = SequenceMatcher(a=seg, b=B, autojunk=False)
        m = sum(b.size for b in sm.get_matching_blocks())
        first = sm.get_matching_blocks()[0]
        # the retake starts where the next file starts; an extra leading word is allowed only on both sides
        # ("І на …" / "А на …"), never only on this side ("світі. Це був …" / "Це був …")
        starts_together = first.b <= 1 and first.a <= first.b
        # words can be spelled differently between takes (Latin vs Cyrillic) — compare by sound too
        ka, kb = sound_key(" ".join(prev[q].w for q in range(i, min(len(prev), i + len(B))))), \
            sound_key(" ".join(w.w for w in nxt[:head]))
        L = min(len(ka), len(kb))
        char_ratio = SequenceMatcher(a=ka[:L], b=kb[:L], autojunk=False).ratio() if L >= 12 else 0.0
        if m >= min_match and starts_together and (sm.ratio() >= 0.45 or char_ratio >= 0.55):
            if best is None or m > best[1]:
                best = (i, m)
    return best


def spectral_flux(x: np.ndarray, sr: int, a: float, b: float) -> float:
    """Median frame-to-frame change of the log spectrum (200 Hz-4 kHz).
    A held 'еее' / 'ммм' is spectrally steady; real words change constantly."""
    seg = x[int(a * sr):int(b * sr)]
    win, hop = int(0.03 * sr), int(0.01 * sr)
    n = (len(seg) - win) // hop
    if n < 3:
        return float("nan")
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    S = np.abs(np.fft.rfft(seg[idx] * np.hanning(win), axis=1))
    f = np.fft.rfftfreq(win, 1 / sr)
    L = np.log(S[:, (f > 200) & (f < 4000)] + 1e-9)
    L -= L.mean(1, keepdims=True)
    return float(np.median(np.sqrt(((L[1:] - L[:-1]) ** 2).mean(1))))


def word_flux_floor(words: list[Word], x: np.ndarray, sr: int, pct: float = 5.0) -> float:
    vals = [spectral_flux(x, sr, w.start, w.end) for w in words if w.end - w.start > 0.2][:200]
    vals = [v for v in vals if v == v]
    return float(np.percentile(vals, pct)) if len(vals) >= 20 else 0.62


def find_filler_gaps(words: list[Word], F: Frames, A: SourceAnalysis,
                     min_s: float = 0.2, max_s: float = 1.2) -> list[tuple[float, float]]:
    """Voiced, non-transcribed stretches: candidates for 'еее', 'ммм' that Whisper left out."""
    covered = np.zeros(F.n, bool)
    for w in words:
        covered[max(0, int((w.start - 0.04) / HOP)):int((w.end + 0.04) / HOP) + 1] = True
    voiced = F.speech & (F.rms_db > A.room_db + 18) & (F.flat < 0.06) & (F.lo > 0.2) & ~covered
    on, off = int(A.speech_on / HOP), int(A.speech_off / HOP)
    v = voiced.copy()
    for a, b in runs(~voiced):                      # merge pieces split by < 150 ms
        if b - a < 15 and a > 0 and b < F.n:
            v[a:b] = True
    out = []
    for a, b in runs(v):
        if a < on or b > off:
            continue
        d = (b - a) * HOP
        if min_s <= d <= max_s:
            out.append((round(a * HOP, 3), round(b * HOP, 3)))
    return out


def suggest(p: Project, frames: dict[str, Frames] | None = None,
            audio: Callable[[str], tuple[np.ndarray, int]] | None = None) -> list[CutEdit]:
    """All transcript-based suggestions for a project (replace previous ones).
    `frames` / `audio` enable the audio-based filler search; without them only the transcript is used."""
    frames = frames or {}
    edits: list[CutEdit] = []
    order = [c.source for c in p.timeline]
    for idx, sid in enumerate(order):
        W = p.transcript.get(sid) or []
        if not W:
            continue
        S = Snapper(frames.get(sid))
        dur = p.source(sid).duration
        k = 0

        def add(kind: str, start: float, end: float, i: int, j: int, reason: str):
            nonlocal k
            k += 1
            before, cut, after = _context(W, i, j)
            edits.append(CutEdit(id=f"{sid}-{PREFIX[kind]}{k}", source=sid, start=round(start, 3), end=round(end, 3),
                                 kind=kind, text=cut, before=before, after=after, reason=reason))

        # 1) retake across files: tail of this file is redone at the start of the next one
        if idx + 1 < len(order):
            nxt = p.transcript.get(order[idx + 1]) or []
            r = find_retake(W, nxt)
            if r:
                i, m = r
                start = S.between(*_gap_before(W, i))
                add("retake", start, dur, i, len(W),
                    f"redone at the start of the next file ({m} matching words)")

        # 2) repeats / false starts inside the file
        taken = [(e.start, e.end) for e in edits if e.source == sid]
        for i, j, m in find_repeats(W):
            start = S.between(*_gap_before(W, i))
            end = S.between(*_gap_before(W, j))
            if any(a <= start < b for a, b in taken):
                continue
            add("repeat", start, end, i, j, f"restarted: {m} words repeat")
            taken.append((start, end))

        # 3) fillers the model did transcribe, and broken-off words
        for i, w in enumerate(W):
            nw = norm(w.w)
            if any(a <= w.start < b for a, b in taken):
                continue
            if nw in FILLERS or is_fragment(w.w):
                start = S.between(*_gap_before(W, i))
                end = S.between(w.end, W[i + 1].start) if i + 1 < len(W) else w.end + 0.05
                kind = "filler" if nw in FILLERS else "fragment"
                add(kind, start, end, i, i + 1, "filler word" if kind == "filler" else "broken-off word")

        # 4) unclear speech: several low-confidence words in a row — worth a listen
        run: list[int] = []
        for i in range(len(W) + 1):
            if i < len(W) and W[i].p < 0.8:
                run.append(i)
                continue
            if len(run) >= 3 and float(np.mean([W[q].p for q in run])) < 0.72:
                a, b = run[0], run[-1] + 1
                if not any(lo <= W[a].start < hi for lo, hi in taken):
                    start = S.between(*_gap_before(W, a))
                    end = S.between(W[b - 1].end, W[b].start) if b < len(W) else min(dur, W[b - 1].end + 0.1)
                    add("unclear", start, end, a, b, "low recognition confidence — listen before deciding")
            run = []

        # 5) voiced gaps without words (audio-based)
        F = frames.get(sid)
        if F is not None and audio is not None and sid in p.analysis:
            gaps = find_filler_gaps(W, F, p.analysis[sid])
            if not gaps:
                continue
            x, sr = audio(sid)
            floor = word_flux_floor(W, x, sr) * 0.95
            for a, b in gaps:
                if any(lo <= a < hi for lo, hi in taken) or not spectral_flux(x, sr, a, b) < floor:
                    continue
                i = next((q for q, w in enumerate(W) if w.start >= b), len(W))
                k += 1
                before, _, after = _context(W, i, i)
                edits.append(CutEdit(id=f"{sid}-g{k}", source=sid, start=round(a - 0.02, 3), end=round(b + 0.02, 3),
                                     kind="sound", text="(sound without words)", before=before, after=after,
                                     reason="voiced sound with no transcribed word — possible 'еее'"))
    return edits
