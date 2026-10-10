# Design

Decisions agreed for the Holos Studio UI. The reference mockup (real data from the first episode)
lives in the project's design canvas; this file is the source of truth for the implementation.

## Principles

- **Automatic first.** The app applies confident edits on its own; the user answers only the
  uncertain ones (listen ~3 s, then the **Cut** / **Keep** buttons; Y / N work as keyboard shortcuts). The transcript editor is a fallback for manual fixes,
  never the main workflow.
- **A professional audio tool, not a web dashboard.** Dense layout, hairline separators, small type,
  tabular monospaced numbers, keyboard shortcuts on every action.
- **No rounded corners.** Buttons, panels, inputs, blocks, chips, markers: all square (`border-radius: 0`).
- **Black background.** Colour is used for meaning (waveform, cut, question), not decoration.

## Palette — "Studio green"

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0A0B0A` | app background |
| `bar` | `#060706` | title bar, status bar |
| `lane` | `#080908` | track lanes, wells |
| `panel` | `#141614` | side panels, ruler, toolbar |
| `raised` | `#1B1E1B` | buttons, list items |
| `sel` | `#2A2E2A` | active tool / toggle |
| `selRow` | `#152A1C` | selected list row |
| `border` | `#262926` | 1 px separators |
| `dim` | `#3E423E` | minor ticks, dashed outlines |
| `text` | `#E5E7E5` | primary text |
| `text2` | `#AEB3AE` | secondary text |
| `bright` | `#F4F6F4` | headings, timecode, playhead |
| `muted` | `#8B8F8B` | labels, captions |
| `wave` | `#1B5E38` | waveform peaks |
| `core` | `#3FD17A` | waveform RMS core, loudness curve, live indicator |
| `accent` | `#FFFFFF` | primary actions (Play, Export), focus; text on it `#0A0B0A` |
| `question` | `#FFB020` | items waiting for the user |
| `cut` | `#FF4D4D` | removed audio: border; hatch `rgba(255,77,77,0.16)` / `0.03` |
| `cutBg` / `cutBorder` / `cutText` | `#2A1111` / `#6E2222` / `#FFA3A3` | cut blocks and the Cut button |
| `breath` | `#7A8A7F` | breath markers; block `#161B17` / `#33413A` / `#B4C4B9` |

Spectrogram colormap: `#080a08 → #0c1a10 → #11391f → #1f7a43 → #3fd17a → #b8f0c8 → #ffffff` (mel scale, 60 Hz–12 kHz).

## Type

- UI: **IBM Plex Sans** 13 px (12 px dense lists, 14 px panel titles).
- Numbers, timecodes, parameters: **IBM Plex Mono**. Main timecode 20 px.

## Editor layout (desktop, 1440 × 900 reference)

1. **Title bar** (38 px): logo, project, save state, AI/MCP status.
2. **Toolbar** (52 px): tools (Select V, Range R, Cut C, Zoom Z) · transport · timecode
   (episode time + source file time) · Original / Result A-B · zoom · INT / LRA / TP meters · Export.
3. **Edits panel** (left, ~290 px): tabs *Questions / Auto / All*, type filters with counts,
   rows = colour tick · timecode · type · text · status.
4. **Timeline** (centre):
   - episode overview: clip names, whole waveform, edit markers, breath ticks, viewport frame;
   - shared ruler; lanes with headers: **Voice** (peak + RMS waveform with cut / pause / breath overlays),
     **Spectrum**, **Words** (time-aligned; cut words struck through; low-confidence words dotted),
     **Edits** (labelled blocks), **Loudness** (short-term curve with the −16 LUFS target);
   - playhead across all lanes.
5. **Inspector** (right, ~320 px): selected edit — confidence, source, range, cut-point levels,
   crossfade, before / cut / after text, large **Cut** / **Keep** buttons (Y / N as shortcuts, shown in tooltips), nudge ±10 ms, snap to silence;
   below: the processing chain with per-module toggles and key parameters.
6. **Status bar** (26 px): format, ASR model and GPU, applied / open counts, engine version.

## Screens

1. **Import** — drop zone; file table (duration, format, loudness, per-file progress); processing steps
   (import → analysis → transcription → suggestions → processing) with overall progress; episode settings:
   language, glossary, loudness target, which edit types apply automatically.
2. **Overview** — the whole episode: clips, waveform, spectrum, edits (cuts, questions, pauses), breaths and
   drop-outs, loudness; right panel: questions with Cut / Keep buttons and the automatic summary.
3. **Editor (detail)** — the zoomed timeline described above.
4. **Export** — formats (WAV / MP3 / FLAC / M4A), loudness preset (podcast −16, YouTube −14, broadcast −23),
   transcript / SRT / chapters, metadata with artwork, auto-detected chapters, pre-export checks, destination.

Navigation between the three stages (Import · Editing · Export) lives in the title bar.
