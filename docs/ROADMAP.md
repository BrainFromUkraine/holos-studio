# Roadmap

Status legend: ⬜ planned · 🟨 in progress · ✅ done

## Milestone 1 — Engine (CLI) ✅

Goal: master a real multi-file podcast episode end to end from the command line.

- ✅ Package layout, `pyproject.toml`, CLI entry point (`holos`)
- ✅ Project file model (`*.holos`) with load/save and validation
- ✅ Import: multiple source files, ordering, duplicate detection (hash)
- ✅ Analysis: VAD, breaths, pauses, room tone, gate drop-outs
- ✅ ASR: faster-whisper (CUDA) with word timestamps, cached per source — 18.6 min in 38 s on RTX 2060
- ✅ Detection: retakes across files, repeats / false starts, fillers, unclear speech
- ✅ Edit list → timeline rendering with crossfades
- ✅ Processing chain as modules (ported from the proven pipeline)
- ✅ Export WAV / MP3 + render report (LUFS, true peak, LRA, drop-outs)
- ✅ Tests on synthetic audio (no real recordings in the repo)

## Milestone 2 — App ✅

Design decisions: [DESIGN.md](DESIGN.md) — automatic first, pro audio-tool layout, studio-green palette, no rounded corners.

- ✅ Local engine API (`holos serve`): FastAPI on 127.0.0.1, token auth, job queue, SSE progress
- ✅ Full automatic pass: copy → analysis → speech recognition → cuts → editor view
- ✅ App: Next.js (static export) + Tauri v2 window, studio-green theme, IBM Plex
- ✅ Start screen with projects; project folders with copied recordings
- ✅ New project: drag & drop, per-file progress, language and glossary
- ✅ Automation instead of questions: settings decide what is cut, hand edits are never overridden
- ✅ Automation screen: pauses X → Y, mouth clicks, breaths, repeats / retakes / fillers, loudness, voice chain
- ✅ Mouth-click removal (detects and repairs short high-frequency clicks without changing timing)
- ✅ Editor: finished-episode track with closed cuts, labelled splices, blade / range ripple cuts, chapter markers,
  spectrogram, loudness curve, whole-episode overview
- ✅ Every splice can be listened to, restored, nudged or snapped to silence; undo / redo kept next to the project
- ✅ Playback of the finished episode (removed parts skipped)
- ✅ Export: audio (WAV / MP3 with chapters) or video through a template with a live preview; editable timecodes
- ✅ Export templates (plugins): video through your own script — [TEMPLATES.md](TEMPLATES.md)
- ⬜ Loudness presets (podcast / YouTube / broadcast), FLAC, cover art and metadata

## Milestone 3 — Desktop app 🟨

Details: [RELEASING.md](RELEASING.md).

- ✅ Tauri v2 shell manages the engine: Python environment created on first run with uv (progress screen), engine started hidden with a per-launch token, killed with the app
- ✅ Windows installer (NSIS, per-user, Ukrainian / English) built and published by GitHub Actions
- ✅ Auto-update from GitHub Releases (signed), one click
- ✅ Claude Desktop MCP config for the installed engine
- ⬜ GPU detection with CPU fallback, model download manager

## Milestone 4 — MCP ✅

- ✅ MCP server with 17 tools: projects, transcript, splices, cut / restore / adjust, undo / redo, automation,
  chapters, templates, export — [MCP.md](MCP.md)
- ✅ Shared undo history with the editor; the editor picks up Claude's changes live
- ✅ Ready configuration and step-by-step setup in the app's Settings

## Later

- Multi-speaker / multi-track (guests, remote recordings)
- Neural noise reduction (e.g. DeepFilterNet)
- Chapters, show notes and descriptions from the transcript (optional AI provider)
- Subtitles / transcripts export (SRT, VTT, TXT)
- Publishing helpers (RSS hosts, YouTube audio upload)
