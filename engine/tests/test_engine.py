"""Engine tests on synthetic audio only — no real recordings in the repo."""
import numpy as np
import pyloudnorm as pyln
import pytest
import soundfile as sf
from typer.testing import CliRunner

from holos.analysis.features import runs, vad_probs
from holos.cli import app
from holos.dsp import Context, deess, loudness, run_chain
from holos.edit import RoomTone, crossjoin
from holos.project import ChainStep, GainEdit, Project, natural_key
from holos.render import dropouts

SR = 48000
rng = np.random.default_rng(0)


def noise(sec, db=-30.0):
    return rng.standard_normal(int(sec * SR)) * 10 ** (db / 20)


def test_runs():
    assert runs(np.array([0, 1, 1, 0, 1], bool)) == [(1, 3), (4, 5)]
    assert runs(np.zeros(3, bool)) == []


def test_natural_sort():
    names = ["POD00100.WAV", "POD00008.WAV", "POD00014.WAV"]
    assert sorted(names, key=natural_key) == ["POD00008.WAV", "POD00014.WAV", "POD00100.WAV"]


def test_project_roundtrip(tmp_path):
    p = Project(name="t")
    p.edits.append(GainEdit(id="s1-b1", source="s1", start=1.0, end=1.3, db=-12))
    p.save(tmp_path / "t.holos")
    q = Project.load(tmp_path / "t.holos")
    assert q.edits[0].type == "gain" and q.edits[0].status == "suggested"
    assert q.set_status("accepted", types={"gain"}) == 1
    assert [c.module for c in q.chain][-1] == "loudness"


def test_crossjoin_length_and_level():
    a, b = np.ones(1000), np.ones(1000)
    y = crossjoin(a, b, 100)
    assert len(y) == 1900
    assert y.max() <= np.sqrt(2) + 1e-9 and y.min() > 0.99   # equal power: no dip


def test_roomtone_length():
    rt = RoomTone([noise(0.3, -70), noise(0.4, -70)], SR, 0.04)
    assert len(rt.take(2.0)) == 2 * SR
    assert len(RoomTone([], SR, 0.04).take(0.5)) == SR // 2


def test_dropouts_found():
    x = noise(5, -60)
    x[2 * SR: int(2.1 * SR)] = 0.0
    d = dropouts(x, SR, skip_tail_s=0)
    assert len(d) == 1 and abs(d[0]["t"] - 2.0) < 0.02 and d[0]["ms"] >= 90


def test_deess_keeps_length_and_low_tone():
    t = np.arange(3 * SR) / SR
    x = 0.1 * np.sin(2 * np.pi * 200 * t)
    y = deess(x, {}, Context(sr=SR))
    assert len(y) == len(x)
    assert np.max(np.abs(y[SR:-SR] - x[SR:-SR])) < 1e-3


def test_loudness_hits_target():
    x = noise(10, -35)
    y = loudness(x, {"target_lufs": -16.0, "ceiling_db": -2.0}, Context(sr=SR, channels=2))
    lu = pyln.Meter(SR).integrated_loudness(np.stack([y, y], 1))
    assert abs(lu - (-16.0)) < 0.5
    assert np.max(np.abs(y)) < 10 ** (-1.5 / 20)


def test_ffmpeg_chain_preserves_length():
    x = noise(2, -25)
    chain = [ChainStep(module="highpass"), ChainStep(module="declick"),
             ChainStep(module="eq", params={"bands": [{"freq": 1000, "gain": 3}]}),
             ChainStep(module="compressor")]
    assert len(run_chain(x, chain, Context(sr=SR))) == len(x)


def test_vad_runs():
    p = vad_probs(noise(2, -40), SR)
    assert len(p) == int(2 * 16000) // 512 and np.all((p >= 0) & (p <= 1))


def test_cli_new_sorts_and_dedupes(tmp_path):
    a = noise(1, -30)
    for name, sig in [("POD00014.WAV", a), ("POD00008.WAV", noise(1, -30)), ("POD00099_copy.WAV", a)]:
        sf.write(tmp_path / name, np.stack([sig, sig], 1), SR, subtype="PCM_24")
    files = [str(tmp_path / n) for n in ("POD00014.WAV", "POD00099_copy.WAV", "POD00008.WAV")]
    r = CliRunner().invoke(app, ["new", str(tmp_path / "p.holos"), *files])
    assert r.exit_code == 0, r.output
    p = Project.load(tmp_path / "p.holos")
    assert len(p.sources) == 2
    assert p.sources[0].path.endswith("POD00008.WAV")
    assert p.sources[1].path.endswith("POD00014.WAV")   # later copy skipped as duplicate


def test_asr_cache_and_prompt(tmp_path):
    from holos.asr import build_prompt, transcribe_sources
    from holos.project import AsrSettings, Word
    calls = []

    def fake(path, settings):
        calls.append(path)
        return [Word(w="Привіт", start=0.1, end=0.4, p=0.9), Word(w="ESP32.", start=0.5, end=0.9)], \
            {"audio_s": 1.0, "seconds": 0.1, "model": settings.model}

    s = AsrSettings(glossary=["ESP32", "LoRa"])
    assert "ESP32" in build_prompt(s) and "еее" in build_prompt(s)
    items = [("s1", "a.wav", "ab" * 32)]
    r1 = transcribe_sources(items, s, tmp_path, transcriber_factory=lambda: fake)
    r2 = transcribe_sources(items, s, tmp_path, transcriber_factory=lambda: fake)
    assert len(calls) == 1 and r2["s1"][1]["cached"] and r2["s1"][0][1].w == "ESP32."
    s.glossary = ["KiCad"]                       # different settings → new cache entry
    transcribe_sources(items, s, tmp_path, transcriber_factory=lambda: fake)
    assert len(calls) == 2


def test_cli_transcript_output(tmp_path):
    from holos.project import Source, Word
    p = Project(name="t")
    p.sources.append(Source(id="s1", path=str(tmp_path / "POD1.WAV"), sha256="x", sr=SR, channels=2, duration=3))
    p.transcript["s1"] = [Word(w="Привіт.", start=1.0, end=1.4), Word(w="Як", start=61.5, end=61.7), Word(w="справи?", start=61.7, end=62.0)]
    p.save(tmp_path / "t.holos")
    r = CliRunner().invoke(app, ["transcript", str(tmp_path / "t.holos")])
    assert r.exit_code == 0 and "[00:01.00] Привіт." in r.output and "[01:01.50] Як справи?" in r.output
