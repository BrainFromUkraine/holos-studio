# Roadmap

Status legend: ⬜ planned · 🟨 in progress · ✅ done

## Milestone 1 — Engine (CLI) 🟨

Goal: master a real multi-file podcast episode end to end from the command line.

- ✅ Package layout, `pyproject.toml`, CLI entry point (`holos`)
- ✅ Project file model (`*.holos`) with load/save and validation
- ✅ Import: multiple source files, ordering, duplicate detection (hash)
- ✅ Analysis: VAD, breaths, pauses, room tone, gate drop-outs
- ⬜ ASR: faster-whisper (CUDA) with word timestamps, cached per source
- ⬜ Suggestions: filler words, repeats / false starts, long pauses, breaths
- ✅ Edit list → timeline rendering with crossfades
- ✅ Processing chain as modules (ported from the proven pipeline)
- ✅ Export WAV / MP3 + render report (LUFS, true peak, LRA, drop-outs)
- ⬜ Review export: suggestions as a table (timecode, context, action)
- ✅ Tests on synthetic audio (no real recordings in the repo)

## Milestone 2 — UI

- ⬜ Next.js app: project view, transcript editor with word selection
- ⬜ Waveform with suggestion overlays (wavesurfer.js or custom canvas)
- ⬜ Accept / reject suggestions, undo/redo
- ⬜ Processing panel bound to module parameter schemas
- ⬜ Playback of the edited timeline, A/B with original

## Milestone 3 — Desktop app

- ⬜ Tauri v2 shell, engine as sidecar
- ⬜ Windows installer, GPU detection, model download manager

## Milestone 4 — MCP

- ⬜ MCP server over engine operations
- ⬜ Confirmation flow for destructive actions
- ⬜ Docs: connecting Claude Desktop / other MCP clients

## Later

- Multi-speaker / multi-track (guests, remote recordings)
- Neural noise reduction (e.g. DeepFilterNet)
- Chapters, show notes and descriptions from the transcript (optional AI provider)
- Subtitles / transcripts export (SRT, VTT, TXT)
- Publishing helpers (RSS hosts, YouTube audio upload)
