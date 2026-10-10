"""Audio I/O and FFmpeg helpers."""
from __future__ import annotations

import os
import shutil
import subprocess
from functools import lru_cache

import numpy as np
import soundfile as sf


class FFmpegError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def ffmpeg_path() -> str:
    """FFmpeg executable: $HOLOS_FFMPEG, else the first `ffmpeg` on PATH."""
    p = os.environ.get("HOLOS_FFMPEG") or shutil.which("ffmpeg")
    if not p:
        raise FFmpegError("FFmpeg not found. Install it or set HOLOS_FFMPEG to ffmpeg's full path.")
    return p


def load_mono(path: str) -> tuple[np.ndarray, int]:
    """Read any soundfile-supported file as mono float64 (channel average)."""
    x, sr = sf.read(path, always_2d=True, dtype="float64")
    return x.mean(axis=1), sr


def info(path: str) -> tuple[int, int, float]:
    i = sf.info(path)
    return i.samplerate, i.channels, i.frames / i.samplerate


def ffmpeg_filter(x: np.ndarray, sr: int, af: str) -> np.ndarray:
    """Run a mono float signal through an FFmpeg audio filter graph (via pipes)."""
    cmd = [ffmpeg_path(), "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
           "-af", af, "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1"]
    r = subprocess.run(cmd, input=np.asarray(x, dtype="<f4").tobytes(), capture_output=True)
    if r.returncode != 0:
        raise FFmpegError(f"ffmpeg filter failed ({af}): {r.stderr.decode(errors='replace')[-500:]}")
    y = np.frombuffer(r.stdout, dtype="<f4").astype(np.float64)
    # filters keep length; guard against off-by-a-few from resampling filters
    if len(y) >= len(x):
        return y[: len(x)]
    return np.pad(y, (0, len(x) - len(y)))


def write_wav(path: str, x: np.ndarray, sr: int, bits: int = 24, channels: int = 2) -> None:
    sub = {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}[bits]
    data = np.stack([x] * channels, axis=1) if channels > 1 else x
    sf.write(path, data, sr, subtype=sub)


def encode_mp3(wav_path: str, mp3_path: str, kbps: int = 192) -> None:
    cmd = [ffmpeg_path(), "-v", "error", "-y", "-i", wav_path, "-c:a", "libmp3lame", "-b:a", f"{kbps}k", mp3_path]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise FFmpegError(r.stderr.decode(errors="replace")[-500:])


def ebur128(path: str) -> dict:
    """Integrated loudness, LRA and true peak as measured by FFmpeg's EBU R128 meter."""
    cmd = [ffmpeg_path(), "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True)
    text = r.stderr.decode(errors="replace")
    summary = text[text.rfind("Summary:"):]
    out = {}
    for line in summary.splitlines():
        line = line.strip()
        for key, name in (("I:", "integrated_lufs"), ("LRA:", "lra_lu"), ("Peak:", "true_peak_dbtp")):
            if line.startswith(key):
                try:
                    out[name] = float(line.split()[1])
                except (IndexError, ValueError):
                    pass
    return out
