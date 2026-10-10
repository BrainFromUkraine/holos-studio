"""Project operations shared by the CLI and the local API.

Every long operation takes a `progress(stage, done, total, detail)` callback and saves the project
after it finishes, so a crash never loses earlier stages.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Iterable

from .project import Clip, CutEdit, Project, Source, natural_key, sha256_file

Progress = Callable[[str, int, int, str], None]

ANALYSIS_TYPES = ("gain", "pause", "fill")
SUGGEST_KINDS = {"retake", "repeat", "filler", "fragment", "sound", "unclear"}


def _noop(stage: str, done: int, total: int, detail: str) -> None:
    pass


def inspect_files(files: Iterable[str | Path], keep_order: bool = False) -> list[dict]:
    """Probe files before creating a project: order, format, duration and duplicates."""
    from .io import info
    paths = [Path(f) for f in files]
    ordered = paths if keep_order else sorted(paths, key=lambda f: natural_key(f.name))
    seen: dict[str, str] = {}
    out = []
    for f in ordered:
        h = sha256_file(f)
        sr, ch, dur = info(str(f))
        dup = seen.get(h)
        seen.setdefault(h, f.name)
        out.append({"path": str(f.resolve()), "name": f.name, "sha256": h, "sr": sr, "channels": ch,
                    "duration": round(dur, 3), "duplicate_of": dup})
    return out


def create_project(path: str | Path, files: Iterable[str | Path], name: str | None = None,
                   keep_order: bool = False) -> tuple[Project, list[dict]]:
    """New project from recordings. Returns the project and the skipped duplicates."""
    items = inspect_files(files, keep_order)
    p = Project(name=name or Path(path).stem)
    rates = set()
    skipped = []
    for it in items:
        if it["duplicate_of"]:
            skipped.append(it)
            continue
        rates.add(it["sr"])
        sid = f"s{len(p.sources) + 1}"
        p.sources.append(Source(id=sid, path=it["path"], sha256=it["sha256"], sr=it["sr"],
                                channels=it["channels"], duration=it["duration"]))
        p.timeline.append(Clip(source=sid, start=0.0, end=it["duration"]))
    if len(rates) > 1:
        raise ValueError(f"mixed sample rates {sorted(rates)} are not supported yet")
    p.sample_rate = rates.pop() if rates else 48000
    p.save(path)
    return p, skipped


def analyze_project(p: Project, path: str | Path, progress: Progress = _noop) -> dict:
    """Breaths, long pauses, drop-outs, loudness. Auto-applies the kinds listed in `p.auto_apply`."""
    from .analysis import analyze_source
    from .io import load_mono
    p.edits = [e for e in p.edits if e.type not in ANALYSIS_TYPES]
    n = len(p.sources)
    t0 = time.time()
    counts = {t: 0 for t in ANALYSIS_TYPES}
    for i, s in enumerate(p.sources):
        progress("analyze", i, n, Path(s.path).name)
        x, sr = load_mono(s.path)
        A, edits = analyze_source(x, sr, s.id, p.analysis_settings)
        for e in edits:
            counts[e.type] += 1
            if e.type in p.auto_apply:
                e.status = "accepted"
        p.analysis[s.id] = A
        p.edits.extend(edits)
    p.save(path)
    progress("analyze", n, n, "done")
    return {"seconds": round(time.time() - t0, 1), **counts}


def asr_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe_project(p: Project, path: str | Path, progress: Progress = _noop) -> dict:
    from .asr import transcribe_sources
    cache = Path(path).parent / f"{Path(path).stem}.holos-cache" / "asr"
    n = len(p.sources)
    t0 = time.time()
    done = {"i": 0}

    def log(msg: str) -> None:
        if msg.startswith("model "):
            progress("transcribe", done["i"], n, msg)
            return
        done["i"] += 1
        progress("transcribe", done["i"], n, msg)

    progress("transcribe", 0, n, "loading model")
    res = transcribe_sources([(s.id, s.path, s.sha256) for s in p.sources], p.asr, cache, log=log)
    for sid, (words, meta) in res.items():
        p.transcript[sid] = words
        p.transcript_meta[sid] = meta
    p.save(path)
    return {"seconds": round(time.time() - t0, 1), "words": sum(len(w) for w, _ in res.values())}


def suggest_project(p: Project, path: str | Path, use_audio: bool = True, progress: Progress = _noop) -> dict:
    """Transcript-based suggestions. Kinds in `p.auto_apply` are accepted, the rest become questions."""
    from .analysis.features import frame_features
    from .io import load_mono
    from .suggest import suggest
    cache: dict = {}

    def audio(sid):
        if sid not in cache:
            cache.clear()
            cache[sid] = load_mono(p.source(sid).path)
        return cache[sid]

    frames = {}
    n = len(p.sources)
    if use_audio:
        for i, s in enumerate(p.sources):
            progress("suggest", i, n, Path(s.path).name)
            frames[s.id] = frame_features(*audio(s.id))
    new = suggest(p, frames, audio=audio if use_audio else None)
    old = {(e.source, e.kind, round(e.start, 1), round(e.end, 1)): e.status
           for e in p.edits if isinstance(e, CutEdit) and e.kind in SUGGEST_KINDS}
    for e in new:
        key = (e.source, e.kind, round(e.start, 1), round(e.end, 1))
        e.status = old.get(key) or ("accepted" if e.kind in p.auto_apply else "suggested")
    p.edits = [e for e in p.edits if not (isinstance(e, CutEdit) and e.kind in SUGGEST_KINDS)] + new
    p.save(path)
    progress("suggest", n, n, "done")
    by: dict[str, int] = {}
    for e in new:
        by[e.kind] = by.get(e.kind, 0) + 1
    return {"total": len(new), "by_kind": by, "questions": sum(e.status == "suggested" for e in new)}


def process_project(path: str | Path, progress: Progress = _noop) -> dict:
    """Full automatic pass: analysis → transcription (if available) → suggestions."""
    p = Project.load(path)
    result = {"analyze": analyze_project(p, path, progress)}
    if asr_available():
        result["transcribe"] = transcribe_project(p, path, progress)
        result["suggest"] = suggest_project(p, path, True, progress)
    else:
        progress("transcribe", 0, 0, "skipped: speech recognition not installed (uv sync --extra asr)")
        result["transcribe"] = {"skipped": True}
    return result


def summary(p: Project) -> dict:
    """Everything the UI needs for the import / overview screens."""
    from .edit import program_time, timeline_map
    tm = timeline_map(p) if len(p.analysis) == len(p.sources) and p.sources else None
    sources = []
    for s in p.sources:
        A = p.analysis.get(s.id)
        sources.append({"id": s.id, "name": Path(s.path).name, "path": s.path, "duration": s.duration,
                        "sr": s.sr, "channels": s.channels,
                        "loudness_lufs": A.loudness_lufs if A else None,
                        "words": len(p.transcript.get(s.id, []))})
    counts: dict[str, dict[str, int]] = {}
    for e in p.edits:
        k = e.kind if isinstance(e, CutEdit) and e.kind else e.type
        counts.setdefault(k, {}).setdefault(e.status, 0)
        counts[k][e.status] += 1
    questions = []
    for e in p.edits:
        if isinstance(e, CutEdit) and e.status == "suggested":
            questions.append({"id": e.id, "kind": e.kind, "source": e.source, "start": e.start, "end": e.end,
                              "text": e.text, "before": e.before, "after": e.after, "reason": e.reason,
                              "episode_time": round(program_time(p, e.source, e.start, tm), 2) if tm else None})
    length = None
    if tm:
        last = p.timeline[-1].source
        start, a0, b0, rem = tm[last]
        length = round(start + (b0 - a0) - sum(ce - cs for cs, ce in rem) + p.timeline_settings.tail, 2)
    return {"name": p.name, "sample_rate": p.sample_rate, "sources": sources,
            "recorded_s": round(sum(s.duration for s in p.sources), 2), "edited_s": length,
            "analyzed": len(p.analysis), "transcribed": len(p.transcript),
            "counts": counts, "questions": sorted(questions, key=lambda q: q["episode_time"] or 0),
            "settings": {"language": p.asr.language, "glossary": p.asr.glossary, "model": p.asr.model,
                         "target_lufs": next((c.params.get("target_lufs") for c in p.chain if c.module == "loudness"), None),
                         "auto_apply": p.auto_apply}}
