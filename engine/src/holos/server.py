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
        return Project.load(path)

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
    def get_audio(path: str, source: str) -> FileResponse:
        p = load(path)
        s = source_of(p, source)
        if not Path(s.path).is_file():
            raise HTTPException(404, f"recording missing: {s.path}")
        return FileResponse(s.path, media_type="audio/wav")

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
            video, body.preview, progress)).snapshot()

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
