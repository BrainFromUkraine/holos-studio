"""`holos` command line."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Annotated, Optional

import typer

from . import __version__
from .project import Clip, Project, Source, natural_key, sha256_file

app = typer.Typer(add_completion=False, no_args_is_help=True,
                  help="Holos Studio engine — podcast analysis, editing and mastering.")

AUTO_ACCEPT = {"gain", "pause", "fill"}


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
    from .io import info
    if project.exists() and not force:
        raise typer.BadParameter(f"{project} exists (use --force)")
    ordered = files if keep_order else sorted(files, key=lambda f: natural_key(f.name))
    p = Project(name=name or project.stem)
    seen: dict[str, Path] = {}
    rates = set()
    for f in ordered:
        h = sha256_file(f)
        if h in seen:
            _echo(f"  skip duplicate: {f.name} (same as {seen[h].name})")
            continue
        seen[h] = f
        sr, ch, dur = info(str(f))
        rates.add(sr)
        sid = f"s{len(p.sources) + 1}"
        p.sources.append(Source(id=sid, path=str(f.resolve()), sha256=h, sr=sr, channels=ch, duration=round(dur, 3)))
        p.timeline.append(Clip(source=sid, start=0.0, end=round(dur, 3)))
    if len(rates) > 1:
        raise typer.BadParameter(f"mixed sample rates {sorted(rates)} are not supported yet")
    p.sample_rate = rates.pop() if rates else 48000
    p.save(project)
    total = sum(s.duration for s in p.sources)
    _echo(f"Created {project}: {len(p.sources)} sources, {total / 60:.1f} min, {p.sample_rate} Hz")


@app.command()
def analyze(project: Path,
            suggest_only: Annotated[bool, typer.Option(help="Leave all detections as suggestions.")] = False) -> None:
    """Measure every source and detect breaths, long pauses and gate drop-outs."""
    from .analysis import analyze_source
    from .io import load_mono
    p = Project.load(project)
    p.edits = [e for e in p.edits if not e.id.startswith(tuple(f"{s.id}-" for s in p.sources))]
    t0 = time.time()
    for s in p.sources:
        x, sr = load_mono(s.path)
        A, edits = analyze_source(x, sr, s.id, p.analysis_settings)
        if not suggest_only:
            for e in edits:
                if e.type in AUTO_ACCEPT:
                    e.status = "accepted"
        p.analysis[s.id] = A
        p.edits.extend(edits)
        counts = {t: sum(e.type == t for e in edits) for t in ("gain", "pause", "fill")}
        _echo(f"  {Path(s.path).name}: {A.loudness_lufs:.1f} LUFS, breaths {counts['gain']}, "
              f"pauses {counts['pause']}, drop-outs {counts['fill']}")
    p.save(project)
    _echo(f"Analyzed {len(p.sources)} sources in {time.time() - t0:.0f}s")


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


if __name__ == "__main__":
    app()
