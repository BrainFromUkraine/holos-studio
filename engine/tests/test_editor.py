"""Editor data and editing operations (synthetic audio, no ASR)."""
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from holos import ops, view
from holos.project import Project, Word
from holos.server import create_app

SR = 48000


def _project(tmp_path) -> str:
    rng = np.random.default_rng(5)
    files = []
    for i in (1, 2):
        t = np.arange(SR * 4) / SR
        x = 0.2 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 1.5 * t) > 0) + rng.standard_normal(len(t)) * 0.002
        f = tmp_path / f"POD{i:05d}.WAV"
        sf.write(f, np.stack([x, x], 1), SR, subtype="PCM_24")
        files.append(str(f))
    path = str(tmp_path / "ep.holos")
    p, _ = ops.create_project(path, files, "Ep")
    ops.analyze_project(p, path)
    p = Project.load(path)
    for s in p.sources:
        p.transcript[s.id] = [Word(w=f"w{k}", start=0.33 * k + 0.05, end=0.33 * k + 0.28) for k in range(11)]
    p.save(path)
    return path


def _c():
    return TestClient(create_app("k"), headers={"X-Holos-Token": "k"})


def test_view_data(tmp_path):
    path = _project(tmp_path)
    c = _c()
    tl = c.get("/api/projects/timeline", params={"path": path}).json()
    assert [s["id"] for s in tl["sources"]] == ["s1", "s2"]
    assert tl["sources"][1]["offset"] == tl["sources"][0]["duration"] + tl["gap_view"]
    assert tl["history"]["can_undo"] is False and len(tl["words"]["s1"]) == 11
    r = c.get("/api/projects/peaks", params={"path": path, "source": "s1"})
    assert r.headers["x-peaks-rate"] == str(view.PEAKS_RATE) and len(r.content) == 2 * 4 * view.PEAKS_RATE
    png = c.get("/api/projects/spectrogram", params={"path": path, "source": "s1", "token": "k"})
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n" and png.headers["content-type"] == "image/png"
    loud = c.get("/api/projects/loudness", params={"path": path, "source": "s2"}).json()
    assert loud["hop"] == view.LOUD_HOP and len(loud["values"]) >= 39
    audio = c.get("/api/projects/audio", params={"path": path, "source": "s1"}, headers={"Range": "bytes=0-99"})
    assert audio.status_code == 206 and len(audio.content) == 100


def test_edit_ops_and_history(tmp_path):
    path = _project(tmp_path)
    c = _c()
    L0 = c.get("/api/projects/timeline", params={"path": path}).json()["length"]
    r = c.post("/api/projects/edit", json={"path": path, "op": "cut_words", "source": "s1", "i0": 3, "i1": 4}).json()
    cut = next(e for e in r["edits"] if e["id"] == r["id"])
    assert cut["kind"] == "manual" and cut["text"] == "w3 w4" and r["length"] < L0
    r = c.post("/api/projects/edit", json={"path": path, "op": "adjust", "id": cut["id"], "end": cut["end"] + 0.01}).json()
    assert next(e for e in r["edits"] if e["id"] == cut["id"])["end"] == round(cut["end"] + 0.01, 4)
    r = c.post("/api/projects/edit", json={"path": path, "op": "cut", "source": "s2", "start": 1.0, "end": 1.5}).json()
    rng_id = r["id"]
    assert r["history"]["undo_label"] == "Вирізати виділене"
    r = c.post("/api/projects/edit", json={"path": path, "op": "status", "ids": [rng_id], "status": "rejected"}).json()
    assert next(e for e in r["edits"] if e["id"] == rng_id)["status"] == "rejected"
    for _ in range(4):
        r = c.post("/api/projects/edit", json={"path": path, "op": "undo"}).json()
    assert r["length"] == L0 and not any(e["kind"] == "manual" for e in r["edits"]) and r["history"]["can_redo"]
    r = c.post("/api/projects/edit", json={"path": path, "op": "redo"}).json()
    assert any(e["id"] == cut["id"] for e in r["edits"])
    bad = c.post("/api/projects/edit", json={"path": path, "op": "delete", "id": "nope"})
    assert bad.status_code == 400
    r = c.post("/api/projects/edit", json={"path": path, "op": "delete", "id": cut["id"]}).json()
    assert not any(e["id"] == cut["id"] for e in r["edits"])


def test_process_prepares_view(tmp_path, monkeypatch):
    monkeypatch.setattr(ops, "asr_available", lambda: False)
    path = _project(tmp_path)
    res = ops.process_project(path)
    assert "view" in res
    p = Project.load(path)
    assert all(f.is_file() for f in view._files(path, p, "s1").values())
