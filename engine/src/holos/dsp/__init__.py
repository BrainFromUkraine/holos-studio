"""Processing modules and the chain runner.

A module is either an FFmpeg filter (returns a filter string; consecutive FFmpeg
modules are merged into one graph) or a NumPy function on the mono program.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pyloudnorm as pyln
from scipy.signal import butter, istft, sosfiltfilt, stft

from ..io import ffmpeg_filter
from ..project import ChainStep


@dataclass
class Context:
    sr: int
    channels: int = 2           # export layout, used for loudness measurement
    log: dict | None = None


FFmpegModule = Callable[[dict, Context], str]
NumpyModule = Callable[[np.ndarray, dict, Context], np.ndarray]

FFMPEG_MODULES: dict[str, FFmpegModule] = {}
NUMPY_MODULES: dict[str, NumpyModule] = {}


def ffmpeg_module(name: str):
    def deco(f):
        FFMPEG_MODULES[name] = f
        return f
    return deco


def numpy_module(name: str):
    def deco(f):
        NUMPY_MODULES[name] = f
        return f
    return deco


def db2a(d: float) -> float:
    return 10 ** (d / 20)


# ---------------------------------------------------------------- FFmpeg modules
@ffmpeg_module("highpass")
def _highpass(p: dict, c: Context) -> str:
    f = float(p.get("freq", 75.0))
    stages = max(1, int(p.get("order", 4)) // 2)
    return ",".join([f"highpass=f={f}:p=2"] * stages)


@ffmpeg_module("declick")
def _declick(p: dict, c: Context) -> str:
    return f"adeclick=t={float(p.get('threshold', 6.0))}"


@ffmpeg_module("eq")
def _eq(p: dict, c: Context) -> str:
    bands = p.get("bands", [])
    return ",".join(f"equalizer=f={b['freq']}:t=o:w={b.get('width_oct', 1.0)}:g={b['gain']}" for b in bands) or "anull"


COMPRESSOR_PRESETS = {
    # two stages: RMS levelling, then fast peak control
    "voice": "acompressor=threshold=0.1:ratio=2.5:attack=10:release=120:knee=4:detection=rms,"
             "acompressor=threshold=0.25:ratio=4:attack=3:release=60:knee=2:detection=peak",
}


@ffmpeg_module("compressor")
def _compressor(p: dict, c: Context) -> str:
    return p.get("filter") or COMPRESSOR_PRESETS[p.get("preset", "voice")]


# ---------------------------------------------------------------- NumPy modules
def _sib_feats(seg: np.ndarray, sr: int):
    f, _, X = stft(seg, sr, nperseg=1024, noverlap=768)
    P = np.abs(X) ** 2
    Es = 10 * np.log10(P[(f >= 4500) & (f <= 12000)].sum(0) + 1e-14)
    Et = 10 * np.log10(P[(f >= 80) & (f <= 12000)].sum(0) + 1e-14)
    return f, X, Es, Et


@numpy_module("deess")
def deess(x: np.ndarray, p: dict, c: Context) -> np.ndarray:
    """STFT dynamic EQ above ~4 kHz. Global thresholds, chunked processing."""
    thr_pct = float(p.get("threshold_pct", 70.0))
    ratio = float(p.get("ratio", 3.0))
    max_red = float(p.get("max_reduction", 8.0))
    sr = c.sr
    x32 = np.asarray(x, dtype=np.float32)
    HOPS = 256
    C, pad = HOPS * 20000, HOPS * 64
    cf = pad // HOPS
    xp = np.pad(x32, (pad, pad + C))
    starts = range(0, len(x32), C)
    ES, ET = [], []
    for s in starts:
        _, _, Es, Et = _sib_feats(xp[s:s + C + 2 * pad], sr)
        ES.append(Es[cf:cf + C // HOPS]); ET.append(Et[cf:cf + C // HOPS])
    nreal = len(x32) // HOPS
    ES = np.concatenate(ES)[:nreal]; ET = np.concatenate(ET)[:nreal]
    loud_thr = np.percentile(ET, 40)
    sib_all = (ET > loud_thr) & (ES - ET > -6)
    thr = np.percentile(ES[sib_all], thr_pct) if sib_all.sum() > 20 else ES.max()
    out = np.zeros(len(starts) * C, np.float32)
    reduced, deepest = 0, 0.0
    for ci, s in enumerate(starts):
        f, X, Es, Et = _sib_feats(xp[s:s + C + 2 * pad], sr)
        sib = (Et > loud_thr) & (Es - Et > -6)
        g = np.where(sib, -np.clip((Es - thr) * (1 - 1 / ratio), 0, max_red), 0.0)
        sm = np.empty_like(g); cur = 0.0
        for k in range(len(g)):                     # fast attack, slower release
            cur = g[k] if g[k] < cur else cur + (g[k] - cur) * 0.35
            sm[k] = cur
        cen = sm[cf:cf + min(C, len(x32) - s) // HOPS]
        reduced += int((cen < -0.5).sum()); deepest = min(deepest, float(cen.min()) if len(cen) else 0.0)
        w = np.clip((f - 3500) / 1000, 0, 1)[:, None]
        X *= (1 + w * (10 ** (sm[None, :] / 20) - 1)).astype(np.float32)
        _, y = istft(X, sr, nperseg=1024, noverlap=768)
        out[ci * C:(ci + 1) * C] = y[pad:pad + C]
    if c.log is not None:
        c.log["deess"] = {"frames_reduced_pct": round(100 * reduced / max(1, nreal), 2),
                          "max_reduction_db": round(deepest, 2)}
    return out[:len(x32)].astype(np.float64)


@numpy_module("loudness")
def loudness(x: np.ndarray, p: dict, c: Context) -> np.ndarray:
    """Gain to integrated-loudness target, then an oversampled limiter."""
    target = float(p.get("target_lufs", -16.0))
    ceiling = float(p.get("ceiling_db", -2.0))
    meas = np.stack([x] * c.channels, 1) if c.channels > 1 else x
    lu = pyln.Meter(c.sr).integrated_loudness(meas)
    y = x * db2a(target - lu)
    up = 4 * c.sr
    y = ffmpeg_filter(y, c.sr, f"aresample={up},alimiter=limit={db2a(ceiling):.4f}:attack=1:release=50:level=false,"
                              f"aresample={c.sr}")
    if c.log is not None:
        c.log["loudness"] = {"pre_lufs": round(lu, 2), "gain_db": round(target - lu, 2)}
    return y


# mouth clicks / saliva: strength → (dB above the 30 ms median, dB above the loudest 2–12 ms on both sides, max ms)
MOUTHCLICK_STRENGTH = {"light": (20.0, 10.0, 2.0), "normal": (16.0, 7.0, 3.0), "strong": (12.0, 5.0, 4.0)}
_CLICK_HOP = 0.00025                                # analysis frame: 0.25 ms


def find_mouth_clicks(x: np.ndarray, sr: int, strength: str = "normal") -> list[tuple[int, int]]:
    """Mouth clicks are isolated ticks above 3 kHz: 0.5–3 ms long, far louder than the band's median level
    around them AND than the few milliseconds right before and after. Consonants and sibilants are longer
    and not isolated, so they are left alone. Returns sample ranges."""
    from scipy.ndimage import median_filter
    over_med, over_side, max_ms = MOUTHCLICK_STRENGTH.get(strength, MOUTHCLICK_STRENGTH["normal"])
    sos = butter(4, 3000, btype="highpass", fs=sr, output="sos")
    h = sosfiltfilt(sos, x)
    hop = max(1, int(_CLICK_HOP * sr))
    n = len(h) // hop
    if n < 200:
        return []
    E = (h[: n * hop] ** 2).reshape(n, hop).mean(1)
    short = np.convolve(E, np.ones(2) / 2, mode="same")                     # 0.5 ms
    med = median_filter(E, size=int(0.030 / _CLICK_HOP) | 1, mode="nearest") + 1e-14
    k0 = int(0.002 / _CLICK_HOP)
    idx = np.arange(n)
    # isolation: louder than the LOUDEST moment 2–12 ms on each side — glottal pulses of voiced speech
    # repeat every 4–10 ms with similar height, so they never pass; a lone mouth click does
    from scipy.ndimage import maximum_filter1d
    L = int(0.010 / _CLICK_HOP)
    mx = maximum_filter1d(short, size=L, mode="nearest")
    before = mx[np.clip(idx - k0 - L // 2, 0, n - 1)] + 1e-14
    after = mx[np.clip(idx + k0 + L // 2, 0, n - 1)] + 1e-14
    floor = 10 ** (-60 / 10)
    hit = (short > med * 10 ** (over_med / 10)) & (short > before * 10 ** (over_side / 10)) \
        & (short > after * 10 ** (over_side / 10)) & (short > floor)
    if not hit.any():
        return []
    d = np.diff(np.concatenate([[0], hit.astype(np.int8), [0]]))
    out: list[tuple[int, int]] = []
    for a, b in zip(np.where(d == 1)[0], np.where(d == -1)[0]):
        if out and a - out[-1][1] <= 4:                # merge ticks closer than 1 ms
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    max_len = max_ms / 1000 / _CLICK_HOP
    return [(a * hop, b * hop) for a, b in out if b - a <= max_len]


@numpy_module("mouthclick")
def mouthclick(x: np.ndarray, p: dict, c: Context) -> np.ndarray:
    """Remove mouth clicks by fading out only their high band (> 3 kHz) — the voice underneath stays,
    nothing is cut, the length does not change."""
    strength = p.get("strength", "normal")
    clicks = find_mouth_clicks(x, c.sr, strength)
    if clicks:
        sos = butter(4, 3000, btype="highpass", fs=c.sr, output="sos")
        y = x.copy()
        pad = int(0.0008 * c.sr)
        for a, b in clicks:
            a0, b0 = max(0, a - pad), min(len(x), b + pad)
            seg = x[max(0, a0 - 256):min(len(x), b0 + 256)]
            hp = sosfiltfilt(sos, seg)[a0 - max(0, a0 - 256):][: b0 - a0]
            w = np.hanning(b0 - a0 + 2)[1:-1] if b0 - a0 > 2 else np.ones(b0 - a0)
            y[a0:b0] -= hp * w
        x = y
    if c.log is not None:
        c.log["mouthclick"] = {"strength": strength, "clicks": len(clicks)}
    return x


# ---------------------------------------------------------------- runner
def run_chain(x: np.ndarray, chain: list[ChainStep], ctx: Context,
              progress: Callable[[str], None] | None = None) -> np.ndarray:
    pending: list[str] = []

    def flush(y: np.ndarray) -> np.ndarray:
        if pending:
            y = ffmpeg_filter(y, ctx.sr, ",".join(pending))
            pending.clear()
        return y

    for step in chain:
        if not step.enabled:
            continue
        if progress:
            progress(step.module)
        if step.module in FFMPEG_MODULES:
            pending.append(FFMPEG_MODULES[step.module](step.params, ctx))
        elif step.module in NUMPY_MODULES:
            x = flush(x)
            x = NUMPY_MODULES[step.module](x, step.params, ctx)
        else:
            raise KeyError(f"unknown module: {step.module}")
    return flush(x)
