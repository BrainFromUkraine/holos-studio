"""Project operations shared by the CLI and the local API.

Every long operation takes a `progress(stage, done, total, detail)` callback and saves the project
after it finishes, so a crash never loses earlier stages.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Iterable

from . import automation
from .project import Clip, CutEdit, Project, Source, dump_json, natural_key, sha256_file

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


def project_file_path(path: str | Path) -> Path:
    """Where to write a new project, forgiving common mistakes from save dialogs.

    - an empty folder named like a project ("ep2.holos/", made by a dialog) is removed and used as the file name
    - any other existing folder gets "<folder>.holos" inside it
    - a missing ".holos" extension is added; the parent folder is created
    """
    p = Path(path).expanduser()
    if p.is_dir():
        if p.suffix.lower() == ".holos" and not any(p.iterdir()):
            p.rmdir()
        else:
            p = p / f"{p.name or 'episode'}.holos"
    if p.suffix.lower() != ".holos":
        p = p.with_name(p.name + ".holos")
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


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
    """Breaths, pauses, drop-outs, loudness. Which of them are applied is decided by `p.automation`."""
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
        p.analysis[s.id] = A
        p.edits.extend(edits)
    automation.apply(p)
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
    """Transcript-based edits (repeats, retakes, fillers…); `p.automation.kinds` decides which are cut."""
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
    old = {(e.source, e.kind, round(e.start, 1), round(e.end, 1)): e
           for e in p.edits if isinstance(e, CutEdit) and e.kind in SUGGEST_KINDS and e.touched}
    for e in new:                       # keep decisions the user made on the same suggestion earlier
        prev = old.get((e.source, e.kind, round(e.start, 1), round(e.end, 1)))
        if prev is not None:
            e.status, e.touched = prev.status, True
    p.edits = [e for e in p.edits if not (isinstance(e, CutEdit) and e.kind in SUGGEST_KINDS)] + new
    automation.apply(p)
    p.save(path)
    progress("suggest", n, n, "done")
    by: dict[str, int] = {}
    for e in new:
        by[e.kind] = by.get(e.kind, 0) + 1
    return {"total": len(new), "by_kind": by, "applied": sum(e.status == "accepted" for e in new)}


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
    result["view"] = prepare_view(p, path, progress)
    return result


def prepare_view(p: Project, path: str | Path, progress: Progress = _noop) -> dict:
    """Waveform, spectrogram and loudness for the editor, so it opens instantly."""
    from .view import prepare
    t0 = time.time()
    n = len(p.sources)
    for i, s in enumerate(p.sources):
        progress("view", i, n, Path(s.path).name)
        prepare(p, path, s.id)
    progress("view", n, n, "done")
    return {"seconds": round(time.time() - t0, 1)}


def summary(p: Project) -> dict:
    """Everything the UI needs for the import / overview screens."""
    from .chapters import check_youtube, episode_length, resolved
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
    length = round(episode_length(p), 2) if tm else None
    chapter_rows = resolved(p) if tm else []
    return {"name": p.name, "sample_rate": p.sample_rate, "sources": sources,
            "recorded_s": round(sum(s.duration for s in p.sources), 2), "edited_s": length,
            "analyzed": len(p.analysis), "transcribed": len(p.transcript),
            "counts": counts,
            "chapters": chapter_rows, "chapter_warnings": check_youtube(chapter_rows),
            "export": p.export.model_dump(),
            "settings": {"language": p.asr.language, "glossary": p.asr.glossary, "model": p.asr.model,
                         "target_lufs": next((c.params.get("target_lufs") for c in p.chain if c.module == "loudness"), None),
                         "automation": p.automation.model_dump()}}


# ---- export -------------------------------------------------------------------------------------
_BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(name: str) -> str:
    return _BAD_NAME.sub("_", name).strip(" .") or "episode"


def fingerprint(p: Project) -> str:
    """Hash of everything that changes the rendered audio (not chapters or export settings)."""
    data = p.model_dump(mode="json", exclude={"chapters", "export", "transcript_meta", "name"})
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


def cache_dir(path: str | Path) -> Path:
    path = Path(path)
    return path.parent / f"{path.stem}.holos-cache"


def master(p: Project, path: str | Path, progress: Progress = _noop) -> tuple[Path, dict]:
    """Mastered episode WAV, re-rendered only when the edits or the chain changed."""
    from .render import render
    d = cache_dir(path) / "render"
    wav, rep = d / "master.wav", d / "master_report.json"
    fp = fingerprint(p)
    if wav.is_file() and rep.is_file():
        report = json.loads(rep.read_text(encoding="utf-8"))
        if report.get("fingerprint") == fp:
            progress("render", 1, 1, "cached")
            return wav, report
    q = p.model_copy(deep=True)
    q.export.wav, q.export.mp3 = True, False
    progress("render", 0, 1, "timeline")
    report = render(q, d, "master", progress=lambda s: progress("render", 0, 1, s))
    report["fingerprint"] = fp
    dump_json(report, rep)
    progress("render", 1, 1, "done")
    return wav, report


def _run_ffmpeg(args: list[str]) -> None:
    from .io import FFmpegError, ffmpeg_path
    r = subprocess.run([ffmpeg_path(), "-v", "error", "-y", *args], capture_output=True)
    if r.returncode != 0:
        raise FFmpegError(r.stderr.decode(errors="replace")[-800:])


def export_project(path: str | Path, out_dir: str | Path | None = None, name: str | None = None,
                   wav: bool | None = None, mp3: bool | None = None, chapters_txt: bool | None = None,
                   chapters_embed: bool | None = None, video: dict | None = None, preview: float = 0,
                   progress: Progress = _noop) -> dict:
    """Render and write the deliverables: WAV, MP3, YouTube timecodes, video via a template.

    `video` = {"template": id, "params": {...}} or None. With `preview` > 0 only a short video is made.
    Settings given here are saved to the project as the new defaults.
    """
    from . import chapters as C
    from . import templates as T
    path = Path(path)
    p = Project.load(path)
    ex = p.export
    if wav is not None: ex.wav = wav
    if mp3 is not None: ex.mp3 = mp3
    if chapters_txt is not None: ex.chapters_txt = chapters_txt
    if chapters_embed is not None: ex.chapters_embed = chapters_embed
    if video is not None:
        ex.video.template = video.get("template") or None
        ex.video.params = video.get("params") or {}
    p.save(path)

    out = Path(out_dir) if out_dir else path.parent / "export"
    out.mkdir(parents=True, exist_ok=True)
    base = safe_name(name or p.name)
    t0 = time.time()

    tpl = None
    if ex.video.template:
        tpl = T.get(ex.video.template)
        T.build_args(tpl.manifest, ex.video.params)          # fail fast on bad parameters
        if tpl.missing:
            raise T.TemplateError(f"template '{tpl.manifest.name}' needs Python modules: {', '.join(tpl.missing)}"
                                  + (f" — install with: {tpl.manifest.install}" if tpl.manifest.install else ""))
    elif preview:
        raise ValueError("preview needs a video template")

    master_wav, report = master(p, path, progress)
    rows = C.resolved(p)
    warnings = C.check_youtube(rows) if rows else []
    meta = None
    if rows and ex.chapters_embed:
        meta = cache_dir(path) / "render" / "chapters.ffmeta"
        meta.write_text(C.ffmetadata(rows, p.name), encoding="utf-8")

    files: dict[str, str] = {}
    if not preview:
        if ex.wav:
            progress("wav", 0, 1, base + ".wav")
            shutil.copyfile(master_wav, out / f"{base}.wav")
            files["wav"] = str(out / f"{base}.wav")
        if ex.mp3:
            progress("mp3", 0, 1, base + ".mp3")
            target = out / f"{base}.mp3"
            args = ["-i", str(master_wav)]
            if meta:
                args += ["-i", str(meta), "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1"]
            else:
                args += ["-metadata", f"title={p.name}"]
            _run_ffmpeg(args + ["-c:a", "libmp3lame", "-b:a", f"{ex.mp3_kbps}k", "-id3v2_version", "3", str(target)])
            files["mp3"] = str(target)
        if ex.chapters_txt and rows:
            target = out / "timecodes.txt"
            target.write_text(C.youtube_text(rows), encoding="utf-8")
            files["timecodes"] = str(target)

    if tpl:
        suffix = "_preview" if preview else ""
        raw = cache_dir(path) / "render" / f"video_raw.{tpl.manifest.output}"
        raw.unlink(missing_ok=True)
        dur = preview or report.get("duration_s", 0)

        def vp(done: float, total: float, detail: str) -> None:
            if done >= 0:
                progress("video", int(done), int(total or dur), detail)
            else:
                progress("video", -1, int(dur), detail)

        progress("video", 0, int(dur), tpl.manifest.name)
        T.run(tpl, str(master_wav), str(raw), ex.video.params, preview, vp)
        target = out / f"{base}{suffix}.{tpl.manifest.output}"
        if tpl.manifest.remux_audio:
            progress("mux", 0, 1, target.name)
            args = ["-i", str(raw), "-i", str(master_wav)]
            if meta and not preview:
                args += ["-i", str(meta), "-map_metadata", "2", "-map_chapters", "2"]
            else:
                args += ["-metadata", f"title={p.name}"]
            args += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k"]
            if preview:
                args += ["-t", f"{preview:g}"]
            _run_ffmpeg(args + ["-shortest", "-movflags", "+faststart", str(target)])
            raw.unlink(missing_ok=True)
        else:
            shutil.move(str(raw), target)
        files["preview" if preview else "video"] = str(target)
        if not preview:
            T.remember(tpl.manifest.id, ex.video.params, str(path.resolve()))

    result = {"out_dir": str(out), "files": files, "chapters": rows, "warnings": warnings,
              "duration_s": report.get("duration_s"), "measured": report.get("measured", {}).get("wav"),
              "seconds": round(time.time() - t0, 1), "preview": bool(preview)}
    if not preview:
        dump_json({**result, "render": report}, out / f"{base}_report.json")
    progress("done", 1, 1, str(out))
    return result


def template_preview(path: str | Path, template: str, params: dict, seconds: float = 6.0,
                     progress: Progress = _noop) -> dict:
    """Short real render of a video template with the episode's audio, for the live preview.
    Cached by template + parameters + audio, so flipping back to a variant is instant."""
    from . import templates as T
    path = Path(path)
    p = Project.load(path)
    tpl = T.get(template)
    T.build_args(tpl.manifest, params)
    if tpl.missing:
        raise T.TemplateError(f"template '{tpl.manifest.name}' needs Python modules: {', '.join(tpl.missing)}"
                              + (f" — install with: {tpl.manifest.install}" if tpl.manifest.install else ""))
    key = hashlib.sha256(json.dumps([template, params, seconds, fingerprint(p)], sort_keys=True,
                                    default=str).encode()).hexdigest()[:16]
    d = cache_dir(path) / "previews"
    d.mkdir(parents=True, exist_ok=True)
    video, poster = d / f"{key}.mp4", d / f"{key}.jpg"
    if not (video.is_file() and poster.is_file()):
        master_wav, _ = master(p, path, progress)
        raw = d / f"{key}.raw.{tpl.manifest.output}"
        progress("preview", 0, int(seconds), tpl.manifest.name)
        T.run(tpl, str(master_wav), str(raw), params, seconds,
              lambda done, total, detail: progress("preview", max(0, int(done)), int(seconds), detail))
        _run_ffmpeg(["-i", str(raw), "-i", str(master_wav), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                     "-c:a", "aac", "-b:a", "192k", "-t", f"{seconds:g}", "-shortest", "-movflags", "+faststart",
                     str(video)])
        raw.unlink(missing_ok=True)
        _run_ffmpeg(["-ss", f"{min(seconds * 0.6, seconds - 0.5):.2f}", "-i", str(video), "-frames:v", "1",
                     "-vf", "scale=640:-2", "-q:v", "4", str(poster)])
    return {"video": str(video), "poster": str(poster), "key": key}
