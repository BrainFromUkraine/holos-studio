"""v2: automation instead of questions, project folders, mouth clicks, splices, previews."""
import json
import time

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from holos import automation, editing, ops, projects
from holos import templates as T
from holos.dsp import Context, find_mouth_clicks, mouthclick
from holos.project import CutEdit, Project, Word
from holos.server import create_app

SR = 48000


def _energy_vad(x, sr):
    """Test stand-in for Silero: 'speech' wherever the 32 ms level is well above the noise floor."""
    from holos.analysis.features import VAD_HOP
    hop = int(VAD_HOP * sr)
    n = len(x) // hop
    lv = 10 * np.log10((x[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-14)
    return (lv > -40).astype(np.float32)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    import holos.analysis.features as F
    h = tmp_path / "home"
    monkeypatch.setenv("HOLOS_HOME", str(h))
    monkeypatch.setattr(ops, "asr_available", lambda: False)
    monkeypatch.setattr(F, "vad_probs", _energy_vad)
    return h


def _speechy(seconds: float, seed: int) -> np.ndarray:
    """Voiced bursts separated by pauses of different lengths."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * seconds)) / SR
    gate = np.zeros(len(t))
    pos = 0.3
    for gap in (0.4, 1.2, 0.5, 2.0, 0.6, 1.0):
        a, b = int(pos * SR), int((pos + 0.8) * SR)
        gate[a:b] = 1
        pos += 0.8 + gap
    voice = sum(0.08 / k * np.sin(2 * np.pi * 140 * k * t) for k in range(1, 20))
    return voice * gate + rng.standard_normal(len(t)) * 0.0015


def _files(tmp_path, n=2, seconds=10.0):
    out = []
    for i in range(1, n + 1):
        x = _speechy(seconds, i)
        f = tmp_path / "rec" / f"POD{i:05d}.WAV"
        f.parent.mkdir(exist_ok=True)
        sf.write(f, np.stack([x, x], 1), SR, subtype="PCM_24")
        out.append(str(f))
    return out


def test_mouth_clicks_found_and_removed_without_touching_voice():
    rng = np.random.default_rng(0)
    t = np.arange(SR * 4) / SR
    pulses = np.zeros(len(t))
    pulses[:: int(SR / 130)] = 1
    from scipy.signal import lfilter
    x = lfilter([1], [1, -1.6, 0.8], pulses) * 0.05 * np.clip(np.sin(2 * np.pi * 1.1 * t) * 3, 0, 1)
    x = x + rng.standard_normal(len(t)) * 0.001
    clicks = [0.33, 1.25, 1.9, 2.6, 3.33]
    for c in clicks:
        i, m = int(c * SR), int(0.0012 * SR)
        x[i:i + m] += rng.standard_normal(m) * 0.25 * np.hanning(m)
    found = [a / SR for a, _ in find_mouth_clicks(x, SR, "normal")]
    assert all(any(abs(f - c) < 0.005 for f in found) for c in clicks)
    assert len(found) == len(clicks)                      # glottal pulses are not clicks
    log = {}
    y = mouthclick(x, {"strength": "normal"}, Context(sr=SR, log=log))
    assert len(y) == len(x) and log["mouthclick"]["clicks"] == len(clicks)
    i = int(clicks[0] * SR)
    assert np.abs(y[i - 50:i + 200]).max() < np.abs(x[i - 50:i + 200]).max() * 0.6


def test_new_episode_copies_recordings_and_applies_automation(tmp_path, home):
    files = _files(tmp_path)
    res = projects.new_episode("Випуск 7", files)
    proj = home / "Projects" / "Випуск 7" / "Випуск 7.holos"
    assert res["path"] == str(proj) and proj.is_file()
    assert sorted(f.name for f in (proj.parent / "Recordings").iterdir()) == ["POD00001.WAV", "POD00002.WAV"]
    p = Project.load(proj)
    assert all("Recordings" in s.path for s in p.sources)
    pauses = [e for e in p.edits if e.type == "pause"]
    assert pauses and all(e.status == ("accepted" if e.end - e.start >= 0.9 else "rejected") for e in pauses)
    assert not any(e.status == "suggested" for e in p.edits)
    assert any(c.module == "mouthclick" and c.enabled for c in p.chain)
    # a second episode with the same name gets its own folder
    assert projects.new_project_path("Випуск 7").parent.name == "Випуск 7 (2)"
    rows = projects.list_projects()
    assert rows[0]["path"] == str(proj) and rows[0]["status"] == "ready" and len(rows[0]["thumb"]) == 120


def test_automation_changes_respect_manual_edits(tmp_path, home):
    files = _files(tmp_path, 1)
    path = projects.new_episode("A", files)["path"]
    p = Project.load(path)
    pause = next(e for e in p.edits if e.type == "pause" and e.status == "accepted")
    editing.set_status(p, path, [pause.id], "rejected")          # user restores this pause
    editing.set_automation(p, path, {"pause_max": 0.45, "pause_target": 0.3, "breaths": "off", "clicks": "off"})
    p = Project.load(path)
    assert next(e for e in p.edits if e.id == pause.id).status == "rejected"
    others = [e for e in p.edits if e.type == "pause" and e.id != pause.id]
    assert all(e.status == "accepted" and e.target == 0.3 for e in others if e.end - e.start >= 0.45)
    assert not next(c for c in p.chain if c.module == "mouthclick").enabled
    editing.undo(p, path)
    p = Project.load(path)
    assert p.automation.pause_max == 0.9 and next(c for c in p.chain if c.module == "mouthclick").enabled


def test_v1_project_migrates_and_keeps_answers(tmp_path, home):
    f = _files(tmp_path, 1)[0]
    path = tmp_path / "old.holos"
    p, _ = ops.create_project(path, [f], "old")
    ops.analyze_project(p, path)
    p = Project.load(path)
    p.edits += [CutEdit(id="s1-u1", source="s1", start=1.0, end=1.2, kind="unclear", status="accepted"),
                CutEdit(id="s1-u2", source="s1", start=2.0, end=2.2, kind="unclear", status="suggested"),
                CutEdit(id="s1-r1", source="s1", start=3.0, end=3.3, kind="repeat", status="suggested")]
    data = json.loads(p.model_dump_json())
    data["version"] = 1
    data.pop("automation")
    path.write_text(json.dumps(data), encoding="utf-8")
    q = Project.load(path)
    st = {e.id: e.status for e in q.edits}
    assert q.version == 2 and st["s1-u1"] == "accepted" and st["s1-u2"] == "rejected" and st["s1-r1"] == "accepted"


def test_timeline_splices_and_multi_range_cut(tmp_path, home):
    path = projects.new_episode("S", _files(tmp_path))["path"]
    p = Project.load(path)
    for s in p.sources:
        p.transcript[s.id] = [Word(w=f"w{k}", start=0.3 + 0.2 * k, end=0.45 + 0.2 * k) for k in range(4)]
    p.save(path)
    c = TestClient(create_app("k"), headers={"X-Holos-Token": "k"})
    tl = c.get("/api/projects/timeline", params={"path": path}).json()
    assert tl["splices"] and all(sp["edits"] and sp["episode_time"] >= 0 for sp in tl["splices"])
    n0 = len(tl["splices"])
    r = c.post("/api/projects/edit", json={"path": path, "op": "cuts", "snap": False, "ranges": [
        {"source": "s1", "start": 8.0, "end": 9.0}, {"source": "s2", "start": 0.1, "end": 0.25}]}).json()
    assert len(r["ids"]) == 2 and len(r["splices"]) >= n0 + 1 and r["history"]["undo_label"] == "Cut range"
    first = r["ids"][0]
    sp = next(x for x in r["splices"] if first in x["edits"])
    r = c.post("/api/projects/edit", json={"path": path, "op": "status", "ids": sp["edits"], "status": "rejected"}).json()
    assert not any(first in x["edits"] for x in r["splices"])
    lst = c.get("/api/projects/list").json()
    assert lst["projects"][0]["name"] == "S"
    a = c.put("/api/projects/automation", json={"path": path, "changes": {"kinds": {"unclear": "cut"}}}).json()
    assert a["automation"]["kinds"]["unclear"] == "cut" and a["automation"]["kinds"]["repeat"] == "cut"


def test_episode_job_and_template_preview(tmp_path, home):
    d = home / "templates" / "fake"
    d.mkdir(parents=True)
    (d / "make.py").write_text(r'''
import argparse, os, subprocess
ap = argparse.ArgumentParser(); ap.add_argument("--audio"); ap.add_argument("--out"); ap.add_argument("--preview", type=float, default=0)
a = ap.parse_args()
subprocess.run([os.environ["HOLOS_FFMPEG"], "-v", "error", "-y", "-f", "lavfi", "-i", f"color=green:s=64x36:d={a.preview or 2}",
                "-c:v", "libx264", a.out], check=True)
''', encoding="utf-8")
    (d / "template.json").write_text(json.dumps({"id": "fake", "name": "Fake", "entry": "make.py",
                                                 "args": {"audio": "--audio", "out": "--out", "preview": "--preview"}}))
    c = TestClient(create_app("k"), headers={"X-Holos-Token": "k"})
    job = c.post("/api/episodes", json={"name": "Job", "files": _files(tmp_path)}).json()
    for _ in range(600):
        st = c.get(f"/api/jobs/{job['id']}").json()
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["state"] == "done", st
    path = st["result"]["path"]
    r = c.post("/api/templates/preview", json={"path": path, "template": "fake", "seconds": 2}).json()
    assert r["video"].endswith(".mp4") and r["poster"].endswith(".jpg")
    v = c.get("/api/files/cache", params={"path": r["video"]})
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    assert c.get("/api/files/cache", params={"path": path}).status_code == 404       # only cache files
    again = c.post("/api/templates/preview", json={"path": path, "template": "fake", "seconds": 2}).json()
    assert again["key"] == r["key"]


def test_mcp_tools_edit_in_episode_time(tmp_path, home):
    from holos import chapters as C
    from holos import mcp_server as M
    path = projects.new_episode("M", _files(tmp_path))["path"]
    p = Project.load(path)
    for T_ in (0.5, 3.0, 9.0, 14.0):
        sid, t = C.episode_to_source(p, T_)
        from holos.edit import program_time
        assert abs(program_time(p, sid, t) - T_) < 1e-6
    L0 = C.episode_length(p)
    r = M.cut(path, "00:02.0", "00:03.0", snap_to_silence=False)
    assert r["cut_ids"] and abs(C.episode_length(Project.load(path)) - (L0 - 1.0 - p.timeline_settings.crossfade)) < 0.05
    spl = M.list_splices(path)
    assert any(r["cut_ids"][0] in s["edit_ids"] for s in spl)
    M.restore(path, r["cut_ids"])
    assert abs(C.episode_length(Project.load(path)) - L0) < 1e-6
    assert M.undo(path)["undone"] == "Keep"
    M.set_automation(path, {"clicks": "off"})
    assert M.get_automation(path)["clicks"] == "off"
    assert M.list_projects()[0]["name"] == "M"
    assert T.load_state()["mcp_last_seen"] > 0


def _wet_click(rng, sr, amp=0.012):
    """Damped 2.5 kHz ringing, ~4 ms — the shape of the saliva clicks marked in real recordings."""
    t = np.arange(int(0.006 * sr)) / sr
    return amp * np.sin(2 * np.pi * 2500 * t + rng.uniform(0, 6)) * np.exp(-t / 0.0012)


def _speechlike(rng, sr, sec, f0=130):
    t = np.arange(int(sec * sr)) / sr
    pulses = np.zeros(len(t))
    pulses[:: int(sr / f0)] = 1
    from scipy.signal import lfilter
    return lfilter([1], [1, -1.6, 0.8], pulses) * 0.08


def test_wet_clicks_in_pauses_are_replaced_with_room_sound():
    from holos.dsp import find_wet_clicks
    rng = np.random.default_rng(1)
    x = rng.standard_normal(SR * 4) * 0.0008                      # room
    x[: int(0.8 * SR)] += _speechlike(rng, SR, 0.8)                  # a phrase, then a pause
    x[int(3.0 * SR):] += _speechlike(rng, SR, 1.0)
    clicks = [1.30, 2.10, 2.75]
    for c in clicks:
        k = _wet_click(rng, SR)
        x[int(c * SR):int(c * SR) + len(k)] += k
    found = [a / SR for a, _ in find_wet_clicks(x, SR, "normal")]
    assert all(any(abs(f - c) < 0.004 for f in found) for c in clicks)
    assert not any(f < 0.8 or f > 3.0 for f in found)                 # nothing inside the speech
    log = {}
    y = mouthclick(x, {"strength": "normal"}, Context(sr=SR, log=log))
    assert len(y) == len(x) and log["mouthclick"]["wet"] == len(clicks)
    for c in clicks:
        i = int(c * SR)
        assert np.abs(y[i:i + int(0.006 * SR)]).max() < 0.004          # was ~0.012; room is ~0.003 peak
    # the speech is untouched
    assert np.array_equal(y[: int(0.7 * SR)], x[: int(0.7 * SR)])


def test_wet_click_detector_leaves_a_plosive_before_a_vowel():
    from holos.dsp import find_wet_clicks
    rng = np.random.default_rng(2)
    x = rng.standard_normal(SR * 3) * 0.0008
    burst = int(1.5 * SR)
    k = _wet_click(rng, SR, amp=0.02)                              # "т" / "к" release...
    x[burst:burst + len(k)] += k
    v = int(burst + 0.015 * SR)                                     # ...and the vowel 15 ms later
    x[v:v + int(0.5 * SR)] += _speechlike(rng, SR, 0.5)
    assert not [a for a, _ in find_wet_clicks(x, SR, "strong") if abs(a / SR - 1.5) < 0.01]


def test_analyze_again_keeps_hand_edits_and_waits_for_auto_edit(tmp_path, home):
    from holos import preview
    path = projects.new_episode("Analyze", _files(tmp_path, 1))["path"]
    p = Project.load(path)
    pause = next(e for e in p.edits if e.type == "pause" and e.status == "accepted")
    editing.set_status(p, path, [pause.id], "rejected")              # the user restores one pause
    ops.analyze_again(path)
    p = Project.load(path)
    kept = next(e for e in p.edits if e.id == pause.id)
    assert kept.status == "rejected" and kept.touched
    assert not [e for e in p.edits if e.type == "pause" and e.id != pause.id and e.start < kept.end and e.end > kept.start]
    assert any(e.status == "suggested" for e in p.edits if e.type == "pause")      # found, not applied yet
    assert editing.history_state(path)["undo_label"] == "Analyze"
    res = ops.auto_edit(path)
    p = Project.load(path)
    assert not any(e.status == "suggested" for e in p.edits if e.type in ("pause", "gain"))
    assert next(e for e in p.edits if e.id == pause.id).status == "rejected"
    assert all(preview.is_ready(path, p, s.id) for s in p.sources) and res["previews"] >= 0
    assert editing.history_state(path)["undo_label"] == "Auto-edit"


def test_result_copy_has_the_recording_timing_and_follows_edits(tmp_path, home):
    from holos import preview
    path = projects.new_episode("Preview", _files(tmp_path, 1))["path"]
    p = Project.load(path)
    sid = p.sources[0].id
    f = preview.ensure(p, path, sid)
    y, sr = sf.read(f)
    assert abs(len(y) / sr - p.source(sid).duration) < 0.01 and np.abs(y).max() < 1.0
    key = preview.preview_key(p, sid)
    pause = next(e for e in p.edits if e.type == "pause")
    editing.set_status(p, path, [pause.id], "rejected" if pause.status == "accepted" else "accepted")
    assert preview.preview_key(Project.load(path), sid) == key          # a cut does not change the sound
    p = Project.load(path)
    editing.set_automation(p, path, {"breaths": "off", "clicks": "off"})
    p = Project.load(path)
    assert preview.preview_key(p, sid) != key and not preview.is_ready(path, p, sid)
    f2 = preview.ensure(p, path, sid)
    assert f2.is_file() and not f.exists()                              # the old copy is cleaned up
    tl = TestClient(create_app(token=None)).get("/api/projects/timeline", params={"path": path}).json()
    assert tl["sources"][0]["preview"] == preview.preview_key(p, sid) and tl["sources"][0]["preview_ready"]
