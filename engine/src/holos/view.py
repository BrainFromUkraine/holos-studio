"""Data for the editor screen: timeline layout, waveform peaks, heat-map spectrogram, loudness.

Everything heavy is computed per source once and cached next to the project
(`<project>.holos-cache/view/`), keyed by the source hash, so opening the editor again is instant.
"""
from __future__ import annotations

import json
import struct
import threading
import zlib
from pathlib import Path

import numpy as np

from .edit import timeline_map
from .project import CutEdit, GainEdit, PauseEdit, Project

PEAKS_RATE = 200            # min/max pairs per second
SPEC_PX_PER_S = 50          # spectrogram columns per second
SPEC_H = 160                # spectrogram rows (60 Hz – 12 kHz, mel spaced)
SPEC_FMIN, SPEC_FMAX = 60.0, 12000.0
SPEC_DB = (-100.0, -22.0)   # colour range after level matching
LOUD_HOP = 0.1              # short-term loudness step (s)
GAP_VIEW = 1.0              # gap between recordings in the "original" view (s)

# intensity heat map from docs/DESIGN.md (black → navy → blue → light blue → yellow → cream)
HEAT_STOPS = ["#08090a", "#0a1430", "#10327a", "#2a64d6", "#78a9ff", "#ffd43b", "#fff6c9"]


def view_dir(path: str | Path) -> Path:
    path = Path(path)
    d = path.parent / f"{path.stem}.holos-cache" / "view"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load(p: Project, sid: str) -> tuple[np.ndarray, int, float]:
    """Mono source with the level-match gain the renderer applies, so files look comparable."""
    from .io import load_mono
    s = p.source(sid)
    x, sr = load_mono(s.path)
    A = p.analysis.get(sid)
    g = (p.timeline_settings.level_match_lufs - A.loudness_lufs) if A else 0.0
    return x * 10 ** (g / 20), sr, g


# ---- timeline -----------------------------------------------------------------------------------
def edit_dict(e) -> dict:
    d = {"id": e.id, "type": e.type, "source": e.source, "start": e.start, "end": e.end, "status": e.status,
         "reason": e.reason, "kind": e.type}
    if isinstance(e, CutEdit):
        d.update(kind=e.kind or "manual", text=e.text, before=e.before, after=e.after)
    elif isinstance(e, GainEdit):
        d.update(db=e.db, kind="breath")
    elif isinstance(e, PauseEdit):
        d.update(target=e.target, kind="pause")
    elif e.type == "fill":
        d.update(kind="fill")
    return d


def timeline(p: Project, path: str | Path | None = None) -> dict:
    """Layout of the whole episode for the editor.

    Two time axes: the *original* view puts the recordings back to back (`offset`), the *result* view is the
    finished episode (`prog_start` + removals, same mapping the renderer uses).
    """
    from .chapters import episode_length, resolved
    from .edit import program_time
    ready = bool(p.sources) and len(p.analysis) == len(p.sources)
    tm = timeline_map(p) if ready else {}
    xf = p.timeline_settings.crossfade
    sources, off = [], 0.0
    for clip in p.timeline:
        s = p.source(clip.source)
        row = {"id": s.id, "name": Path(s.path).name, "duration": s.duration, "offset": round(off, 3),
               "sr": s.sr, "channels": s.channels}
        if path is not None and clip.source in p.analysis:
            from . import preview
            row["preview"] = preview.preview_key(p, clip.source)
            row["preview_ready"] = preview.is_ready(path, p, clip.source)
        if clip.source in tm:
            start, a0, b0, rem = tm[clip.source]
            row.update(prog_start=round(start, 4), a0=round(a0, 4), b0=round(b0, 4),
                       removals=[[round(a, 4), round(b, 4)] for a, b in rem])
        sources.append(row)
        off += s.duration + GAP_VIEW
    edits = []
    for e in p.edits:
        d = edit_dict(e)
        if e.source in tm:
            d["episode_time"] = round(program_time(p, e.source, e.start, tm), 3)
        edits.append(d)
    words = {sid: [[w.w, round(w.start, 3), round(w.end, 3), round(w.p, 3)] for w in ws] for sid, ws in p.transcript.items()}
    splices = []
    for clip in p.timeline:
        if clip.source not in tm:
            continue
        start, a0, b0, rem = tm[clip.source]
        for cs, ce in rem:
            ids = [e.id for e in p.edits if e.source == clip.source and e.status == "accepted"
                   and e.type in ("cut", "pause") and e.start < ce and e.end > cs]
            kinds = sorted({(getattr(e, "kind", "") or e.type) for e in p.edits if e.id in ids})
            splices.append({"source": clip.source, "start": round(cs, 4), "end": round(ce, 4),
                            "removed": round(ce - cs, 3), "edits": ids, "kinds": kinds,
                            "episode_time": round(program_time(p, clip.source, cs, tm), 3)})
    out = {"name": p.name, "sample_rate": p.sample_rate, "crossfade": xf, "gap_view": GAP_VIEW,
           "original_length": round(max(0.0, off - GAP_VIEW), 3),
           "length": round(episode_length(p), 3) if ready else None,
           "sources": sources, "edits": edits, "words": words, "splices": splices,
           "automation": p.automation.model_dump(), "chapters": resolved(p) if ready else [],
           "target_lufs": next((c.params.get("target_lufs") for c in p.chain if c.module == "loudness"), None),
           "chain": [{"module": c.module, "enabled": c.enabled, "params": c.params} for c in p.chain],
           "measured": None}
    if path is not None:
        from .ops import cache_dir, fingerprint
        rep = cache_dir(path) / "render" / "master_report.json"
        try:
            r = json.loads(rep.read_text(encoding="utf-8"))
            if r.get("fingerprint") == fingerprint(p):
                out["measured"] = (r.get("measured") or {}).get("wav")
        except (OSError, ValueError):
            pass
    return out


# ---- per-source analysis (cached) ---------------------------------------------------------------
def _cache(path: str | Path, p: Project, sid: str, kind: str) -> Path:
    return view_dir(path) / f"{p.source(sid).sha256[:16]}_{kind}"


_prep_lock = threading.Semaphore(2)     # bounds memory when the editor asks for many files at once


def _files(path, p: Project, sid: str) -> dict[str, Path]:
    return {"peaks": _cache(path, p, sid, f"peaks{PEAKS_RATE}.bin"),
            "spec": _cache(path, p, sid, f"spec{SPEC_PX_PER_S}x{SPEC_H}.png"),
            "loud": _cache(path, p, sid, "loud.json"),
            "rms": _cache(path, p, sid, "rms10.npy")}


def prepare(p: Project, path: str | Path, sid: str) -> dict[str, Path]:
    """Compute every missing view file of one source from a single read of the audio."""
    files = _files(path, p, sid)
    if all(f.is_file() for f in files.values()):
        return files
    with _prep_lock:
        if all(f.is_file() for f in files.values()):
            return files
        x, sr, g = _load(p, sid)
        if not files["peaks"].is_file():
            files["peaks"].write_bytes(_peaks(x, sr))
        if not files["spec"].is_file():
            files["spec"].write_bytes(_spectrogram(x, sr))
        if not files["loud"].is_file():
            files["loud"].write_text(json.dumps(_loudness(p, x, sr)))
        if not files["rms"].is_file():
            np.save(files["rms"], _rms(x * 10 ** (-g / 20), sr))
    return files


def peaks(p: Project, path: str | Path, sid: str) -> bytes:
    """Int8 min/max pairs at PEAKS_RATE per second (level-matched, ×127)."""
    return prepare(p, path, sid)["peaks"].read_bytes()


def spectrogram_png(p: Project, path: str | Path, sid: str) -> bytes:
    """Heat-map spectrogram: SPEC_PX_PER_S columns per second, mel-spaced 60 Hz–12 kHz, low frequencies at the bottom."""
    return prepare(p, path, sid)["spec"].read_bytes()


def loudness(p: Project, path: str | Path, sid: str) -> list[float]:
    """Short-term loudness (3 s, K-weighted) every LOUD_HOP s, shifted to the export target —
    an estimate of the finished episode's loudness before the chain runs."""
    return json.loads(prepare(p, path, sid)["loud"].read_text())


def rms_track(p: Project, path: str | Path, sid: str) -> np.ndarray:
    """10 ms RMS level in dB (raw source) — used to snap cut points to silence."""
    return np.load(prepare(p, path, sid)["rms"])


def _peaks(x: np.ndarray, sr: int) -> bytes:
    hop = sr // PEAKS_RATE
    n = len(x) // hop
    fr = x[: n * hop].reshape(n, hop)
    mm = np.stack([fr.min(1), fr.max(1)], 1)
    return np.clip(np.round(mm * 127), -127, 127).astype(np.int8).tobytes()


def _rms(x: np.ndarray, sr: int) -> np.ndarray:
    hop = int(sr * 0.01)
    win = 2 * hop
    n = max(0, (len(x) - win) // hop)
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    out = np.empty(n)
    for a in range(0, n, 20000):
        b = min(n, a + 20000)
        out[a:b] = 10 * np.log10(np.mean(x[idx[a:b]] ** 2, axis=1) + 1e-14)
    return out


def _heat_lut() -> np.ndarray:
    stops = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in HEAT_STOPS], float)
    pos = np.linspace(0, 1, len(stops))
    t = np.linspace(0, 1, 256)
    return np.stack([np.interp(t, pos, stops[:, c]) for c in range(3)], 1).astype(np.uint8)


def _png(rgb: np.ndarray) -> bytes:
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _spectrogram(x: np.ndarray, sr: int) -> bytes:
    nfft = 2048
    hop = max(1, sr // SPEC_PX_PER_S)
    n = max(1, (len(x) - nfft) // hop + 1)
    win = np.hanning(nfft)
    win_norm = win.sum() / 2
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    rows = 700 * (10 ** (np.linspace(mel(SPEC_FMIN), mel(min(SPEC_FMAX, sr / 2)), SPEC_H) / 2595) - 1)
    cols = np.empty((SPEC_H, n), np.float32)
    for a in range(0, n, 4000):
        b = min(n, a + 4000)
        idx = np.arange(nfft)[None, :] + hop * np.arange(a, b)[:, None]
        idx = np.minimum(idx, len(x) - 1)
        mag = np.abs(np.fft.rfft(x[idx] * win, axis=1)) / win_norm
        db = 20 * np.log10(mag + 1e-9)
        cols[:, a:b] = np.array([np.interp(rows, freqs, r) for r in db]).T
    lo, hi = SPEC_DB
    level = np.clip((cols - lo) / (hi - lo), 0, 1)
    rgb = _heat_lut()[(level[::-1] * 255).astype(np.uint8)]
    return _png(rgb)


def legend_png(width: int = 256, height: int = 8) -> bytes:
    lut = _heat_lut()[np.linspace(0, 255, width).astype(int)]
    return _png(np.repeat(lut[None, :, :], height, 0))


def _loudness(p: Project, x: np.ndarray, sr: int) -> list[float]:
    import pyloudnorm as pyln
    meter = pyln.Meter(sr)
    y = x.copy()
    for flt in meter._filters.values():        # BS.1770 K-weighting
        y = flt.apply_filter(y)
    win, hop = int(3.0 * sr), int(LOUD_HOP * sr)
    sq = np.concatenate([[0.0], np.cumsum(y ** 2)])
    out = []
    for c in range(0, len(y), hop):
        a, b = max(0, c - win // 2), min(len(y), c + win // 2)
        ms = (sq[b] - sq[a]) / max(1, b - a)
        out.append(round(float(-0.691 + 10 * np.log10(ms + 1e-14)), 2))
    target = next((c.params.get("target_lufs") for c in p.chain if c.module == "loudness"), -16.0)
    shift = float(target) - p.timeline_settings.level_match_lufs
    return [round(v + shift, 2) for v in out]
