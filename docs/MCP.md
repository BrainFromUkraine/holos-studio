# Claude and other AI assistants (MCP)

Holos Studio includes an [MCP](https://modelcontextprotocol.io) server. An assistant connected to it can open your
episodes, read what was said, cut and restore audio, change the automation, write timecodes and start an export.
Every change it makes goes through the same undo history as your own: Ctrl+Z in the editor reverts it.
The editor picks up its changes within a few seconds.

## Connect Claude Desktop

1. Open Holos Studio → **Settings**. The **Claude (MCP)** block shows the configuration for your computer; press **Copy**.
2. Claude Desktop → Settings → Developer → **Edit Config** opens `claude_desktop_config.json`.
   Paste the configuration. If the file already has `mcpServers`, add only the `holos-studio` block inside it.
3. Save the file, quit Claude Desktop completely (including the tray icon) and start it again.
4. Check: ask Claude *"Show my projects in Holos"*. The Claude indicator in the Holos Studio title bar turns green.

Running from source, the configuration looks like this (adjust the path):

```json
{
  "mcpServers": {
    "holos-studio": {
      "command": "uv",
      "args": ["--directory", "C:\\Users\\you\\Documents\\holos-studio\\engine", "run", "holos", "mcp"]
    }
  }
}
```

With the installed app the **Settings** screen already shows the right configuration for it.

Any other MCP client: run `holos mcp` (or `uv --directory <repo>/engine run holos mcp`) over stdio.

## Tools

Times are in the finished episode (after cuts) as `MM:SS`, `H:MM:SS` or seconds.

| Tool | What it does |
|---|---|
| `list_projects` | Projects in the projects folder and recently opened ones |
| `new_episode` | Create a project from recordings and run the automatic pass (background job) |
| `job_status` | Progress and result of a background job |
| `get_episode` | Length before / after editing, what was cut automatically, automation, chapters |
| `get_transcript` | What was said, one sentence per line with `[MM:SS]`; optional start / end |
| `list_splices` | Every place where audio was removed: time, what and why, edit ids |
| `cut` | Remove a part of the episode; edges snap to the nearest silence |
| `restore` | Bring removed audio back (edit ids from `list_splices`) |
| `adjust_cut` | Move a cut's edges by milliseconds or snap them to silence |
| `undo` / `redo` | Shared history with the editor |
| `get_automation` / `set_automation` | Pause thresholds, breaths, mouth clicks, what kinds of mistakes are cut |
| `get_chapters` / `set_chapters` | Timecodes; they stay attached to the speech and follow later edits |
| `list_templates` | Video templates with their parameters |
| `export` | WAV / MP3 with chapters, YouTube timecodes and, with a template, video (background job) |

Edits you changed by hand are never overridden when Claude changes the automation.

## Examples

- *"Make timecodes for my latest Holos episode."*
- *"Pauses feel too short — make them up to 0.9 s."*
- *"Cut the part where I talk about the delivery, around 14:30."*
- *"Export the latest episode with the waveform template."*
