"""Chapters, export templates and the export pipeline (synthetic audio, no ASR)."""
import json
import subprocess
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from holos import chapters as C
from holos import ops
from holos import templates as T
from holos.io import ffmpeg_path
from holos.mcp_server import parse_time
from holos.project import CutEdit, Project, Word
from holos.server import create_app

SR = 48000


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    monkeypatch.setenv("HOLOS_HOME", str(h))
    monkeypatch.delenv("HOLOS_TEMPLATES", raising=False)
    return h


def _project(tmp_path, seconds=(4.0, 4.0)) -> str:
    rng = np.random.default_rng(3)
    files = []
    for i, sec in enumerate(seconds, 1):
        x = rng.standard_normal(int(SR * sec)) * 0.05
        f = tmp_path / f"POD{i:05d}.WAV"
        sf.write(f, np.stack([x, x], 1), SR, subtype="PCM_24")
        files.append(str(f))
    path = str(tmp_path / "ep.holos")
    p, _ = ops.create_project(path, files, "Ep 1")
    ops.analyze_project(p, path)
    p = Project.load(path)
    for s in p.sources:          # one word every 0.5 s
        p.transcript[s.id] = [Word(w=f"{s.id}w{k}", start=0.5 * k, end=0.5 * k + 0.3) for k in range(int(s.duration * 2) - 1)]
    p.save(path)
    return path


def test_parse_time():
    assert parse_time("01:15") == 75 and parse_time("1:01:15") == 3675 and parse_time(12.5) == 12.5
    with pytest.raises(ValueError):
        parse_time("1m")


def test_chapters_follow_cuts(tmp_path, home):
    path = _project(tmp_path)
    p = Project.load(path)
    C.set_chapters(p, [{"time": 0, "title": "A"}, {"time": 5.0, "title": "B"}])
    before = C.resolved(p)
    assert before[0]["time"] == 0 and before[1]["source"] == "s2"
    # cut 1 s out of the first file → chapter B moves 1 s (+ crossfade) earlier, same word
    p.edits.append(CutEdit(id="x", source="s1", start=1.0, end=2.0, status="accepted", kind="manual"))
    after = C.resolved(p)
    assert after[1]["at"] == before[1]["at"]
    assert after[1]["time"] == pytest.approx(before[1]["time"] - 1.0 - p.timeline_settings.crossfade, abs=0.02)
    assert after[-1]["end"] == pytest.approx(C.episode_length(p), abs=0.01)
    assert any("at least 3" in w for w in C.check_youtube(after))
    assert C.youtube_text(after).startswith("00:00 A\n")
    words = C.episode_words(p)
    assert all(not (1.0 <= w.src_start + 0.15 < 2.0) for w in words if w.source == "s1")


def test_ffmetadata_escapes():
    meta = C.ffmetadata([{"time": 0, "end": 1.5, "title": "a=b; #c"}], "T")
    assert "title=a\\=b\\; \\#c" in meta and "END=1500" in meta


def test_builtin_template_listed(home):
    found = T.discover()
    assert "waveform" in found and found["waveform"].builtin and found["waveform"].missing == []


def _user_template(home, body: str, **manifest):
    d = home / "templates" / "fake"
    d.mkdir(parents=True)
    (d / "make.py").write_text(body, encoding="utf-8")
    m = {"id": "fake", "name": "Fake", "entry": "make.py", "args": {"audio": "--audio", "out": "--out", "preview": "--preview"},
         "params": [{"key": "episode", "label": "Episode", "type": "int", "arg": "--episode", "required": True, "auto": "increment"},
                    {"key": "glow", "label": "Glow", "type": "bool", "arg": "--glow", "default": False}],
         "progress": {"regex": r"^(\d+) / (\d+) s"}}
    m.update(manifest)
    (d / "template.json").write_text(json.dumps(m), encoding="utf-8")


FAKE = r'''
import argparse, os, subprocess
ap = argparse.ArgumentParser()
ap.add_argument("--audio"); ap.add_argument("--out"); ap.add_argument("--episode", type=int)
ap.add_argument("--glow", action="store_true"); ap.add_argument("--preview", type=float, default=0)
a = ap.parse_args()
print("1 / 2 s", flush=True)
d = a.preview or 2
subprocess.run([os.environ["HOLOS_FFMPEG"], "-v", "error", "-y", "-f", "lavfi", "-i", f"color=black:s=64x36:d={d}",
                "-f", "lavfi", "-i", f"sine=d={d}", "-ac", "1", "-c:v", "libx264", "-c:a", "aac", "-shortest", a.out], check=True)
print("2 / 2 s", flush=True)
'''


def _probe(path):
    r = subprocess.run([ffmpeg_path().replace("ffmpeg", "ffprobe"), "-v", "error", "-show_chapters", "-show_streams",
                        "-of", "json", path], capture_output=True, text=True)
    return json.loads(r.stdout)


def test_export_all_deliverables(tmp_path, home):
    _user_template(home, FAKE)
    path = _project(tmp_path)
    p = Project.load(path)
    C.set_chapters(p, [{"time": 0, "title": "Intro"}, {"time": 2.6, "title": "Two"}, {"time": 5.1, "title": "Three"}])
    p.save(path)
    stages = []
    r = ops.export_project(path, tmp_path / "out", video={"template": "fake", "params": {"episode": 7, "glow": True}},
                           progress=lambda s, d, t, x: stages.append((s, d, t)))
    assert set(r["files"]) == {"wav", "mp3", "timecodes", "video"}
    assert ("video", 1, 2) in stages
    assert (tmp_path / "out" / "таймкоди.txt").read_text(encoding="utf-8").splitlines()[0] == "00:00 Intro"
    for kind in ("mp3", "video"):
        info = _probe(r["files"][kind])
        assert [c["tags"]["title"] for c in info["chapters"]] == ["Intro", "Two", "Three"]
    v = _probe(r["files"]["video"])
    audio = [s for s in v["streams"] if s["codec_type"] == "audio"][0]
    assert audio["channels"] == 2 and audio["sample_rate"] == "48000"     # master replaced the script's mono audio
    # settings saved in the project, next episode number suggested for a new project
    assert Project.load(path).export.video.params["episode"] == 7
    assert T.initial_params(T.get("fake"), None, "other.holos")["episode"] == 8
    # master is cached: a preview does not re-render
    stages.clear()
    r2 = ops.export_project(path, tmp_path / "out", preview=1, progress=lambda s, d, t, x: stages.append((s, x)))
    assert ("render", "cached") in stages and set(r2["files"]) == {"preview"}


def test_template_errors(tmp_path, home):
    _user_template(home, "import sys; print('boom'); sys.exit(3)")
    path = _project(tmp_path, (2.0,))
    with pytest.raises(T.TemplateError, match="required"):
        ops.export_project(path, tmp_path / "o", video={"template": "fake", "params": {}})
    with pytest.raises(T.TemplateError, match="boom"):
        ops.export_project(path, tmp_path / "o", mp3=False, wav=False, video={"template": "fake", "params": {"episode": 1}})


def test_api_templates_chapters_export(tmp_path, home):
    _user_template(home, FAKE)
    path = _project(tmp_path)
    c = TestClient(create_app("k"), headers={"X-Holos-Token": "k"})
    t = c.get("/api/templates", params={"path": path}).json()
    ids = {x["id"]: x for x in t["templates"]}
    assert ids["fake"]["initial"]["episode"] is None and ids["fake"]["preview"] is True
    s = c.put("/api/projects/chapters", json={"path": path, "chapters": [{"time": 0, "title": "A"}, {"time": 4.5, "title": "B"}]}).json()
    assert [x["title"] for x in s["chapters"]] == ["A", "B"] and s["chapter_warnings"]
    bad = c.post("/api/projects/export", json={"path": path, "video": {"template": "fake", "params": {}}})
    assert bad.status_code == 400
    job = c.post("/api/projects/export", json={"path": path, "mp3": False, "out_dir": str(tmp_path / "e"),
                                               "video": {"template": "fake", "params": {"episode": 2}}}).json()
    for _ in range(600):
        st = c.get(f"/api/jobs/{job['id']}").json()
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["state"] == "done", st
    assert set(st["result"]["files"]) == {"wav", "timecodes", "video"}
    assert T.recent_projects()[0].endswith("ep.holos")
