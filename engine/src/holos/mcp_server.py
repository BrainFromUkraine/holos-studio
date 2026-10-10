"""MCP server: lets Claude (or another MCP client) read an episode and write its chapters.

Run by the MCP client over stdio:  uv --directory <repo>/engine run holos mcp
Tools work on `.holos` project files; recently opened projects are listed so the AI can find them.
"""
from __future__ import annotations

import re
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from . import chapters as C
from . import ops
from . import templates as T
from .project import Project

mcp = MCPServer(
    "holos-studio",
    title="Holos Studio",
    instructions=(
        "Holos Studio is a podcast editor. Episodes are .holos project files. "
        "To make chapters: call list_projects (or use the path the user gives), read get_transcript — every line "
        "starts with its timecode in the finished episode — choose topic boundaries, then call set_chapters. "
        "Chapter titles should be short (2–6 words) and in the episode's language. YouTube requires the first "
        "chapter at 00:00, at least 3 chapters and each at least 10 seconds long. Times snap to the nearest word "
        "and follow later edits automatically."
    ),
)


def _load(path: str) -> Project:
    if not Path(path).is_file():
        raise ValueError(f"project not found: {path}")
    return Project.load(path)


def parse_time(v: str | float | int) -> float:
    """Seconds from 75, "75.5", "01:15", "1:01:15"."""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    parts = s.split(":")
    if not 2 <= len(parts) <= 3 or not all(re.fullmatch(r"\d+(\.\d+)?", x) for x in parts):
        raise ValueError(f"bad time {v!r}: use seconds or MM:SS / H:MM:SS")
    sec = 0.0
    for x in parts:
        sec = sec * 60 + float(x)
    return sec


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def list_projects() -> list[dict]:
    """Recently opened Holos Studio projects (newest first): path, name and whether the file still exists."""
    return [{"path": p, "name": Path(p).stem, "exists": Path(p).is_file()} for p in T.recent_projects()]


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_episode(path: str) -> dict:
    """Overview of an episode: name, length after edits, number of transcribed words, open questions and chapters."""
    p = _load(path)
    s = ops.summary(p)
    return {"name": s["name"], "length_s": s["edited_s"], "sources": len(s["sources"]),
            "words": sum(x["words"] for x in s["sources"]), "open_questions": len(s["questions"]),
            "chapters": C.resolved(p)}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_transcript(path: str) -> str:
    """Transcript of the finished episode (after all edits), one sentence per line, each prefixed with its
    [MM:SS] timecode in the finished episode. Use these timecodes for set_chapters."""
    p = _load(path)
    text = C.transcript_text(p)
    if not text:
        raise ValueError("this project has no transcript yet — process it in Holos Studio first")
    return text


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_chapters(path: str) -> dict:
    """Current chapters (episode time in seconds), YouTube timecode text and rule warnings."""
    p = _load(path)
    rows = C.resolved(p)
    return {"chapters": rows, "youtube": C.youtube_text(rows), "warnings": C.check_youtube(rows)}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True))
def set_chapters(path: str, chapters: list[dict]) -> dict:
    """Replace all chapters. `chapters` = [{"time": "MM:SS" or seconds, "title": "..."}], times in the finished
    episode as shown by get_transcript. The first chapter is moved to 00:00. Returns the saved chapters,
    the YouTube timecode text and any warnings."""
    p = _load(path)
    items = [{"time": parse_time(c["time"]), "title": c["title"], "origin": "claude"} for c in chapters]
    C.set_chapters(p, items, origin="claude")
    p.save(path)
    rows = C.resolved(p)
    return {"saved": len(rows), "chapters": rows, "youtube": C.youtube_text(rows), "warnings": C.check_youtube(rows)}


def main() -> None:
    mcp.run()
