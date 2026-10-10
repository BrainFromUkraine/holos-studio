# Export templates

A template turns the finished episode into something else — today: **video** for YouTube.
The engine renders the master, runs the template script, then replaces the script's audio track with the
stereo master and adds the chapters. A template only has to draw the picture.

## Where templates live

| Location | Purpose |
|---|---|
| `engine/src/holos/assets/templates/` | Built-in examples (shipped with Holos) |
| `~/Documents/Holos Studio/templates/<id>/` | Your own templates — not in the repo, never overwritten by updates |
| `$HOLOS_TEMPLATES` | Extra folders (separated by `;` on Windows, `:` elsewhere) |

`$HOLOS_HOME` moves the whole `Holos Studio` folder. A user template with the same `id` overrides a built-in one.
`holos templates` lists what the engine found and whether each one is ready.

## Folder layout

```
my-template/
  template.json      manifest (below)
  render.py          the script
  fonts/ …           anything the script needs
```

## Manifest

```json
{
  "id": "my-template",
  "name": "My show",
  "kind": "video",
  "description": "Shown in the export screen.",
  "entry": "render.py",
  "imports": ["numpy", "cv2", "PIL"],
  "install": "cd engine; uv sync --extra video",
  "args": {"audio": "--audio", "out": "--out", "preview": "--preview"},
  "params": [
    {"key": "photo", "label": "Photo", "type": "file", "arg": "--photo", "required": true, "filters": ["png", "jpg"]},
    {"key": "episode", "label": "Episode", "type": "int", "arg": "--episode", "required": true, "auto": "increment"},
    {"key": "layout", "label": "Layout", "type": "choice", "arg": "--layout", "default": "A",
     "options": [{"value": "A", "label": "A — circle"}, {"value": "C", "label": "C — bars"}]},
    {"key": "face_x", "label": "Face position", "type": "float", "arg": "--face-x", "default": 0.5, "min": 0, "max": 1, "step": 0.01},
    {"key": "progress", "label": "Progress bar", "type": "bool", "arg": "--progress", "default": false}
  ],
  "progress": {"regex": "^\\s*(\\d+) / (\\d+) s", "done": 1, "total": 2},
  "output": "mp4",
  "remux_audio": true
}
```

- **`params`** — the app draws the form from this list. Types: `file`, `int`, `float` (slider when `min`/`max` are set),
  `choice`, `bool` (a flag, passed only when on), `text`. `required` blocks export until filled.
  `"auto": "increment"` suggests the last used value + 1 for a new project (episode numbers).
- **`imports`** — Python modules the script needs; missing ones are reported with the `install` hint.
- **`args.preview`** — optional; enables the "15 s preview" button.
- **`progress`** — a regex applied to every output line; groups give seconds done / total.
- **`remux_audio`** — `true` (default): the script's audio is replaced by the 48 kHz stereo master (AAC 320k) and
  chapters are embedded. Set `false` if the script produces the final file itself.

## How the script is run

```
<engine python> -u render.py --audio <master.wav> --out <file.mp4> [--preview N] [params…]
```

- Working directory: the template folder. The engine's Python is used, so anything in `imports` must be installed
  in the engine environment (`uv sync --extra video` adds OpenCV and Pillow).
- `HOLOS_FFMPEG` holds the path to FFmpeg, and its folder is on `PATH`, so `ffmpeg` works as a command too.
- Exit code ≠ 0 or a missing output file fails the export; the last lines of output are shown to the user.

Start from the built-in example: `engine/src/holos/assets/templates/waveform/`.
