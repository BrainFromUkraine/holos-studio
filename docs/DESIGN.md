# Design

Decisions agreed for the Holos Studio UI. The reference mockup (real data from the first episode)
lives in the project's design canvas; this file is the source of truth for the implementation.

## Principles

- **Automatic first.** Record, drop in the files, get an almost finished episode. The automation decides
  what is cut (pauses, mouth clicks, breaths, repeats, retakes) according to its settings; nothing waits for
  an answer. Every decision is visible in the editor and can be reverted.
- **Edit the audio, on a timeline.** Clips, splices, blade and range tools, markers. Speech recognition
  works under the hood (finding repeats and retakes, placing timecodes) and is not an editing surface.
- **A professional audio tool, not a web dashboard.** Dense layout, hairline separators, small type,
  tabular monospaced numbers, keyboard shortcuts on every action.
- **No rounded corners.** Buttons, panels, inputs, blocks, chips, markers: all square (`border-radius: 0`).
- **Black background.** Colour is used for meaning (waveform, cut, warning), not decoration.

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
| `core` | `#3FD17A` | waveform RMS core, live indicator |
| `loud` | `#22D3EE` | loudness curve |
| `accent` | `#FFFFFF` | primary actions (Play, Export), focus; text on it `#0A0B0A` |
| `question` | `#FFB020` | warnings, unprocessed projects, required fields |
| `cut` | `#FF4D4D` | removed audio: border; hatch `rgba(255,77,77,0.16)` / `0.03` |
| `cutBg` / `cutBorder` / `cutText` | `#2A1111` / `#6E2222` / `#FFA3A3` | cut blocks and the Cut button |
| `breath` | `#7A8A7F` | breath markers; block `#161B17` / `#33413A` / `#B4C4B9` |

Spectrogram: intensity heat map (like iZotope RX) `#000000 → #160a33 → #3b137a → #7a24b8 → #c2329e → #ff5e3a → #ffb43c → #fff6d8`,
80 dB range, mel frequency scale with grid lines and labels at 100 / 250 / 500 / 1k / 2k / 4k / 8k Hz and a −80…0 dB legend.

## Language

English by default, Ukrainian selectable in Settings (switches instantly). Text is written in English and translated
with `t()` (app/src/lib/i18n); terms: app/src/lib/i18n/GLOSSARY.md. Folder and file names the app creates are
always English (`Projects`, `Recordings`, `export`, `timecodes.txt`).

## Type

- UI: **IBM Plex Sans** 13 px (12 px dense lists, 14 px panel titles).
- Numbers, timecodes, parameters: **IBM Plex Mono**. Main timecode 20 px.

## Screens

1. **Start** — projects (waveform thumbnail, length, status: processing / ready / exported), search,
   drop zone for a new episode, open another project, projects folder.
2. **New project** — name (the episode number increments), destination folder, file table with per-stage
   progress (copy → analysis → speech recognition → cuts → view), language and glossary, a summary of
   the automation that will be applied. Recordings are copied to
   `Documents\Holos Studio\Projects\<episode>\Recordings`; the editor opens when processing finishes.
3. **Editor** — see below.
4. **Automation** — per project or as the default for new projects: pauses (longer than X → Y, crossfade),
   mouth clicks (off / light / normal / strong), breaths (soften / cut / off), which mistakes are cut
   (repeats, retakes, fillers) or kept (fragments, sounds, unclear speech), loudness preset, level match,
   drop-out fill, voice chain toggles. Changes re-apply immediately; hand edits are never overridden.
5. **Export** — audio only (WAV / MP3 with chapters) or video through a template with a live preview
   rendered from the episode; editable timecodes (or ask Claude via MCP); pre-export checks; files go to
   `export\` inside the project folder.
6. **Settings** — interface language (English by default, Ukrainian), step-by-step MCP setup with the ready
   configuration, folders, version.

## Editor layout

1. **Title bar**: logo / projects, project name with Editor · Export tabs, engine status, Claude (MCP) status, settings.
2. **Toolbar**: tools (Select A, Blade B, Range R), snap to silence, undo / redo, transport
   (start, ±5 s, play, loop), timecode, zoom, link to Automation.
3. **Automation summary strip**: counts of what was done automatically (repeats, retakes, fillers, pauses, breaths, drop-outs, mouth clicks), own cuts, length now vs recorded.
4. **Timeline** on the finished-episode axis, with track headers:
   ruler · markers (chapters; double-click or M to add, drag to move) · voice track (clips with the cuts
   already closed, waveform, labelled splices) · spectrum (heat map, toggle) · loudness (short-term curve,
   −16 LUFS target). Whole-episode overview strip underneath.
5. **Inspector** (right): for a splice — close-up of both sides, listen, restore, nudge each edge ±10 ms,
   move into silence; for a range — listen, cut; for a marker — rename, delete; otherwise — measured
   loudness (INT / LRA / TP) and a link to export.

Keyboard: Space play, A / B / R tools, M marker, L loop, Delete / C cut, ← / → previous / next splice,
Home / End, + / − zoom, Esc, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
