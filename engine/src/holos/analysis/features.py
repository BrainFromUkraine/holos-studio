"""Frame features and speech activity (Silero VAD, ONNX)."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

import numpy as np
from scipy.signal import resample_poly

HOP = 0.01   # feature hop, seconds
WIN = 0.03   # feature window, seconds
VAD_HOP = 512 / 16000


@lru_cache(maxsize=1)
def _vad_session():
    import onnxruntime as ort
    model = resources.files("holos.assets").joinpath("silero_vad.onnx").read_bytes()
    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    return ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])


def vad_probs(x: np.ndarray, sr: int) -> np.ndarray:
    """Speech probability every 32 ms (Silero VAD at 16 kHz)."""
    if sr % 16000 == 0:
        y = resample_poly(x, 1, sr // 16000)
    else:
        y = resample_poly(x, 16000, sr)
    y = y.astype(np.float32)
    s = _vad_session()
    state = np.zeros((2, 1, 128), np.float32)
    ctx = np.zeros(64, np.float32)
    sr_t = np.array(16000, dtype=np.int64)
    n = len(y) // 512
    out = np.empty(n, np.float32)
    for i in range(n):
        ch = y[i * 512:(i + 1) * 512]
        p, state = s.run(None, {"input": np.concatenate([ctx, ch])[None, :], "state": state, "sr": sr_t})
        ctx = ch[-64:]
        out[i] = p[0, 0]
    return out


@dataclass
class Frames:
    rms_db: np.ndarray    # level per frame
    flat: np.ndarray      # spectral flatness 300 Hz-10 kHz
    hi: np.ndarray        # energy share 1.5-8 kHz
    lo: np.ndarray        # energy share 80-500 Hz
    speech: np.ndarray    # VAD prob > 0.5, resampled to frame grid

    @property
    def n(self) -> int:
        return len(self.rms_db)


def frame_features(x: np.ndarray, sr: int, with_vad: bool = True, chunk_frames: int = 20000) -> Frames:
    hop, win = int(sr * HOP), int(sr * WIN)
    n = max(0, (len(x) - win) // hop)
    rms = np.empty(n); flat = np.empty(n); hi = np.empty(n); lo = np.empty(n)
    freqs = np.fft.rfftfreq(win, 1 / sr)
    band = (freqs > 300) & (freqs < 10000)
    k_hi = (freqs > 1500) & (freqs < 8000)
    k_lo = (freqs > 80) & (freqs < 500)
    k_all = (freqs > 80) & (freqs < 8000)
    w = np.hanning(win)
    for a in range(0, n, chunk_frames):          # chunked to bound memory
        b = min(n, a + chunk_frames)
        idx = np.arange(win)[None, :] + hop * np.arange(a, b)[:, None]
        fr = x[idx]
        rms[a:b] = 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-14)
        spec = np.abs(np.fft.rfft(fr * w, axis=1)) ** 2 + 1e-14
        sb = spec[:, band]
        flat[a:b] = np.exp(np.mean(np.log(sb), 1)) / np.mean(sb, 1)
        tot = spec[:, k_all].sum(1)
        hi[a:b] = spec[:, k_hi].sum(1) / tot
        lo[a:b] = spec[:, k_lo].sum(1) / tot
    if with_vad:
        vp = vad_probs(x, sr)
        t = np.arange(n) * HOP + WIN / 2
        v = np.interp(t, np.arange(len(vp)) * VAD_HOP + VAD_HOP / 2, vp) if len(vp) else np.zeros(n)
        speech = v > 0.5
    else:
        speech = np.zeros(n, bool)
    return Frames(rms, flat, hi, lo, speech)


def voicing(x: np.ndarray, sr: int, chunk_frames: int = 5000) -> np.ndarray:
    """Periodicity per HOP frame: the highest normalized autocorrelation at pitch lags (70-400 Hz) of the
    signal below 1 kHz. Voice is periodic (about 0.6-1), a breath is noise (about 0.2-0.4)."""
    from scipy.signal import butter, sosfiltfilt
    y = sosfiltfilt(butter(4, 1000, btype="lowpass", fs=sr, output="sos"), x)
    hop, win = int(sr * HOP), int(sr * 0.04)
    n = max(0, (len(y) - win) // hop)
    lo, hi = int(sr / 400), int(sr / 70)
    nfft = 1 << int(np.ceil(np.log2(2 * win)))
    w = np.hanning(win)
    out = np.zeros(n)
    for a in range(0, n, chunk_frames):
        b = min(n, a + chunk_frames)
        fr = y[np.arange(win)[None, :] + hop * np.arange(a, b)[:, None]]
        fr = (fr - fr.mean(1, keepdims=True)) * w
        ac = np.fft.irfft(np.abs(np.fft.rfft(fr, nfft, axis=1)) ** 2, axis=1)[:, :hi + 1]
        out[a:b] = ac[:, lo:hi + 1].max(1) / (ac[:, 0] + 1e-12)
    return out


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous True runs as (start, end) index pairs, end exclusive."""
    m = np.concatenate([[False], np.asarray(mask, bool), [False]])
    d = np.diff(m.astype(np.int8))
    return list(zip(np.where(d == 1)[0].tolist(), np.where(d == -1)[0].tolist()))
