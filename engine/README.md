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

The app does all of this for you; the CLI is the same engine without the UI.

```bash
# 1. create a project from recordings (sorted by file name, duplicates skipped by content hash)
uv run holos new episode.holos D:/rec/*.WAV

# 2. full automatic pass: analysis → speech recognition → repeats / retakes / fillers
uv run holos process episode.holos

# 3. look at what was done and change single decisions
uv run holos info episode.holos
uv run holos edits episode.holos --type pause
uv run holos reject episode.holos s15-p4

# 4. deliverables into the project's export folder: WAV / MP3 with chapters, YouTube timecodes, video
uv run holos export episode.holos
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

## Automatic editing

`analyze` and `suggest` (both part of `process`) record every candidate; the project's automation settings
decide what is cut. Edits changed by hand (`accept` / `reject`, the editor, Claude) are never overridden.

| kind | what it finds | default |
|---|---|---|
| `pause` | silence longer than X — shortened to Y | 0.9 s → 0.7 s |
| `breath` | breaths between phrases | −12 dB (or cut / off) |
| mouth clicks | short high-frequency clicks, repaired in place | normal |
| `retake` | the end of a file is redone at the start of the next one — the earlier attempt | cut |
| `repeat` | a phrase is abandoned and restarted inside a file | cut |
| `filler` | transcribed "еее", "ммм", "хм" | cut |
| `fragment` | a broken-off word ("фа…") | keep |
| `unclear` | several low-confidence words in a row | keep |
| `sound` | voiced, spectrally steady sound with no word (an untranscribed "еее") | keep |

Cut points are snapped to the quietest sustained spot within ±0.25 s of the word boundary, so cuts land in pauses.

`render` writes `<name>.wav`, `<name>.mp3` and `<name>_report.json` (integrated loudness, true peak,
LRA, drop-outs, where every edit landed in the output timeline).

## Default processing chain

| Step | What it does |
|---|---|
| level match | each source to -20 LUFS before dynamics |
| breaths | −12 dB with 20 ms ramps |
| pauses | longer than 0.9 s → 0.7 s, cut from the middle with crossfade |
| drop-outs | gate holes filled with the recording's own room tone |
| joins | files back to back; the pause at a join is the recordings' own silence, as long as the pause target |
| highpass | 75 Hz, 4th order |
| mouth clicks | high-band click repair (off / light / normal / strong) |
| declick | FFmpeg `adeclick` |
| eq | −2 dB @ 350 Hz, +2 dB @ 3.2 kHz |
| deess | STFT dynamic EQ above ~4 kHz |
| compressor | two-stage voice preset |
| loudness | −16 LUFS (stereo), oversampled limiter at −2 dBFS |

Every value lives in the project file (`automation`, `chain`) and can be changed per project — in the app on the Automation screen.

## Tests

```bash
uv run pytest
```

Tests use synthetic audio only; real recordings never go into the repository.

## Third-party

- Silero VAD model (`src/holos/assets/silero_vad.onnx`) — MIT, © Silero Team, see `SILERO_VAD_LICENSE`.
