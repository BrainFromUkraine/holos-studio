"""Local API tests (synthetic audio, ASR stubbed out)."""
import time

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from holos import ops
from holos.project import CutEdit, Project
from holos.server import create_app

SR = 48000
TOKEN = "t0k"


def _files(tmp_path):
    rng = np.random.default_rng(1)
    a = rng.standard_normal(SR) * 0.03
    paths = []
    for name, sig in [("POD00002.WAV", a), ("POD00001.WAV", rng.standard_normal(SR) * 0.03), ("POD00003.WAV", a)]:
        sf.write(tmp_path / name, np.stack([sig, sig], 1), SR, subtype="PCM_24")
        paths.append(str(tmp_path / name))
    return paths


def _client():
    return TestClient(create_app(TOKEN), headers={"X-Holos-Token": TOKEN})


def test_health_is_open_and_auth_required():
    c = TestClient(create_app(TOKEN))
    h = c.get("/api/health").json()
    assert h["name"] == "holos-engine" and h["auth"] is True
    assert c.post("/api/files/inspect", json={"files": []}).status_code == 401


def test_inspect_create_process_summary(tmp_path, monkeypatch):
    monkeypatch.setattr(ops, "asr_available", lambda: False)
    c = _client()
    files = _files(tmp_path)
    info = c.post("/api/files/inspect", json={"files": files}).json()
    assert [i["name"] for i in info] == ["POD00001.WAV", "POD00002.WAV", "POD00003.WAV"]
    assert info[2]["duplicate_of"] == "POD00002.WAV"

    proj = str(tmp_path / "ep.holos")
    r = c.post("/api/projects", json={"path": proj, "files": files, "glossary": ["ESP32"], "target_lufs": -14})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["summary"]["sources"]) == 2 and len(body["skipped"]) == 1
    assert body["summary"]["settings"]["glossary"] == ["ESP32"]
    assert body["summary"]["settings"]["target_lufs"] == -14

    job = c.post("/api/projects/process", json={"path": proj}).json()
    for _ in range(200):
        st = c.get(f"/api/jobs/{job['id']}").json()
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["state"] == "done", st
    assert st["result"]["transcribe"] == {"skipped": True}

    with c.stream("GET", f"/api/jobs/{job['id']}/events", params={"token": TOKEN}) as s:
        lines = [ln for ln in s.iter_lines() if ln.startswith("data: ")]
    assert any('"stage": "analyze"' in ln for ln in lines) and '"state": "done"' in lines[-1]

    s = c.get("/api/projects/summary", params={"path": proj}).json()
    assert s["analyzed"] == 2 and s["edited_s"] is not None


def test_decision(tmp_path):
    c = _client()
    proj = str(tmp_path / "ep.holos")
    p, _ = ops.create_project(proj, _files(tmp_path)[:2])
    p.edits.append(CutEdit(id="s1-u1", source="s1", start=0.1, end=0.2, kind="unclear", text="x"))
    p.save(proj)
    assert c.post("/api/projects/decision", json={"path": proj, "id": "s1-u1", "decision": "keep"}).status_code == 200
    assert Project.load(proj).edits[0].status == "rejected"
    assert c.post("/api/projects/decision", json={"path": proj, "id": "nope", "decision": "cut"}).status_code == 404
