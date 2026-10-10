# holos-engine

Python core of Holos Studio: analysis, editing, voice processing and rendering.

## Requirements

- [uv](https://docs.astral.sh/uv/) (installs Python 3.12 and all dependencies for you)
- [FFmpeg](https://ffmpeg.org) on `PATH`, or set `HOLOS_FFMPEG` to the full path of `ffmpeg`

## Setup

```bash
cd engine
uv sync
uv run holos --help
```

## Workflow

```bash
# 1. create a project from recordings (sorted by file name, duplicates skipped by content hash)
uv run holos new episode.holos D:/rec/*.WAV

# 2. analyze: loudness, room tone, breaths, long pauses, gate drop-outs
#    breaths / pauses / drop-outs are accepted automatically (use --suggest-only to review first)
uv run holos analyze episode.holos

# 3. review and change decisions
uv run holos edits episode.holos --type pause
uv run holos reject episode.holos s15-p4
uv run holos info episode.holos

# 4. render WAV + MP3 with a verification report
uv run holos render episode.holos -o renders
```

## Transcription (faster-whisper)

```bash
# once: speech recognition + NVIDIA CUDA 12 libraries (cuBLAS, cuDNN 9) as pip wheels
uv sync --extra asr --extra gpu

# word-level transcript of every source; the model downloads on first run (~1.6 GB)
uv run holos transcribe episode.holos --glossary "ESP32, LoRa, KiCad"
uv run holos transcript episode.holos -o transcript.txt
```

- Default model `large-v3-turbo`, language `uk`, GPU `float16` when CUDA is available, otherwise CPU `int8`.
- Results are cached in `<project>.holos-cache/asr/` per audio content and settings, so re-runs are instant.
- The glossary is saved in the project and passed to Whisper as a prompt, together with filler examples
  that nudge it to keep disfluencies ("еее", "ну") instead of cleaning them up.

## Suggestions and review

```bash
# retakes between files, restarts inside a file, filler words, unclear speech
uv run holos suggest episode.holos

# a table for Excel: fill `decision` with y (cut) / n (keep), save, apply
uv run holos review episode.holos -o review.csv
uv run holos review-apply episode.holos review.csv
uv run holos render episode.holos -o renders
```

| kind | what it finds | pre-filled |
|---|---|---|
| `retake` | the end of a file is redone at the start of the next one — the earlier attempt is cut | y |
| `repeat` | a phrase is abandoned and restarted inside a file | y |
| `filler` | transcribed "еее", "ммм", "хм" | y |
| `fragment` | a broken-off word ("фа…") | — |
| `unclear` | several low-confidence words in a row — listen first | — |
| `sound` | voiced, spectrally steady sound with no word (an untranscribed "еее") | — |

Cut points are snapped to the quietest sustained spot within ±0.25 s of the word boundary, so cuts land in pauses.
The `episode_time` column is computed from the current edit list without rendering.

`render` writes `<name>.wav`, `<name>.mp3` and `<name>_report.json` (integrated loudness, true peak,
LRA, drop-outs, where every edit landed in the output timeline).

## Default processing chain

| Step | What it does |
|---|---|
| level match | each source to -20 LUFS before dynamics |
| breaths | −12 dB with 20 ms ramps |
| pauses | longer than 0.9 s → 0.7 s, cut from the middle with crossfade |
| drop-outs | gate holes filled with the recording's own room tone |
| joins | 0.6 s room tone between files |
| highpass | 75 Hz, 4th order |
| declick | FFmpeg `adeclick` |
| eq | −2 dB @ 350 Hz, +2 dB @ 3.2 kHz |
| deess | STFT dynamic EQ above ~4 kHz |
| compressor | two-stage voice preset |
| loudness | −16 LUFS (stereo), oversampled limiter at −2 dBFS |

Every value lives in the project file (`analysis_settings`, `timeline_settings`, `chain`) and can be changed per project.

## Tests

```bash
uv run pytest
```

Tests use synthetic audio only; real recordings never go into the repository.

## Third-party

- Silero VAD model (`src/holos/assets/silero_vad.onnx`) — MIT, © Silero Team, see `SILERO_VAD_LICENSE`.
