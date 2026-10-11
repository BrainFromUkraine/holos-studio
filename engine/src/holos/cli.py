"""`holos` command line."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Annotated, Optional

import typer

from . import __version__
from .project import Project

app = typer.Typer(add_completion=False, no_args_is_help=True,
                  help="Holos Studio engine — podcast analysis, editing and mastering.")

def _echo(msg: str) -> None:
    typer.echo(msg)


@app.callback(invoke_without_command=True)
def _main(version: Annotated[bool, typer.Option("--version", help="Show version and exit.")] = False) -> None:
    if version:
        _echo(f"holos-engine {__version__}")
        raise typer.Exit()


@app.command()
def new(project: Annotated[Path, typer.Argument(help="Project file to create (*.holos).")],
        files: Annotated[list[Path], typer.Argument(help="Source recordings, in any order.")],
        name: Annotated[Optional[str], typer.Option(help="Project name.")] = None,
        keep_order: Annotated[bool, typer.Option(help="Keep the given order instead of sorting by file name.")] = False,
        force: Annotated[bool, typer.Option(help="Overwrite an existing project file.")] = False) -> None:
    """Create a project from recordings (duplicates are skipped by content hash)."""
    from .ops import create_project
    if project.exists() and not force:
        raise typer.BadParameter(f"{project} exists (use --force)")
    try:
        p, skipped = create_project(project, files, name, keep_order)
    except ValueError as e:
        raise typer.BadParameter(str(e))
    for it in skipped:
        _echo(f"  skip duplicate: {it['name']} (same as {it['duplicate_of']})")
    total = sum(s.duration for s in p.sources)
    _echo(f"Created {project}: {len(p.sources)} sources, {total / 60:.1f} min, {p.sample_rate} Hz")


def _cli_progress(stage: str, done: int, total: int, detail: str) -> None:
    if detail and detail != "done":
        _echo(f"  {detail}")


@app.command()
def analyze(project: Path) -> None:
    """Measure every source and detect breaths, pauses and gate drop-outs (applied per the project's automation)."""
    from .ops import analyze_project
    p = Project.load(project)
    r = analyze_project(p, project, _cli_progress)
    _echo(f"Analyzed {len(p.sources)} sources in {r['seconds']:.0f}s: breaths {r['gain']}, "
          f"pauses {r['pause']}, drop-outs {r['fill']}")


@app.command()
def transcribe(project: Path,
               model: Annotated[Optional[str], typer.Option(help="Whisper model, e.g. large-v3-turbo, large-v3.")] = None,
               language: Annotated[Optional[str], typer.Option(help="Language code, e.g. uk.")] = None,
               device: Annotated[Optional[str], typer.Option(help="auto | cuda | cpu")] = None,
               glossary: Annotated[Optional[str], typer.Option(
                   help="Comma-separated terms to spell correctly, e.g. 'ESP32, LoRa, KiCad'. Saved in the project.")] = None) -> None:
    """Transcribe every source with word timestamps (cached per audio content)."""
    from .ops import transcribe_project
    p = Project.load(project)
    if model: p.asr.model = model
    if language: p.asr.language = language
    if device: p.asr.device = device  # type: ignore[assignment]
    if glossary is not None:
        p.asr.glossary = [g.strip() for g in glossary.split(",") if g.strip()]
    r = transcribe_project(p, project, _cli_progress)
    audio = sum(s.duration for s in p.sources)
    _echo(f"Transcribed {len(p.sources)} sources, {r['words']} words, {audio / 60:.1f} min audio in {r['seconds']:.0f}s")


@app.command()
def transcript(project: Path,
               out: Annotated[Optional[Path], typer.Option("--out", "-o", help="Write to a text file instead of the console.")] = None) -> None:
    """Readable transcript with per-source timecodes."""
    p = Project.load(project)
    lines = []
    for s in p.sources:
        words = p.transcript.get(s.id)
        if not words:
            continue
        lines.append(f"\n=== {Path(s.path).name} ===")
        line, t_line = [], None
        for w in words:
            if t_line is None:
                t_line = w.start
            if line and (w.w[:1] in "-',.:;!?…)%" or line[-1][-1:] in "-'(") and w.w[:1] != "–":
                line[-1] += w.w          # Whisper sub-word pieces: "ESP" "-32" → "ESP-32", "пам" "'яті"
            else:
                line.append(w.w)
            if w.w.endswith((".", "?", "!")) or len(line) >= 18:
                lines.append(f"[{int(t_line // 60):02d}:{t_line % 60:05.2f}] " + " ".join(line))
                line, t_line = [], None
        if line and t_line is not None:
            lines.append(f"[{int(t_line // 60):02d}:{t_line % 60:05.2f}] " + " ".join(line))
    text = "\n".join(lines).strip() + "\n"
    if out:
        out.write_text(text, encoding="utf-8")
        _echo(f"Wrote {out}")
    else:
        _echo(text)


@app.command("suggest")
def suggest_cmd(project: Path,
                no_audio: Annotated[bool, typer.Option(help="Transcript only (skip the audio-based filler search).")] = False) -> None:
    """Find retakes, repeats, fillers and unclear speech; the project's automation decides what is cut."""
    from .ops import suggest_project
    p = Project.load(project)
    if not p.transcript:
        raise typer.BadParameter("run `holos transcribe` first")
    r = suggest_project(p, project, use_audio=not no_audio)
    _echo(f"{r['total']} suggestions: " + (", ".join(f"{k} {v}" for k, v in sorted(r['by_kind'].items())) or "none")
          + f" · {r['applied']} applied")


@app.command()
def process(project: Path) -> None:
    """Full automatic pass: analyze → transcribe → suggest."""
    from .ops import process_project
    r = process_project(project, _cli_progress)
    _echo(str(r))


@app.command()
def serve(port: Annotated[int, typer.Option(help="Port on 127.0.0.1.")] = 8765,
          token: Annotated[Optional[str], typer.Option(help="Access token (default: random, printed).")] = None,
          dev: Annotated[bool, typer.Option(help="No token (local development only).")] = False) -> None:
    """Local API for the Holos Studio app (binds to 127.0.0.1 only)."""
    import secrets
    import uvicorn
    from .server import create_app
    tok = None if dev else (token or secrets.token_urlsafe(24))
    if tok:
        _echo(f"HOLOS_TOKEN={tok}")
    _echo(f"Holos engine API on http://127.0.0.1:{port}")
    uvicorn.run(create_app(tok), host="127.0.0.1", port=port, log_level="warning")


@app.command()
def edits(project: Path,
          type: Annotated[Optional[str], typer.Option("--type", help="gain | pause | fill | cut")] = None,
          status: Annotated[Optional[str], typer.Option(help="suggested | accepted | rejected")] = None) -> None:
    """List edits with source timecodes."""
    p = Project.load(project)
    names = {s.id: Path(s.path).name for s in p.sources}
    for e in p.edits:
        if (type and e.type != type) or (status and e.status != status):
            continue
        _echo(f"{e.id:10s} {e.type:6s} {e.status:9s} {names[e.source]:16s} {e.start:8.2f}-{e.end:8.2f}  {e.reason}")


def _set(project: Path, status: str, ids: Optional[list[str]], type: Optional[str]) -> None:
    if not ids and not type:
        raise typer.BadParameter("give edit ids or --type")
    p = Project.load(project)
    n = p.set_status(status, types={type} if type else None, ids=set(ids) if ids else None)  # type: ignore[arg-type]
    p.save(project)
    _echo(f"{status}: {n} edits")


@app.command()
def accept(project: Path, ids: Annotated[Optional[list[str]], typer.Argument()] = None,
           type: Annotated[Optional[str], typer.Option("--type")] = None) -> None:
    """Accept edits by id or by type."""
    _set(project, "accepted", ids, type)


@app.command()
def reject(project: Path, ids: Annotated[Optional[list[str]], typer.Argument()] = None,
           type: Annotated[Optional[str], typer.Option("--type")] = None) -> None:
    """Reject edits by id or by type."""
    _set(project, "rejected", ids, type)


@app.command()
def render(project: Path,
           out: Annotated[Path, typer.Option("--out", "-o", help="Output folder.")] = Path("renders"),
           name: Annotated[Optional[str], typer.Option(help="Output file base name.")] = None) -> None:
    """Assemble, process and export; prints the verification report."""
    from .render import render as do_render
    p = Project.load(project)
    missing = [s.id for s in p.sources if s.id not in p.analysis]
    if missing:
        raise typer.BadParameter(f"run `holos analyze` first (missing: {', '.join(missing)})")
    t0 = time.time()
    rep = do_render(p, out, name or p.name, progress=lambda s: _echo(f"  … {s}"))
    m = rep["measured"].get("wav") or rep["measured"].get("mp3", {})
    _echo(f"Rendered {rep['duration_s'] / 60:.2f} min in {time.time() - t0:.0f}s → {out}")
    _echo(f"  {m.get('integrated_lufs')} LUFS, true peak {m.get('true_peak_dbtp')} dBTP, LRA {m.get('lra_lu')} LU, "
          f"drop-outs {len(rep['dropouts'])}")


@app.command("info")
def info_cmd(project: Path) -> None:
    """Summary of a project."""
    p = Project.load(project)
    _echo(f"{p.name}: {len(p.sources)} sources, {p.sample_rate} Hz, analyzed {len(p.analysis)}/{len(p.sources)}")
    by = {}
    for e in p.edits:
        by.setdefault((e.type, e.status), 0)
        by[(e.type, e.status)] += 1
    for (t, st), n in sorted(by.items()):
        _echo(f"  {t:6s} {st:9s} {n}")
    _echo("  chain: " + " → ".join(c.module for c in p.chain if c.enabled))


@app.command("export")
def export_cmd(project: Path,
               out: Annotated[Optional[Path], typer.Option("--out", "-o", help="Output folder (default: export/ next to the project).")] = None,
               name: Annotated[Optional[str], typer.Option(help="Output file base name.")] = None,
               video: Annotated[Optional[str], typer.Option(help="Video template id (see `holos templates`).")] = None,
               param: Annotated[Optional[list[str]], typer.Option("--param", "-p", help="Template parameter key=value (repeatable).")] = None,
               preview: Annotated[float, typer.Option(help="Only a short video preview of N seconds.")] = 0,
               wav: Annotated[Optional[bool], typer.Option("--wav/--no-wav")] = None,
               mp3: Annotated[Optional[bool], typer.Option("--mp3/--no-mp3")] = None,
               timecodes: Annotated[Optional[bool], typer.Option("--timecodes/--no-timecodes", help="YouTube timecodes file.")] = None,
               embed_chapters: Annotated[Optional[bool], typer.Option("--embed-chapters/--no-embed-chapters")] = None) -> None:
    """Deliverables: WAV / MP3, YouTube timecodes, video through a template (chapters embedded)."""
    from .ops import export_project
    v = None
    if video:
        params = {}
        for kv in param or []:
            k, _, val = kv.partition("=")
            params[k.strip()] = val
        from . import templates as T
        m = T.get(video).manifest
        for pdef in m.params:                        # cast CLI strings to the declared types
            if pdef.key in params:
                raw = params[pdef.key]
                params[pdef.key] = {"int": int, "float": float}.get(pdef.type, str)(raw) if pdef.type != "bool" \
                    else raw.lower() in ("1", "true", "yes", "так")
        v = {"template": video, "params": params}
    t0 = time.time()
    r = export_project(project, out, name, wav, mp3, timecodes, embed_chapters, v, preview, _cli_progress)
    _echo(f"Done in {time.time() - t0:.0f}s → {r['out_dir']}")
    for k, f in r["files"].items():
        _echo(f"  {k:9s} {f}")
    for w in r["warnings"]:
        _echo(f"  ! {w}")


@app.command()
def templates() -> None:
    """Installed export templates."""
    from . import templates as T
    _echo(f"User templates: {T.home() / 'templates'}")
    for t in T.discover().values():
        m = t.manifest
        state = "ready" if not t.missing else f"needs {', '.join(t.missing)} ({m.install})"
        _echo(f"  {m.id:24s} {m.name} — {state}")
        for pdef in m.params:
            _echo(f"      {pdef.key:12s} {pdef.type:6s} {pdef.label}" + (" *" if pdef.required else ""))


@app.command()
def chapters(project: Path,
             set_: Annotated[Optional[Path], typer.Option("--set", help="Text file with lines 'MM:SS Title' to replace the chapters.")] = None) -> None:
    """Show chapters as YouTube timecodes, or replace them from a text file."""
    from . import chapters as C
    from .mcp_server import parse_time
    p = Project.load(project)
    if set_:
        items = []
        for line in set_.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            t, _, title = line.partition(" ")
            items.append({"time": parse_time(t), "title": title})
        C.set_chapters(p, items, origin="user")
        p.save(project)
    rows = C.resolved(p)
    _echo(C.youtube_text(rows).rstrip() or "(no chapters)")
    for w in C.check_youtube(rows):
        _echo(f"! {w}")


@app.command("mcp")
def mcp_cmd() -> None:
    """MCP server over stdio (for Claude Desktop and other MCP clients)."""
    from .mcp_server import main
    main()


if __name__ == "__main__":
    app()
