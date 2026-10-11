# Roadmap

Status legend: ⬜ planned · 🟨 in progress · ✅ done

## Milestone 1 — Engine (CLI) ✅

Goal: master a real multi-file podcast episode end to end from the command line.

- ✅ Package layout, `pyproject.toml`, CLI entry point (`holos`)
- ✅ Project file model (`*.holos`) with load/save and validation
- ✅ Import: multiple source files, ordering, duplicate detection (hash)
- ✅ Analysis: VAD, breaths, pauses, room tone, gate drop-outs
- ✅ ASR: faster-whisper (CUDA) with word timestamps, cached per source — 18.6 min in 38 s on RTX 2060
- ✅ Suggestions: retakes across files, repeats / false starts, fillers, unclear speech
- ✅ Edit list → timeline rendering with crossfades
- ✅ Processing chain as modules (ported from the proven pipeline)
- ✅ Export WAV / MP3 + render report (LUFS, true peak, LRA, drop-outs)
- ✅ Review export: suggestions as a table (timecode, context, action) + import of decisions
- ✅ Tests on synthetic audio (no real recordings in the repo)

## Milestone 2 — UI 🟨

Design decisions: [DESIGN.md](DESIGN.md) — automatic first, pro audio-tool layout, studio-green palette, no rounded corners.

- ✅ Local engine API (`holos serve`): FastAPI on 127.0.0.1, token auth, job queue, SSE progress
- ✅ Engine `process` pipeline: analyze → transcribe (skipped without ASR) → suggest, confident edits auto-applied
- ✅ App scaffold: Next.js (static export) + Tauri v2 window, studio-green theme, IBM Plex
- ✅ Import screen: drag & drop / file dialog, duplicates, settings (language, glossary, loudness, auto-apply), live progress
- ✅ No questions: automation decides (cut / keep per kind), everything visible and reversible in the editor
- ✅ Start screen with projects; project folders with copied recordings
- ✅ Automation screen: pauses X→Y, mouth clicks, breaths, repeats / retakes / fillers, loudness, voice chain
- ✅ Editor v2 like DaVinci Fairlight: finished-episode track, splices, blade / range ripple cuts, chapter markers
- ✅ Export v2: audio or video, live template preview rendered from the episode, editable timecodes
- ✅ Editor: whole-episode overview + zoomable lanes (clips, waveform, heat-map spectrogram, words, edits, breaths, loudness)
- ✅ Every edit visible and reversible; drag or nudge boundaries, snap to silence; own cuts from a waveform range or words
- ✅ Playback: result (removed parts skipped) / original; listen to an edit with 2 s around it
- ✅ Export screen: WAV / MP3, render job with progress, measured loudness, report
- ✅ Chapters: anchored to words (follow edits), YouTube timecodes file, embedded in MP3 (ID3) and MP4
- ✅ Export templates (plugins): video through your own script — [TEMPLATES.md](TEMPLATES.md)
- ⬜ Loudness presets (podcast / YouTube / broadcast), FLAC, cover art and metadata
- ✅ Undo / redo (history kept next to the project)

## Milestone 3 — Desktop app

- ⬜ Tauri v2 shell, engine as sidecar
- ⬜ Windows installer, GPU detection, model download manager

## Milestone 4 — MCP

- ✅ MCP server: transcript and chapters (`holos mcp`) — [MCP.md](MCP.md)
- ⬜ MCP server over the remaining engine operations
- ⬜ Confirmation flow for destructive actions
- ⬜ Docs: connecting Claude Desktop / other MCP clients

## Later

- Multi-speaker / multi-track (guests, remote recordings)
- Neural noise reduction (e.g. DeepFilterNet)
- Chapters, show notes and descriptions from the transcript (optional AI provider)
- Subtitles / transcripts export (SRT, VTT, TXT)
- Publishing helpers (RSS hosts, YouTube audio upload)
