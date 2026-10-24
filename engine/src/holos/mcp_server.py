"""MCP server: Claude (or another MCP client) works in Holos Studio —
open projects, read the episode, cut and restore, adjust automation, set chapters and export.

Run by the MCP client over stdio:  holos mcp   (or: uv --directory <repo>/engine run holos mcp)
Every change goes through the same history as the app, so the user can undo anything Claude did.
Times are in the FINISHED episode ("MM:SS", "H:MM:SS" or seconds) — the same clock the user sees.
"""
from __future__ import annotations

import re
import threading
import time
import uuid
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from . import chapters as C
from . import editing, ops
from . import templates as T
from .project import Project

mcp = MCPServer(
    "holos-studio",
    title="Holos Studio",
    instructions=(
        "Holos Studio is a podcast editor; episodes are .holos project files. Start with list_projects. "
        "All times are positions in the FINISHED episode (after cuts), as 'MM:SS(.s)' or seconds — use "
        "get_transcript to see what is said where. The program has already cut repeats, retakes, long pauses and "
        "mouth clicks automatically (list_splices shows every cut). Cuts are non-destructive: restore brings audio "
        "back, undo reverts the last change (shared with the user's own history). "
        "Chapters: read get_transcript, choose topic boundaries, call set_chapters — short titles (2–6 words) in "
        "the episode's language; YouTube needs the first at 00:00, at least 3, each ≥ 10 s. "
        "Thumbnail: get_thumbnail / set_thumbnail (picture, size, episode number, badge), made by export. "
        "Long work (new_episode, export) runs as a job: poll job_status."
    ),
)

RO = ToolAnnotations(readOnlyHint=True)
RW = ToolAnnotations(readOnlyHint=False, destructiveHint=False)

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _seen() -> None:
    """Let the app show "Claude connected" (written at most once a minute)."""
    now = time.time()

    def fn(st: dict):
        if now - (st.get("mcp_last_seen") or 0) < 60:
            return False
        st["mcp_last_seen"] = now

    T.update_state(fn)


def _load(path: str) -> Project:
    _seen()
    if not Path(path).is_file():
        raise ValueError(f"project not found: {path} — call list_projects")
    from . import ops
    p = Project.load(path)
    ops.refresh_breaths(p, path)               # projects analysed by an older breath detector
    return p


def parse_time(v: str | float | int) -> float:
    """Seconds from 75, "75.5", "01:15", "1:01:15"."""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    parts = s.split(":")
    if not 2 <= len(parts) <= 3 or not all(re.fullmatch(r"\d+(\.\d+)?", x) for x in parts):
        raise ValueError(f"bad time {v!r}: use seconds or MM:SS / H:MM:SS")
    sec = 0.0
    for x in parts:
        sec = sec * 60 + float(x)
    return sec


def _tc(t: float | None) -> str | None:
    if t is None:
        return None
    m, s = divmod(max(0.0, t), 60)
    h, m = divmod(int(m), 60)
    return f"{h}:{m:02d}:{s:04.1f}" if h else f"{m:02d}:{s:04.1f}"


def _start_job(kind: str, fn) -> dict:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "state": "running", "stage": "", "progress": "", "result": None, "error": None,
           "started": time.time()}
    _jobs[jid] = job

    def progress(stage: str, done: int, total: int, detail: str) -> None:
        job["stage"], job["progress"] = stage, f"{done}/{total} {detail}".strip()

    def work() -> None:
        try:
            job["result"] = fn(progress)
            job["state"] = "done"
        except Exception as e:  # reported to Claude as-is
            job["state"], job["error"] = "error", f"{type(e).__name__}: {e}"

    threading.Thread(target=work, daemon=True).start()
    return {"job_id": jid, "state": "running"}


# ---- projects -------------------------------------------------------------------------------------
@mcp.tool(annotations=RO)
def list_projects() -> list[dict]:
    """Projects in the Holos Studio projects folder and recently opened ones, newest first."""
    from . import projects as P
    _seen()
    return [{"path": r["path"], "name": r["name"], "length": _tc(r["length"]), "files": r["files"],
             "status": r["status"], "chapters": r["chapters"]} for r in P.list_projects()]


@mcp.tool(annotations=RW)
def new_episode(name: str, files: list[str]) -> dict:
    """Create a project from recordings (absolute paths, any order — sorted by file name), copy them into the
    project folder and run the full automatic pass (analysis, speech recognition, cuts). Returns a job id."""
    from . import projects as P
    _seen()
    missing = [f for f in files if not Path(f).is_file()]
    if missing:
        raise ValueError(f"not found: {missing[:3]}")
    return _start_job("new_episode", lambda progress: P.new_episode(name, files, progress=progress))


@mcp.tool(annotations=RO)
def job_status(job_id: str) -> dict:
    """State of a job started by new_episode or export: running | done | error, progress and result."""
    j = _jobs.get(job_id)
    if not j:
        raise ValueError("unknown job id")
    return {k: v for k, v in j.items() if k != "started"} | {"elapsed_s": round(time.time() - j["started"], 1)}


@mcp.tool(annotations=RO)
def get_episode(path: str) -> dict:
    """Overview: length before/after editing, what was cut automatically, automation settings, chapters."""
    p = _load(path)
    s = ops.summary(p)
    applied = {k: v.get("accepted", 0) for k, v in s["counts"].items()}
    return {"name": s["name"], "recorded": _tc(s["recorded_s"]), "length": _tc(s["edited_s"]),
            "recordings": len(s["sources"]), "words": sum(x["words"] for x in s["sources"]),
            "applied_edits": applied, "automation": p.automation.model_dump(),
            "chapters": [{"time": _tc(r["time"]), "title": r["title"]} for r in C.resolved(p)],
            "can_undo": editing.history_state(path)["can_undo"]}


@mcp.tool(annotations=RO)
def get_transcript(path: str, start: str | float | None = None, end: str | float | None = None) -> str:
    """Transcript of the finished episode, one sentence per line, each with its [MM:SS] time in the finished
    episode. Optional start/end limit it to a part of the episode."""
    p = _load(path)
    text = C.transcript_text(p)
    if not text:
        raise ValueError("no transcript yet — the project must be processed first")
    if start is None and end is None:
        return text
    a = parse_time(start) if start is not None else 0.0
    b = parse_time(end) if end is not None else 1e9
    out = []
    for line in text.splitlines():
        m = re.match(r"\[(\d+(?::\d+){1,2})\]", line)
        if m and a <= parse_time(m.group(1)) <= b:
            out.append(line)
    return "\n".join(out)


@mcp.tool(annotations=RO)
def list_splices(path: str, start: str | float | None = None, end: str | float | None = None) -> list[dict]:
    """Every place where audio was removed (automatically or by hand): episode time, what was removed and why,
    how long, and the edit ids (pass them to restore)."""
    from .view import timeline
    p = _load(path)
    tl = timeline(p)
    a = parse_time(start) if start is not None else 0.0
    b = parse_time(end) if end is not None else 1e9
    edits = {e["id"]: e for e in tl["edits"]}
    out = []
    for sp in tl["splices"]:
        if not a <= sp["episode_time"] <= b:
            continue
        texts = [edits[i].get("text") for i in sp["edits"] if edits[i].get("text")]
        out.append({"time": _tc(sp["episode_time"]), "removed_s": sp["removed"], "kinds": sp["kinds"],
                    "text": " / ".join(texts)[:200], "edit_ids": sp["edits"]})
    return out


# ---- editing --------------------------------------------------------------------------------------
@mcp.tool(annotations=RW)
def cut(path: str, start: str | float, end: str | float, snap_to_silence: bool = True) -> dict:
    """Remove a part of the finished episode (start/end in episode time). Edges move to the quietest spot
    nearby unless snap_to_silence is false. Undoable."""
    p = _load(path)
    ranges = C.episode_range_to_sources(p, parse_time(start), parse_time(end))
    ids = editing.add_cuts(p, path, ranges, snap=snap_to_silence)
    return {"cut_ids": ids, "new_length": _tc(C.episode_length(p))}


@mcp.tool(annotations=RW)
def restore(path: str, edit_ids: list[str]) -> dict:
    """Bring removed audio back (edit ids from list_splices). Automatic edits are kept off; your own cuts
    are switched off too. Undoable."""
    p = _load(path)
    editing.set_status(p, path, edit_ids, "rejected")
    return {"restored": edit_ids, "new_length": _tc(C.episode_length(p))}


@mcp.tool(annotations=RW)
def adjust_cut(path: str, edit_id: str, start_ms: float = 0, end_ms: float = 0, snap: bool = False) -> dict:
    """Move a cut's edges by milliseconds (negative = earlier), or snap both edges to silence."""
    p = _load(path)
    e = next((x for x in p.edits if x.id == edit_id), None)
    if e is None:
        raise ValueError(f"edit not found: {edit_id}")
    editing.adjust(p, path, edit_id, e.start + start_ms / 1000, e.end + end_ms / 1000, "both" if snap else None)
    return {"ok": True, "new_length": _tc(C.episode_length(p))}


@mcp.tool(annotations=RW)
def undo(path: str) -> dict:
    """Undo the last change (by the user or by Claude)."""
    p = _load(path)
    return {"undone": editing.undo(p, path)}


@mcp.tool(annotations=RW)
def redo(path: str) -> dict:
    """Redo the last undone change."""
    p = _load(path)
    return {"redone": editing.redo(p, path)}


@mcp.tool(annotations=RO)
def get_automation(path: str) -> dict:
    """What the program does by itself: pause shortening, breaths, mouth clicks, repeat/retake/filler policy."""
    return _load(path).automation.model_dump()


@mcp.tool(annotations=RW)
def set_automation(path: str, changes: dict) -> dict:
    """Change automation and re-apply it, e.g. {"pause_max": 1.2, "pause_target": 0.6},
    {"breaths": "cut"|"duck"|"off", "breath_db": -15}, {"clicks": "off"|"light"|"normal"|"strong"},
    {"kinds": {"filler": "keep"}}. Edits the user changed by hand are not overridden. Undoable."""
    p = _load(path)
    editing.set_automation(p, path, changes)
    return {"automation": p.automation.model_dump(), "new_length": _tc(C.episode_length(p))}


# ---- chapters -------------------------------------------------------------------------------------
@mcp.tool(annotations=RO)
def get_chapters(path: str) -> dict:
    """Current chapters, the YouTube timecode text and rule warnings."""
    p = _load(path)
    rows = C.resolved(p)
    return {"chapters": rows, "youtube": C.youtube_text(rows), "warnings": C.check_youtube(rows)}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True))
def set_chapters(path: str, chapters: list[dict]) -> dict:
    """Replace all chapters. `chapters` = [{"time": "MM:SS" or seconds, "title": "..."}] in episode time.
    The first chapter is moved to 00:00; times snap to the nearest word and follow later edits."""
    p = _load(path)
    items = [{"time": parse_time(c["time"]), "title": c["title"], "origin": "claude"} for c in chapters]
    C.set_chapters(p, items, origin="claude")
    p.save(path)
    rows = C.resolved(p)
    return {"saved": len(rows), "chapters": rows, "youtube": C.youtube_text(rows), "warnings": C.check_youtube(rows)}


# ---- export ---------------------------------------------------------------------------------------
@mcp.tool(annotations=RO)
def list_templates(path: str | None = None) -> list[dict]:
    """Video templates (for export) with their parameters and the values that would be used."""
    _seen()
    p = Project.load(path) if path and Path(path).is_file() else None
    out = []
    for t in T.discover().values():
        own = p.export.video.params if p and p.export.video.template == t.manifest.id else None
        out.append({"id": t.manifest.id, "name": t.manifest.name, "ready": not t.missing,
                    "params": [{"key": x.key, "label": x.label, "type": x.type, "required": x.required}
                               for x in t.manifest.params],
                    "values": T.initial_params(t, own, str(Path(path).resolve()) if path else "")})
    return out


@mcp.tool(annotations=RW)
def export(path: str, video_template: str | None = None, video_params: dict | None = None,
           wav: bool = True, mp3: bool = True, thumbnail: bool | None = None) -> dict:
    """Render the finished episode into the project's export folder: WAV / MP3 with chapters, the YouTube
    timecodes file, with video_template an MP4, and with thumbnail=true the thumbnail picture (None keeps the
    project's choice). Returns a job id (poll job_status)."""
    _load(path)
    video = {"template": video_template, "params": video_params or {}} if video_template else {"template": None}
    return _start_job("export", lambda progress: ops.export_project(path, None, None, wav, mp3, True, True,
                                                                   video, 0, progress, thumbnail=thumbnail))


# ---- thumbnail ------------------------------------------------------------------------------------
def _thumb_info(p: Project, path: str) -> dict:
    from . import thumbnail as TH
    s = TH.initial(p, path)
    text = None
    try:
        text = TH.badge_text(s) if s.badge.enabled else ""
    except TH.ThumbnailError as e:
        text = f"! {e}"
    return {"settings": s.model_dump(), "with_export": p.export.make_thumbnail, "badge_text": text,
            "size": f"{s.width}x{s.height}", "picture_ok": bool(s.image and Path(s.image).is_file())}


@mcp.tool(annotations=RO)
def get_thumbnail(path: str) -> dict:
    """Thumbnail settings: picture, output size, format, episode number and the badge (position x / y as fractions
    of the picture, width / height as fractions of the picture's height, angle in degrees clockwise, colours)."""
    return _thumb_info(_load(path), path)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True))
def set_thumbnail(path: str, changes: dict) -> dict:
    """Change thumbnail settings, e.g. {"episode": 5}, {"width": 1280, "height": 720}, {"format": "jpg"},
    {"image": "C:/pics/cover.png"} (copied into the project), {"badge": {"text": "ВИПУСК {n}", "x": 0.4}},
    {"with_export": true} to make it on every export of this project."""
    from . import thumbnail as TH
    p = _load(path)
    changes = dict(changes)
    with_export = changes.pop("with_export", None)
    if changes:
        TH.update(p, path, changes)
    if with_export is not None:
        p.export.make_thumbnail = bool(with_export)
        p.save(path)
    return _thumb_info(p, path)


def main() -> None:
    _seen()
    mcp.run()
