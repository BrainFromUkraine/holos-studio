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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import __version__
from . import ops
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


class DecisionIn(BaseModel):
    path: str
    id: str
    decision: str                          # "cut" | "keep"


def create_app(token: str | None = None) -> FastAPI:
    app = FastAPI(title="Holos engine", version=__version__)
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
        cuda = None
        if ops.asr_available():
            try:
                import ctranslate2
                from .asr import register_nvidia_dlls
                register_nvidia_dlls()
                cuda = ctranslate2.get_cuda_device_count()
            except Exception:
                cuda = 0
        return {"name": "holos-engine", "version": __version__, "ffmpeg": ff, "asr": ops.asr_available(),
                "cuda_devices": cuda, "auth": token is not None}

    @app.post("/api/files/inspect", dependencies=[Depends(auth)])
    def inspect(body: FilesIn) -> list[dict]:
        missing = [f for f in body.files if not Path(f).is_file()]
        if missing:
            raise HTTPException(400, f"not found: {missing[:3]}")
        return ops.inspect_files(body.files, body.keep_order)

    @app.post("/api/projects", dependencies=[Depends(auth)])
    def create(body: CreateIn) -> dict:
        try:
            p, skipped = ops.create_project(body.path, body.files, body.name, body.keep_order)
        except ValueError as e:
            raise HTTPException(400, str(e))
        if body.language: p.asr.language = body.language
        if body.glossary is not None: p.asr.glossary = body.glossary
        if body.auto_apply is not None: p.auto_apply = body.auto_apply
        if body.target_lufs is not None:
            for c in p.chain:
                if c.module == "loudness":
                    c.params["target_lufs"] = body.target_lufs
        p.save(body.path)
        return {"summary": ops.summary(p), "skipped": skipped}

    @app.get("/api/projects/summary", dependencies=[Depends(auth)])
    def summary(path: str) -> dict:
        return ops.summary(load(path))

    @app.post("/api/projects/process", dependencies=[Depends(auth)])
    def process(body: ProjectIn) -> dict:
        load(body.path)
        return run_job("process", body.path, lambda progress: ops.process_project(body.path, progress)).snapshot()

    @app.post("/api/projects/decision", dependencies=[Depends(auth)])
    def decision(body: DecisionIn) -> dict:
        p = load(body.path)
        status = {"cut": "accepted", "keep": "rejected"}.get(body.decision)
        if status is None:
            raise HTTPException(400, "decision must be 'cut' or 'keep'")
        if p.set_status(status, ids={body.id}) == 0:  # type: ignore[arg-type]
            raise HTTPException(404, f"edit not found: {body.id}")
        p.save(body.path)
        return ops.summary(p)

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
