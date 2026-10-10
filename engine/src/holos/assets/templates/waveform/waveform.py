#!/usr/bin/env python3
"""Example Holos Studio video template: waveform over a background.

Contract (see docs/TEMPLATES.md): the engine runs
    python waveform.py --audio master.wav --out video.mp4 [--preview SECONDS] [template params]
and reads progress lines "DONE / TOTAL s" from stdout. The engine replaces the audio track with the
master and adds chapters afterwards, so the script only has to get the picture right.
"""
import argparse
import os
import subprocess
import sys

import soundfile as sf

ap = argparse.ArgumentParser()
ap.add_argument("--audio", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--preview", type=float, default=0)
ap.add_argument("--background")
ap.add_argument("--color", default="22D3EE")
ap.add_argument("--height", type=int, default=320)
a = ap.parse_args()

ffmpeg = os.environ.get("HOLOS_FFMPEG", "ffmpeg")
W, H, FPS = 1920, 1080, 25
info = sf.info(a.audio)
dur = info.frames / info.samplerate
if a.preview:
    dur = min(dur, a.preview)

if a.background:
    bg = ["-loop", "1", "-framerate", str(FPS), "-i", a.background]
    scale = f"[1:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[bg]"
else:
    bg = ["-f", "lavfi", "-i", f"color=c=0x0B0D0B:s={W}x{H}:r={FPS}"]
    scale = "[1:v]setsar=1[bg]"
graph = (f"[0:a]aformat=channel_layouts=mono,showwaves=s={W - 240}x{a.height}:mode=cline:"
         f"colors=0x{a.color}:rate={FPS},format=rgba[w];{scale};"
         f"[bg][w]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]")
cmd = [ffmpeg, "-v", "error", "-y", "-i", a.audio, *bg, "-filter_complex", graph, "-map", "[v]", "-map", "0:a",
       "-t", f"{dur:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k",
       "-progress", "pipe:1", "-nostats", a.out]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
last = -5.0
for line in p.stdout:
    if line.startswith("out_time_us=") and line.strip()[12:].isdigit():
        t = int(line.strip()[12:]) / 1e6
        if t - last >= 5 or t >= dur:
            print(f"{t:.0f} / {dur:.0f} s", flush=True)
            last = t
sys.exit(p.wait())
