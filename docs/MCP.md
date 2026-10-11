# Claude and other AI assistants (MCP)

Holos Studio includes an [MCP](https://modelcontextprotocol.io) server. An assistant connected to it can read an
episode's transcript and write chapters. The project file is the only thing it changes.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Recently opened projects |
| `get_episode` | Name, length after edits, words, open questions, chapters |
| `get_transcript` | Finished-episode transcript, one sentence per line with `[MM:SS]` |
| `get_chapters` | Chapters, YouTube timecode text, warnings |
| `set_chapters` | Replace chapters: `[{"time": "MM:SS", "title": "…"}]` |

Chapter times snap to the nearest word and stay attached to it, so later edits move them correctly.
The export screen picks up new chapters within a few seconds.

## Claude Desktop

Settings → Developer → Edit Config, then add (adjust the path):

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

With the installed app (no repository checkout) use the engine it created — see [RELEASING.md](RELEASING.md#claude-desktop-mcp-with-the-installed-app).

Restart Claude Desktop, then ask: *"Make chapters for my latest Holos episode."*

Any other MCP client: run `uv --directory <repo>/engine run holos mcp` over stdio.
