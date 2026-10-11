# Architecture (draft)

This document describes the intended design. It will change as the engine is built — treat it as a plan, not a spec.

## Overview

```
┌──────────────────────────── Tauri v2 desktop shell ───────────────────────────┐
│  Next.js UI (static export)                                                   │
│  transcript editor · waveform · processing panel · export                     │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (localhost, per-launch token)
┌───────────────┴──────────────────── engine (Python sidecar) ──────────────────┐
│  api/      FastAPI: projects, jobs, progress events                           │
│  asr/      faster-whisper (CUDA) → word-level timestamps                      │
│  edit/     edit list model, filler/repeat detection, timeline mapping         │
│  dsp/      analysis (VAD, breaths, pauses) + processing modules               │
│  render/   apply edit list + chain → WAV / MP3, loudness verification         │
│  mcp/      MCP server exposing the same operations as tools                   │
└───────────────────────────────────────────────────────────────────────────────┘
```

The engine is the product. The UI and the MCP server are two clients of the same operations, so anything the user can do in the UI, an AI assistant can do through MCP, and vice versa.

## Principles

1. **Non-destructive.** Source files are read-only. All edits live in the project file.
2. **Every automatic decision is reviewable.** Detection (fillers, breaths, pauses) produces *suggestions* with timecodes; applying them is a separate, undoable step.
3. **Measured, not guessed.** Each render is verified (integrated loudness, true peak, dropouts) and the report is stored with the project.
4. **Modular processing.** Each processing step is a module with a declared parameter schema; the chain is data, not code.
5. **Local first.** No network needed except optional model download and optional AI providers.

## Project file (`*.holos`, JSON)

```jsonc
{
  "version": 1,
  "sources": [
    { "id": "s1", "path": "D:/rec/POD00005.WAV", "sha256": "…", "sr": 48000, "channels": 2 }
  ],
  "timeline": [                      // ordered clips; a clip is a range of a source
    { "source": "s1", "in": 1.79, "out": 32.71 }
  ],
  "transcript": {                    // from ASR, word level, source-relative times
    "s1": [ { "w": "Привіт", "start": 1.82, "end": 2.10, "p": 0.97 } ]
  },
  "edits": [                         // user/AI decisions on top of the timeline
    { "type": "cut",   "source": "s1", "start": 12.40, "end": 12.71, "reason": "filler" },
    { "type": "gain",  "source": "s1", "start": 23.31, "end": 23.66, "db": -12, "reason": "breath" },
    { "type": "pause", "source": "s1", "start": 42.20, "end": 43.70, "target": 0.7 }
  ],
  "chain": [                         // processing modules in order, with parameters
    { "module": "level_match", "target_lufs": -20 },
    { "module": "highpass", "freq": 75 },
    { "module": "declick", "threshold": 6 },
    { "module": "eq", "bands": [ { "f": 350, "g": -2, "q": 1.2 }, { "f": 3200, "g": 2, "q": 1.3 } ] },
    { "module": "deess", "ratio": 3, "max_reduction": 8 },
    { "module": "compressor", "stages": "voice_default" },
    { "module": "loudness", "target_lufs": -16, "true_peak": -1.5 }
  ],
  "export": { "wav": { "bits": 24, "sr": 48000, "channels": 2 }, "mp3": { "kbps": 192 } }
}
```

## Processing chain (initial)

Ported from the pipeline already used to master a real episode:

| Step | Method |
|---|---|
| Speech detection | Silero VAD (ONNX) |
| Breath detection | non-speech frames with noise-like spectrum (flatness / high-band ratio), level window relative to speech and room tone |
| Breath handling | gain envelope, −12 dB default, 20 ms ramps, never into word onsets |
| Pause tightening | non-speech > 0.9 s shortened to 0.7 s, cut from the middle with equal-power crossfade |
| Gate drop-outs | holes well below room tone filled with captured room tone |
| Joins between files | room tone gap with crossfades |
| Clean-up | high-pass 75 Hz (4th order), de-click, gentle EQ |
| De-ess | STFT dynamic EQ above ~4.5 kHz, global threshold, chunked for long files |
| Dynamics | two-stage compression (RMS levelling + peak control) |
| Loudness | integrated loudness to target, oversampled limiter, verified with EBU R128 meter |

## ASR

- `faster-whisper` with CUDA (`large-v3` / `large-v3-turbo`), word timestamps, Ukrainian + English.
- Models downloaded on first run into a user cache directory, never into the repo.
- Filler / repeat detection runs on the word list (lexicon + timing heuristics), producing suggestions only.

## MCP server

Tools mirror engine operations, for example: `open_project`, `get_transcript`, `list_suggestions`, `apply_edits`, `set_chain_param`, `render`, `get_render_report`. Destructive or long operations require explicit confirmation from the client.

## Packaging

See [RELEASING.md](RELEASING.md).

- Windows NSIS installer (per-user) with the app, the engine *source*, `uv.exe` and `ffmpeg.exe`.
- On first launch the app runs `uv sync` into `%LOCALAPPDATA%\com.brainfromukraine.holos` (Python 3.12, CUDA wheels),
  then starts `holos serve` hidden on a free port with a random token (`app/src-tauri/src/engine.rs`).
- FFmpeg: a GPL "essentials" build (the bundled video template uses libx264); it is a separate executable with its
  licence shipped next to it.
- CUDA runtime: NVIDIA cuBLAS / cuDNN wheels from PyPI + the user's installed NVIDIA driver; CPU (int8) fallback when
  no GPU is present.
- Updates: Tauri updater, signed, from GitHub Releases.
