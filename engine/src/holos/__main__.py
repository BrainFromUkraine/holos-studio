"""`python -m holos …` — the same commands as the `holos` script.

Claude Desktop starts the MCP server this way (`python.exe -m holos mcp`): the venv's python.exe is never rewritten
by an engine update, unlike the `holos.exe` launcher, so an update can run while Claude Desktop is connected.
"""
from .cli import app

app()
