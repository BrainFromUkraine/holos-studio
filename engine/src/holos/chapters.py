"""Chapters: anchored to a word in a source recording, so they follow the edits.

A chapter stores (source, source time). Its time in the finished episode is computed through the
same timeline mapping the renderer uses, so exported timecodes always match the rendered file.
"""
from __future__ import annotations

from dataclasses import dataclass

from .edit import map_time, timeline_map
from .project import Chapter, Project

YOUTUBE_MIN_CHAPTERS = 3
YOUTUBE_MIN_LENGTH = 10.0


@dataclass
class EpisodeWord:
    source: str
    index: int
    w: str
    src_start: float
    t: float                    # start in the finished episode (seconds)


def episode_words(p: Project) -> list[EpisodeWord]:
    """Transcript words that survive the edits, with their time in the finished episode."""
    tm = timeline_map(p)
    xf = p.timeline_settings.crossfade
    out: list[EpisodeWord] = []
    for clip in p.timeline:
        sid = clip.source
        if sid not in tm:
            continue
        start, a0, b0, rem = tm[sid]
        for i, w in enumerate(p.transcript.get(sid, [])):
            mid = (w.start + w.end) / 2
            if mid < a0 or mid > b0 or any(cs <= mid < ce for cs, ce in rem):
                continue
            out.append(EpisodeWord(sid, i, w.w, w.start, start + map_time(max(w.start, a0), a0, rem, xf)))
    return out


def episode_length(p: Project) -> float:
    tm = timeline_map(p)
    last = p.timeline[-1].source
    start, a0, b0, rem = tm[last]
    xf = p.timeline_settings.crossfade
    return start + (b0 - a0) - sum(ce - cs for cs, ce in rem) - xf * len(rem) + p.timeline_settings.tail


def chapter_time(p: Project, c: Chapter, tm=None) -> float:
    tm = tm or timeline_map(p)
    if c.source not in tm:
        return 0.0
    start, a0, b0, rem = tm[c.source]
    return max(0.0, start + map_time(min(max(c.at, a0), b0), a0, rem, p.timeline_settings.crossfade))


def anchor(p: Project, t: float, words: list[EpisodeWord] | None = None) -> tuple[str, float]:
    """Episode time → (source, source time), snapped to the start of the nearest kept word."""
    words = words if words is not None else episode_words(p)
    if words:
        w = min(words, key=lambda w: abs(w.t - t))
        return w.source, w.src_start
    tm = timeline_map(p)
    sid = p.timeline[0].source
    for clip in p.timeline:                       # no transcript: last clip starting before t
        if tm[clip.source][0] <= t:
            sid = clip.source
    start, a0, b0, rem = tm[sid]
    return sid, min(b0, a0 + max(0.0, t - start))


def set_chapters(p: Project, items: list[dict], origin: str = "user") -> list[Chapter]:
    """Replace chapters from [{"time": episode seconds, "title": str}]."""
    words = episode_words(p)
    chapters = []
    for it in sorted(items, key=lambda x: float(x["time"])):
        title = str(it["title"]).strip()
        if not title:
            continue
        sid, at = anchor(p, float(it["time"]), words)
        chapters.append(Chapter(source=sid, at=round(at, 3), title=title, origin=it.get("origin", origin)))
    p.chapters = chapters
    return chapters


def resolved(p: Project) -> list[dict]:
    """Chapters in episode time, sorted, first one forced to 0:00, with end times."""
    if not p.chapters or not p.analysis:
        return []
    tm = timeline_map(p)
    total = episode_length(p)
    rows = sorted(({"title": c.title, "time": chapter_time(p, c, tm), "origin": c.origin, "source": c.source,
                    "at": c.at} for c in p.chapters), key=lambda r: r["time"])
    rows[0]["time"] = 0.0
    for i, r in enumerate(rows):
        r["end"] = rows[i + 1]["time"] if i + 1 < len(rows) else total
        r["time"], r["end"] = round(r["time"], 2), round(r["end"], 2)
    return rows


def check_youtube(rows: list[dict]) -> list[str]:
    """Rules YouTube applies before it shows chapters on a video."""
    warn = []
    if rows and len(rows) < YOUTUBE_MIN_CHAPTERS:
        warn.append(f"YouTube shows chapters only when there are at least {YOUTUBE_MIN_CHAPTERS}")
    for r in rows:
        if r["end"] - r["time"] < YOUTUBE_MIN_LENGTH:
            warn.append(f"chapter '{r['title']}' is shorter than {YOUTUBE_MIN_LENGTH:.0f} s")
    return warn


def fmt_timecode(t: float, hours: bool) -> str:
    s = int(t)
    h, r = divmod(s, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if hours else f"{m:02d}:{s:02d}"


def youtube_text(rows: list[dict]) -> str:
    hours = bool(rows) and rows[-1]["end"] >= 3600
    return "".join(f"{fmt_timecode(r['time'], hours)} {r['title']}\n" for r in rows)


def _esc(s: str) -> str:
    for ch in ("\\", "=", ";", "#", "\n"):
        s = s.replace(ch, "\\" + ch)
    return s


def ffmetadata(rows: list[dict], title: str | None = None) -> str:
    """FFmpeg metadata file: chapters for MP4 (chpl/QuickTime) and MP3 (ID3 CHAP)."""
    out = [";FFMETADATA1"]
    if title:
        out.append(f"title={_esc(title)}")
    for r in rows:
        out += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(round(r['time'] * 1000))}",
                f"END={int(round(r['end'] * 1000))}", f"title={_esc(r['title'])}"]
    return "\n".join(out) + "\n"


def join_words(ws: list[str]) -> str:
    """Join Whisper words, gluing sub-word pieces: "ESP" "-32" → "ESP-32", "пам" "'яті" → "пам'яті"."""
    line: list[str] = []
    for w in ws:
        if line and (w[:1] in "-',.:;!?…)%" or line[-1][-1:] in "-'(") and w[:1] != "–":
            line[-1] += w
        else:
            line.append(w)
    return " ".join(line)


def transcript_text(p: Project, max_words: int = 40) -> str:
    """Kept transcript as sentences prefixed with episode timecodes — what an AI reads to propose chapters."""
    words = episode_words(p)
    if not words:
        return ""
    hours = episode_length(p) >= 3600
    lines, cur, t0 = [], [], 0.0
    for w in words:
        if not cur:
            t0 = w.t
        cur.append(w.w)
        if w.w.endswith((".", "?", "!", "…")) or len(cur) >= max_words:
            lines.append(f"[{fmt_timecode(t0, hours)}] {join_words(cur)}")
            cur = []
    if cur:
        lines.append(f"[{fmt_timecode(t0, hours)}] {join_words(cur)}")
    return "\n".join(lines)


__all__ = ["episode_words", "episode_length", "chapter_time", "anchor", "set_chapters", "resolved",
           "check_youtube", "youtube_text", "ffmetadata", "transcript_text", "join_words"]
