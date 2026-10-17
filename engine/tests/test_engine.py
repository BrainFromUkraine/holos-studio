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
    p.transcript["s1"] = [Word(w="Привіт.", start=1.0, end=1.4), Word(w="Як", start=61.5, end=61.7), Word(w="справи?", start=61.7, end=62.0),
                        Word(w="ESP", start=63.0, end=63.2), Word(w="-32", start=63.2, end=63.5), Word(w="пам", start=63.6, end=63.8),
                        Word(w="'яті", start=63.8, end=64.0), Word(w="–", start=64.1, end=64.2), Word(w="2", start=64.3, end=64.4),
                        Word(w=",4.", start=64.4, end=64.6)]
    p.save(tmp_path / "t.holos")
    r = CliRunner().invoke(app, ["transcript", str(tmp_path / "t.holos")])
    assert r.exit_code == 0 and "[00:01.00] Привіт." in r.output and "[01:01.50] Як справи?" in r.output
    assert "ESP-32 пам'яті – 2,4." in r.output


def test_load_16k(tmp_path):
    from holos.asr import load_16k
    x = noise(1.5, -20)
    sf.write(tmp_path / "a.wav", np.stack([x, x], 1), SR, subtype="PCM_24")
    y = load_16k(str(tmp_path / "a.wav"))
    assert y.dtype == np.float32 and len(y) == 24000


def _words(text, t0=0.0, dur=0.3):
    from holos.project import Word
    return [Word(w=w, start=round(t0 + i * dur, 3), end=round(t0 + i * dur + dur * 0.8, 3)) for i, w in enumerate(text.split())]


def test_find_repeats_false_start_vs_normal_speech():
    from holos.suggest import find_repeats
    W = _words("підключається плату по USB І бачите спектр і фа... І фо... І бачите спектр і waterfall")
    r = find_repeats(W)
    assert len(r) == 1 and W[r[0][0]].w == "І" and W[r[0][1]].w == "І" and r[0][0] == 4 and r[0][1] == 11
    normal = _words("Pi 4 на 2 гігабайти коштує 67 доларів а Pi 5 на 2 гігабайти коштує 77 доларів")
    assert find_repeats(normal) == []


def test_find_retake_between_files():
    from holos.suggest import find_retake
    prev = _words("і поки тільки для Bluetooth LE. І на CrowdSupply з'явився QvsimBot1, OpenSource, робот червоно.")
    nxt = _words("А на CrowdSupply з'явився QV8BotOne – опенсорс робот четвероногий розміром із долоню.")
    i, m = find_retake(prev, nxt)
    assert prev[i].w == "І" and m >= 3
    assert find_retake(_words("зовсім інша тема тут"), nxt) is None


def test_units_are_not_fillers():
    from holos.suggest import FILLERS, norm
    assert norm("мм") not in FILLERS and norm("м,") not in FILLERS and norm("Еее,") in FILLERS


def test_snapper_finds_real_pause():
    from holos.analysis.features import Frames
    from holos.suggest import Snapper
    rms = np.full(200, -25.0)
    rms[118:122] = -45.0           # short consonant closure near the nominal boundary
    rms[140:150] = -70.0           # real pause 0.2 s later
    F = Frames(rms, *(np.zeros(200),) * 3, np.ones(200, bool))
    t = Snapper(F).between(1.18, 1.20)
    assert 1.40 <= t <= 1.50


def test_clip_plan_tail_cut_moves_end():
    from holos.edit import clip_plan, map_time
    from holos.project import Clip, CutEdit, SourceAnalysis
    A = SourceAnalysis(speech_on=1.0, speech_off=30.0, speech_level_db=-25, room_db=-75, loudness_lufs=-20)
    edits = [CutEdit(id="a", source="s1", start=10.0, end=12.0, status="accepted"),
             CutEdit(id="b", source="s1", start=25.0, end=40.0, status="accepted")]
    a0, b0, rem = clip_plan(Clip(source="s1", start=0, end=40), A, edits, 0.04, 40.0)
    assert a0 == pytest.approx(0.98) and b0 == 25.0 and rem == [(10.0, 12.0)]
    assert map_time(13.0, a0, rem, 0.04) == pytest.approx(13.0 - 0.98 - 2.0 - 0.04)


def test_find_retake_latin_vs_cyrillic_spelling():
    from holos.suggest import find_retake
    prev = _words("для bluetooth ли і на крауд саплай з 'явився кью вісім бот ван овпенсорс робот червоно")
    nxt = _words("А на CrowdSupply з 'явився QV8BotOne, open -source робот четвероногий розміром із долоню")
    r = find_retake(prev, nxt)
    assert r is not None and prev[r[0]].w in ("і", "на")


def test_find_retake_does_not_eat_previous_word():
    from holos.suggest import find_retake
    prev = _words("одна із найбільших виставок у світі. Це був тиждень електроніки на BrainFromUkraine. Якщо бачили")
    nxt = _words("Це був тиждень електроніки на BrainFromUkraine. Якщо бачили цікаву новину")
    i, _ = find_retake(prev, nxt)
    assert prev[i].w == "Це"


def _tone_file(path, sil_before, speech, sil_after):
    t = np.arange(int(speech * SR)) / SR
    x = np.concatenate([noise(sil_before, -70), 0.2 * np.sin(2 * np.pi * 220 * t), noise(sil_after, -70)])
    sf.write(path, x, SR)
    return len(x) / SR


def _two_file_project(tmp_path, after_first=1.5, before_second=1.0):
    from holos.project import Clip, Source, SourceAnalysis
    p = Project(name="join")
    for sid, (pre, post) in {"s1": (1.0, after_first), "s2": (before_second, 1.0)}.items():
        dur = _tone_file(tmp_path / f"{sid}.wav", pre, 2.0, post)
        p.sources.append(Source(id=sid, path=str(tmp_path / f"{sid}.wav"), sha256=sid, sr=SR, channels=1, duration=dur))
        p.analysis[sid] = SourceAnalysis(speech_on=pre, speech_off=pre + 2.0, speech_level_db=-14, room_db=-70,
                                         loudness_lufs=p.timeline_settings.level_match_lufs,
                                         room_tone=[(0.0, min(pre, 0.9))])
        p.timeline.append(Clip(source=sid, start=0.0, end=dur))
    return p


def _speech_gap(y, start_after):
    """Silence (s) between the end of the first tone and the start of the second, measured on the render."""
    from scipy.ndimage import maximum_filter1d
    loud = maximum_filter1d(np.abs(y), int(0.006 * SR)) > 0.05      # envelope, not single samples
    i0 = int(start_after * SR)
    end1 = i0 + np.argmin(loud[i0:])                 # first quiet sample after the first tone
    start2 = end1 + np.argmax(loud[end1:])           # next loud sample
    return (start2 - end1) / SR, start2 / SR


@pytest.mark.parametrize("target", [0.3, 0.7])
def test_recordings_join_back_to_back(tmp_path, target):
    from holos.edit import build_program, timeline_map
    p = _two_file_project(tmp_path)
    p.automation.pauses, p.automation.pause_target = True, target
    prog = build_program(p)
    gap, start2 = _speech_gap(prog.audio, p.timeline_settings.lead_in + 0.5)
    assert gap == pytest.approx(target, abs=0.02)
    # the editor / chapters mapping says the same as the renderer
    tm = timeline_map(p)
    assert dict(prog.clip_starts)["s2"] == pytest.approx(tm["s2"][0], abs=0.002)
    assert start2 == pytest.approx(tm["s2"][0] + (p.analysis["s2"].speech_on - tm["s2"][1]), abs=0.01)


def test_join_takes_missing_silence_from_the_next_recording(tmp_path):
    from holos.edit import build_program, edge_pads
    p = _two_file_project(tmp_path, after_first=0.1, before_second=1.0)   # first file stops right after the voice
    p.automation.pauses, p.automation.pause_target = True, 0.4
    (_, tail1), (lead2, _) = edge_pads(p)
    assert tail1 == pytest.approx(0.1, abs=1e-6) and lead2 > 0.3
    gap, _ = _speech_gap(build_program(p).audio, p.timeline_settings.lead_in + 0.5)
    assert gap == pytest.approx(0.4, abs=0.02)


def _voiced(sec, f0=140, amp=0.1):
    t = np.arange(int(sec * SR)) / SR
    return amp * np.sign(np.sin(2 * np.pi * f0 * t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t) ** 2)


def _breath(sec, amp=0.004):
    from scipy.signal import butter, sosfiltfilt
    b = sosfiltfilt(butter(2, [400, 5000], btype="bandpass", fs=SR, output="sos"), rng.standard_normal(int(sec * SR)))
    return amp * b / np.abs(b).max() * np.hanning(len(b)) ** 0.5


def test_quick_breath_between_phrases_is_found_without_vad():
    from holos.analysis import detect_breaths
    from holos.analysis.features import frame_features, voicing
    from holos.project import AnalysisSettings
    room = noise(3.0, -72)
    x = room.copy()
    x[int(0.3 * SR):int(1.3 * SR)] += _voiced(1.0)
    x[int(1.33 * SR):int(1.43 * SR)] += _breath(0.10)                # 100 ms breath, 30 ms after the phrase
    x[int(1.46 * SR):int(2.5 * SR)] += _voiced(1.04)
    F = frame_features(x, SR, with_vad=False)
    sp = float(np.median(F.rms_db[F.rms_db > -30]))
    edits = detect_breaths(F.rms_db, voicing(x, SR), "s1", 0.3, 2.5, sp, -72.0, AnalysisSettings())
    hit = [e for e in edits if e.start < 1.43 and e.end > 1.33]
    assert hit and all(e.start > 1.29 and e.end < 1.47 for e in hit)    # the breath, not the words around it
    assert not [e for e in edits if 0.4 < e.start < 1.25 or 1.5 < e.start < 2.4]


def test_removed_breath_is_replaced_with_room_tone(tmp_path):
    from holos.edit import build_program, timeline_map, map_time
    p = _two_file_project(tmp_path)
    x, _ = sf.read(tmp_path / "s1.wav")
    x[int(3.15 * SR):int(3.45 * SR)] += _breath(0.30, amp=0.01)
    sf.write(tmp_path / "s1.wav", x, SR)
    p.edits.append(GainEdit(id="s1-b1", source="s1", start=3.12, end=3.48, db=-12, status="accepted", room=True))
    y = build_program(p).audio
    start, a0, b0, rem = timeline_map(p)["s1"]
    t = start + map_time(3.2, a0, rem, p.timeline_settings.crossfade)
    seg = y[int(t * SR):int((t + 0.2) * SR)]
    lv = 10 * np.log10(np.mean(seg ** 2))
    assert lv < -60                                                   # the breath was ~-45 dB, the room -70


def test_refresh_breaths_keeps_hand_edits(tmp_path):
    from holos import ops
    from holos.analysis import BREATH_VERSION
    p = _two_file_project(tmp_path)
    p.analysis_settings.breath_version = 1
    p.edits.append(GainEdit(id="s1-b1", source="s1", start=0.2, end=0.5, db=-6, status="rejected", touched=True))
    p.edits.append(GainEdit(id="s1-b2", source="s1", start=3.5, end=3.9, db=-12, status="accepted"))
    ops.refresh_breaths(p)
    assert p.analysis_settings.breath_version == BREATH_VERSION
    assert any(e.id == "s1-b1" and e.touched and e.status == "rejected" for e in p.edits)
    assert len({e.id for e in p.edits}) == len(p.edits)
    assert ops.refresh_breaths(p) == 0                                # done once
