"""Local HTTP API for the Holos Studio desktop app.

Binds to 127.0.0.1 only. Every request except /api/health must carry the per-launch token
in the `X-Holos-Token` header (or `?token=` for the event stream, which EventSource can't set headers on).
Long operations run as jobs on a single worker (one GPU); progress streams as server-sent events.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import __version__
from . import chapters as chapters_mod
from . import ops
from . import templates as templates_mod
from .project import Project

ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000", "tauri://localhost", "http://tauri.localhost",
                   "https://tauri.localhost"]


@dataclass
class Job:
    id: str
    kind: str
    project: str
    state: str = "queued"                 # queued | running | done | error
    stage: str = ""
    done: int = 0
    total: int = 0
    detail: str = ""
    result: Any = None
    error: str | None = None
    started: float = field(default_factory=time.time)
    events: list[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        return {"id": self.id, "kind": self.kind, "project": self.project, "state": self.state, "stage": self.stage,
                "done": self.done, "total": self.total, "detail": self.detail, "result": self.result,
                "error": self.error, "elapsed": round(time.time() - self.started, 1)}

    def push(self, **kw) -> None:
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)
            self.events.append(self.snapshot())


class FilesIn(BaseModel):
    files: list[str]
    keep_order: bool = False


class CreateIn(BaseModel):
    path: str
    files: list[str]
    name: str | None = None
    keep_order: bool = False
    language: str | None = None
    glossary: list[str] | None = None
    target_lufs: float | None = None
    auto_apply: list[str] | None = None


class ProjectIn(BaseModel):
    path: str


class ChapterIn(BaseModel):
    time: float
    title: str


class ChaptersIn(BaseModel):
    path: str
    chapters: list[ChapterIn]


class VideoIn(BaseModel):
    template: str | None = None
    params: dict[str, Any] = {}


class ExportIn(BaseModel):
    path: str
    out_dir: str | None = None
    name: str | None = None
    wav: bool | None = None
    mp3: bool | None = None
    chapters_txt: bool | None = None
    chapters_embed: bool | None = None
    video: VideoIn | None = None
    preview: float = 0
    thumbnail: bool | None = None


class ThumbnailIn(BaseModel):
    path: str
    changes: dict[str, Any] = {}


class EpisodeIn(BaseModel):
    name: str
    files: list[str]
    automation: dict[str, Any] | None = None
    language: str | None = None
    glossary: list[str] | None = None


class AutomationIn(BaseModel):
    path: str
    changes: dict[str, Any]


class DefaultsIn(BaseModel):
    automation: dict[str, Any]


class SettingsIn(BaseModel):
    projects_dir: str | None = None


class PreviewIn(BaseModel):
    path: str
    template: str
    params: dict[str, Any] = {}
    seconds: float = 6.0


class EditIn(BaseModel):
    path: str
    op: str                                # status | adjust | cut | cut_words | delete | undo | redo
    ids: list[str] | None = None
    status: str | None = None
    id: str | None = None
    source: str | None = None
    start: float | None = None
    end: float | None = None
    snap: str | bool | None = None
    i0: int | None = None
    i1: int | None = None
    ranges: list[dict[str, Any]] | None = None


class DecisionIn(BaseModel):
    path: str
    id: str
    decision: str                          # "cut" | "keep"


def create_app(token: str | None = None) -> FastAPI:
    app = FastAPI(title="Holos engine", version=__version__)

    # Registered before CORS so CORS wraps it: an unexpected error still reaches the UI as readable JSON
    # (a bare 500 from Starlette carries no CORS headers and the browser reports only "Failed to fetch").
    @app.middleware("http")
    async def errors_as_json(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            return JSONResponse({"detail": f"{type(e).__name__}: {e}"}, status_code=500)

    app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])
    jobs: dict[str, Job] = {}
    pool = ThreadPoolExecutor(max_workers=1)

    def auth(request: Request) -> None:
        if token is None:
            return
        given = request.headers.get("x-holos-token") or request.query_params.get("token")
        if given != token:
            raise HTTPException(401, "invalid or missing X-Holos-Token")

    def load(path: str) -> Project:
        if not Path(path).is_file():
            raise HTTPException(404, f"project not found: {path}")
        templates_mod.touch_recent(path)
        p = Project.load(path)
        ops.refresh_breaths(p, path)           # projects analysed by an older breath detector
        return p

    def run_job(kind: str, project: str, fn: Callable[[Callable], Any]) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, project=project)
        jobs[job.id] = job
        job.push()

        def progress(stage: str, done: int, total: int, detail: str) -> None:
            job.push(stage=stage, done=done, total=total, detail=detail)

        def work() -> None:
            job.push(state="running")
            try:
                res = fn(progress)
                job.push(state="done", result=res, detail="done")
            except Exception as e:   # surfaced to the UI as-is
                job.push(state="error", error=f"{type(e).__name__}: {e}")

        pool.submit(work)
        return job

    @app.get("/api/health")
    def health() -> dict:
        from .io import FFmpegError, ffmpeg_path
        try:
            ff = ffmpeg_path()
        except FFmpegError:
            ff = None
        return {"name": "holos-engine", "version": __version__, "ffmpeg": ff, "asr": ops.asr_available(),
                "cuda_devices": cuda_devices(), "auth": token is not None}

    gpu_probe: dict = {}

    def cuda_devices() -> int | None:
        """Number of CUDA GPUs, probed once (re-probing every few seconds was flaky while the GPU was busy).
        None = unknown, so the UI never claims "CPU" just because a probe failed."""
        if "n" in gpu_probe:
            return gpu_probe["n"]
        if not ops.asr_available():
            return None
        try:
            import ctranslate2
            from .asr import register_nvidia_dlls
            register_nvidia_dlls()
            gpu_probe["n"] = int(ctranslate2.get_cuda_device_count())
            return gpu_probe["n"]
        except Exception:
            return None

    @app.post("/api/files/inspect", dependencies=[Depends(auth)])
    def inspect(body: FilesIn) -> list[dict]:
        missing = [f for f in body.files if not Path(f).is_file()]
        if missing:
            raise HTTPException(400, f"not found: {missing[:3]}")
        return ops.inspect_files(body.files, body.keep_order)

    @app.post("/api/projects", dependencies=[Depends(auth)])
    def create(body: CreateIn) -> dict:
        try:
            body.path = str(ops.project_file_path(body.path))
            p, skipped = ops.create_project(body.path, body.files, body.name, body.keep_order)
        except (ValueError, OSError) as e:
            raise HTTPException(400, str(e))
        if body.language: p.asr.language = body.language
        if body.glossary is not None: p.asr.glossary = body.glossary
        if body.auto_apply is not None: p.auto_apply = body.auto_apply
        if body.target_lufs is not None:
            for c in p.chain:
                if c.module == "loudness":
                    c.params["target_lufs"] = body.target_lufs
        p.save(body.path)
        templates_mod.touch_recent(body.path)
        return {"path": body.path, "summary": ops.summary(p), "skipped": skipped}

    @app.get("/api/projects/summary", dependencies=[Depends(auth)])
    def summary(path: str) -> dict:
        return ops.summary(load(path))

    @app.post("/api/projects/process", dependencies=[Depends(auth)])
    def process(body: ProjectIn) -> dict:
        load(body.path)
        return run_job("process", body.path, lambda progress: ops.process_project(body.path, progress)).snapshot()

    @app.post("/api/projects/decision", dependencies=[Depends(auth)])
    def decision(body: DecisionIn) -> dict:
        from . import editing
        p = load(body.path)
        status = {"cut": "accepted", "keep": "rejected"}.get(body.decision)
        if status is None:
            raise HTTPException(400, "decision must be 'cut' or 'keep'")
        with edit_lock:
            try:
                editing.set_status(p, body.path, [body.id], status)
            except editing.EditError as e:
                raise HTTPException(404, str(e))
        return ops.summary(p)

    # ---- editor --------------------------------------------------------------------------------
    edit_lock = threading.Lock()

    def source_of(p: Project, sid: str):
        try:
            return p.source(sid)
        except KeyError:
            raise HTTPException(404, f"source not found: {sid}")

    def timeline_payload(p: Project, path: str) -> dict:
        from . import editing, view
        return {**view.timeline(p, path), "history": editing.history_state(path)}

    @app.get("/api/projects/timeline", dependencies=[Depends(auth)])
    def get_timeline(path: str) -> dict:
        return timeline_payload(load(path), path)

    @app.get("/api/projects/peaks", dependencies=[Depends(auth)])
    def get_peaks(path: str, source: str) -> Response:
        from . import view
        p = load(path)
        source_of(p, source)
        return Response(view.peaks(p, path, source), media_type="application/octet-stream",
                        headers={"X-Peaks-Rate": str(view.PEAKS_RATE), "Cache-Control": "max-age=3600",
                                 "Access-Control-Expose-Headers": "X-Peaks-Rate"})

    @app.get("/api/projects/spectrogram", dependencies=[Depends(auth)])
    def get_spectrogram(path: str, source: str) -> Response:
        from . import view
        p = load(path)
        source_of(p, source)
        return Response(view.spectrogram_png(p, path, source), media_type="image/png",
                        headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/spectrogram/legend")
    def get_legend() -> Response:
        from . import view
        return Response(view.legend_png(), media_type="image/png", headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/projects/loudness", dependencies=[Depends(auth)])
    def get_loudness(path: str, source: str) -> dict:
        from . import view
        p = load(path)
        source_of(p, source)
        return {"hop": view.LOUD_HOP, "values": view.loudness(p, path, source)}

    @app.get("/api/projects/audio", dependencies=[Depends(auth)])
    def get_audio(path: str, source: str, processed: bool = False) -> FileResponse:
        """A recording for the editor's player; `processed` = the "Result" copy (made now if missing)."""
        from . import preview
        p = load(path)
        s = source_of(p, source)
        if not Path(s.path).is_file():
            raise HTTPException(404, f"recording missing: {s.path}")
        if processed and source in p.analysis:
            return FileResponse(str(preview.ensure(p, path, source)), media_type="audio/wav",
                                headers={"Cache-Control": "max-age=86400"})   # the URL carries the version key
        return FileResponse(s.path, media_type="audio/wav")

    # processed copies are re-made in the background after a change, so "Result" is ready when it is played
    preview_pool = ThreadPoolExecutor(max_workers=1)
    preview_pending: set[str] = set()

    def refresh_previews(path: str) -> None:
        if path in preview_pending:
            return
        preview_pending.add(path)

        def work() -> None:
            from . import preview
            try:
                preview_pending.discard(path)
                preview.prepare(Project.load(path), path)
            except Exception:                       # best effort: the player makes a copy on demand anyway
                pass
        preview_pool.submit(work)

    @app.post("/api/projects/analyze", dependencies=[Depends(auth)])
    def analyze(body: ProjectIn) -> dict:
        load(body.path)
        return run_job("analyze", body.path, lambda progress: ops.analyze_again(body.path, progress)).snapshot()

    @app.post("/api/projects/autoedit", dependencies=[Depends(auth)])
    def autoedit(body: ProjectIn) -> dict:
        load(body.path)
        return run_job("autoedit", body.path, lambda progress: ops.auto_edit(body.path, progress)).snapshot()

    @app.post("/api/projects/edit", dependencies=[Depends(auth)])
    def edit(body: EditIn) -> dict:
        from . import editing
        p = load(body.path)
        info: dict = {}
        with edit_lock:
            try:
                if body.op == "status":
                    editing.set_status(p, body.path, body.ids or ([body.id] if body.id else []), body.status or "")
                elif body.op == "adjust":
                    snap = body.snap if isinstance(body.snap, str) else None
                    editing.adjust(p, body.path, body.id or "", body.start, body.end, snap)
                elif body.op == "cut":
                    if body.source is None or body.start is None or body.end is None:
                        raise editing.EditError("cut needs source, start and end")
                    source_of(p, body.source)
                    info["id"] = editing.add_cut(p, body.path, body.source, body.start, body.end,
                                                 snap=body.snap is not False)
                elif body.op == "cut_words":
                    if body.source is None or body.i0 is None or body.i1 is None:
                        raise editing.EditError("cut_words needs source, i0 and i1")
                    info["id"] = editing.cut_words(p, body.path, body.source, body.i0, body.i1)
                elif body.op == "cuts":
                    info["ids"] = editing.add_cuts(p, body.path, body.ranges or [], snap=body.snap is not False)
                elif body.op == "delete":
                    editing.delete(p, body.path, body.id or "")
                elif body.op == "undo":
                    info["undone"] = editing.undo(p, body.path)
                elif body.op == "redo":
                    info["redone"] = editing.redo(p, body.path)
                else:
                    raise editing.EditError(f"unknown op: {body.op}")
            except editing.EditError as e:
                raise HTTPException(400, str(e))
        refresh_previews(body.path)
        return {**timeline_payload(p, body.path), **info}

    @app.put("/api/projects/chapters", dependencies=[Depends(auth)])
    def put_chapters(body: ChaptersIn) -> dict:
        p = load(body.path)
        chapters_mod.set_chapters(p, [c.model_dump() for c in body.chapters], origin="user")
        p.save(body.path)
        return ops.summary(p)

    @app.get("/api/templates", dependencies=[Depends(auth)])
    def list_templates(path: str | None = None) -> dict:
        p = load(path) if path else None
        out = []
        for t in templates_mod.discover().values():
            own = p.export.video.params if p and p.export.video.template == t.manifest.id else None
            out.append({**t.public(), "initial": templates_mod.initial_params(t, own, str(Path(path).resolve()) if path else "")})
        return {"user_dir": str(templates_mod.home() / "templates"), "templates": out}

    @app.post("/api/projects/export", dependencies=[Depends(auth)])
    def export(body: ExportIn) -> dict:
        load(body.path)
        video = body.video.model_dump() if body.video else None
        if video is not None and video.get("template"):
            try:
                t = templates_mod.get(video["template"])
                templates_mod.build_args(t.manifest, video["params"])
            except (KeyError, templates_mod.TemplateError) as e:
                raise HTTPException(400, str(e).strip("'\""))
        return run_job("export", body.path, lambda progress: ops.export_project(
            body.path, body.out_dir, body.name, body.wav, body.mp3, body.chapters_txt, body.chapters_embed,
            video, body.preview, progress, thumbnail=body.thumbnail)).snapshot()

    # ---- thumbnail ---------------------------------------------------------------------------
    def thumbnail_payload(p: Project, path: str) -> dict:
        from . import thumbnail as TH
        s = TH.initial(p, path)
        out: dict[str, Any] = {"settings": s.model_dump(), "enabled": p.export.make_thumbnail,
                               "presets": [{"width": w, "height": h} for w, h in TH.PRESETS],
                               "preview": None, "error": None}
        if s.image and Path(s.image).is_file():
            try:
                out["preview"] = TH.preview(s, ops.cache_dir(path) / "thumbnail")
            except (TH.ThumbnailError, OSError) as e:
                out["error"] = str(e)
        return out

    @app.get("/api/projects/thumbnail", dependencies=[Depends(auth)])
    def get_thumbnail(path: str) -> dict:
        return thumbnail_payload(load(path), path)

    @app.put("/api/projects/thumbnail", dependencies=[Depends(auth)])
    def put_thumbnail(body: ThumbnailIn) -> dict:
        from pydantic import ValidationError
        from . import thumbnail as TH
        p = load(body.path)
        changes = dict(body.changes)
        enabled = changes.pop("enabled", None)
        try:
            if changes:
                TH.update(p, body.path, changes)
            if enabled is not None:
                p.export.make_thumbnail = bool(enabled)
                p.save(body.path)
        except (TH.ThumbnailError, ValidationError) as e:
            raise HTTPException(400, str(e))
        return thumbnail_payload(p, body.path)

    @app.get("/api/thumbnail/font", dependencies=[Depends(auth)])
    def thumbnail_font() -> FileResponse:
        """The badge typeface, so the export screen draws the badge while it is dragged exactly like the engine."""
        from . import thumbnail as TH
        return FileResponse(str(TH.FONT), media_type="font/ttf", headers={"Cache-Control": "max-age=86400"})

    # ---- projects, automation, previews ------------------------------------------------------
    def running_projects() -> set[str]:
        return {str(Path(j.project).resolve()) for j in jobs.values()
                if j.state in ("queued", "running") and j.kind in ("episode", "process") and j.project}

    @app.get("/api/projects/stamp", dependencies=[Depends(auth)])
    def project_stamp(path: str) -> dict:
        """Changes by Claude (MCP) or another window show up in the app by polling this."""
        f = Path(path)
        return {"mtime": f.stat().st_mtime if f.is_file() else None}

    @app.get("/api/projects/list", dependencies=[Depends(auth)])
    def projects_list() -> dict:
        from . import projects as P
        return {"root": str(P.projects_root()), "projects": P.list_projects(running_projects())}

    @app.post("/api/episodes", dependencies=[Depends(auth)])
    def new_episode(body: EpisodeIn) -> dict:
        from . import projects as P
        missing = [f for f in body.files if not Path(f).is_file()]
        if missing:
            raise HTTPException(400, f"not found: {missing[:3]}")
        if not body.files:
            raise HTTPException(400, "no recordings")
        target = str(P.new_project_path(body.name))
        return run_job("episode", target, lambda progress: P.new_episode(
            body.name, body.files, body.automation, body.language, body.glossary, target, progress)).snapshot()

    @app.post("/api/projects/open", dependencies=[Depends(auth)])
    def open_project(body: ProjectIn) -> dict:
        return ops.summary(load(body.path))

    @app.put("/api/projects/automation", dependencies=[Depends(auth)])
    def put_automation(body: AutomationIn) -> dict:
        from . import editing
        p = load(body.path)
        with edit_lock:
            try:
                editing.set_automation(p, body.path, body.changes)
            except Exception as e:
                raise HTTPException(400, str(e))
        refresh_previews(body.path)
        return timeline_payload(p, body.path)

    @app.get("/api/automation/defaults", dependencies=[Depends(auth)])
    def get_defaults() -> dict:
        from .project import Automation
        return Automation.model_validate(templates_mod.load_state().get("automation") or {}).model_dump()

    @app.put("/api/automation/defaults", dependencies=[Depends(auth)])
    def put_defaults(body: DefaultsIn) -> dict:
        from .project import Automation
        a = Automation.model_validate(body.automation).model_dump()
        templates_mod.update_state(lambda st: st.__setitem__("automation", a))
        return a

    @app.get("/api/settings", dependencies=[Depends(auth)])
    def get_settings() -> dict:
        from . import projects as P
        st = templates_mod.load_state()
        return {"projects_dir": str(P.projects_root()), "home": str(templates_mod.home()),
                "templates_dir": str(templates_mod.home() / "templates"), "mcp_last_seen": st.get("mcp_last_seen"),
                "mcp_config": mcp_config(), "version": __version__}

    def mcp_config() -> dict:
        """Ready-to-paste entry for Claude Desktop's claude_desktop_config.json: this very engine, `python -m holos mcp`
        (not the holos.exe launcher, which an engine update has to replace while Claude Desktop keeps it running)."""
        import sys
        entry: dict[str, Any] = {"command": sys.executable, "args": ["-m", "holos", "mcp"]}
        from .io import FFmpegError, ffmpeg_path
        try:
            entry["env"] = {"HOLOS_FFMPEG": ffmpeg_path()}
        except FFmpegError:
            pass
        return {"mcpServers": {"holos-studio": entry}}

    @app.put("/api/settings", dependencies=[Depends(auth)])
    def put_settings(body: SettingsIn) -> dict:
        from . import projects as P
        if body.projects_dir:
            P.set_projects_root(body.projects_dir)
        return get_settings()

    preview_lock = threading.Lock()

    @app.post("/api/templates/preview", dependencies=[Depends(auth)])
    def template_preview(body: PreviewIn) -> dict:
        load(body.path)
        with preview_lock:
            try:
                r = ops.template_preview(body.path, body.template, body.params, max(2.0, min(15.0, body.seconds)))
            except (KeyError, templates_mod.TemplateError) as e:
                raise HTTPException(400, str(e).strip("'\""))
        return {**r, "key": r["key"]}

    @app.get("/api/files/cache", dependencies=[Depends(auth)])
    def cache_file(path: str) -> FileResponse:
        f = Path(path)
        if not f.is_file() or not any(part.endswith(".holos-cache") for part in f.resolve().parts):
            raise HTTPException(404, "not a cache file")
        kind = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png"}.get(f.suffix.lower(), "application/octet-stream")
        return FileResponse(str(f), media_type=kind, headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/jobs/{job_id}", dependencies=[Depends(auth)])
    def job(job_id: str) -> dict:
        if job_id not in jobs:
            raise HTTPException(404, "job not found")
        return jobs[job_id].snapshot()

    @app.get("/api/jobs/{job_id}/events", dependencies=[Depends(auth)])
    async def events(job_id: str) -> StreamingResponse:
        if job_id not in jobs:
            raise HTTPException(404, "job not found")
        j = jobs[job_id]

        async def stream():
            sent = 0
            while True:
                with j.lock:
                    batch = j.events[sent:]
                    sent = len(j.events)
                    finished = j.state in ("done", "error")
                for ev in batch:
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if finished and not batch:
                    break
                await asyncio.sleep(0.25)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app
