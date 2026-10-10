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
    p.edits = [e for e in p.edits if e.type not in ("gain", "pause", "fill")]   # keep cuts / suggestions
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
def transcribe(project: Path,
               model: Annotated[Optional[str], typer.Option(help="Whisper model, e.g. large-v3-turbo, large-v3.")] = None,
               language: Annotated[Optional[str], typer.Option(help="Language code, e.g. uk.")] = None,
               device: Annotated[Optional[str], typer.Option(help="auto | cuda | cpu")] = None,
               glossary: Annotated[Optional[str], typer.Option(
                   help="Comma-separated terms to spell correctly, e.g. 'ESP32, LoRa, KiCad'. Saved in the project.")] = None) -> None:
    """Transcribe every source with word timestamps (cached per audio content)."""
    from .asr import transcribe_sources
    p = Project.load(project)
    if model: p.asr.model = model
    if language: p.asr.language = language
    if device: p.asr.device = device  # type: ignore[assignment]
    if glossary is not None:
        p.asr.glossary = [g.strip() for g in glossary.split(",") if g.strip()]
    cache = project.parent / f"{project.stem}.holos-cache" / "asr"
    t0 = time.time()
    res = transcribe_sources([(s.id, s.path, s.sha256) for s in p.sources], p.asr, cache,
                             log=lambda m: _echo(f"  {m}"))
    for sid, (words, meta) in res.items():
        p.transcript[sid] = words
        p.transcript_meta[sid] = meta
    p.save(project)
    n = sum(len(w) for w, _ in res.values())
    audio = sum(s.duration for s in p.sources)
    _echo(f"Transcribed {len(res)} sources, {n} words, {audio / 60:.1f} min audio in {time.time() - t0:.0f}s")


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


AUTO_KINDS = {"retake", "repeat", "filler", "fragment", "sound", "unclear"}
RECOMMENDED = {"retake", "repeat", "filler"}          # pre-filled "y" in the review sheet


@app.command("suggest")
def suggest_cmd(project: Path,
                no_audio: Annotated[bool, typer.Option(help="Transcript only (skip the audio-based filler search).")] = False) -> None:
    """Find retakes, repeats, fillers and unclear speech; adds them as suggested cuts."""
    from .analysis.features import frame_features
    from .io import load_mono
    from .project import CutEdit
    from .suggest import suggest
    p = Project.load(project)
    if not p.transcript:
        raise typer.BadParameter("run `holos transcribe` first")
    frames, cache = {}, {}

    def audio(sid):
        if sid not in cache:
            cache.clear()
            cache[sid] = load_mono(p.source(sid).path)
        return cache[sid]

    if not no_audio:
        for s in p.sources:
            frames[s.id] = frame_features(*audio(s.id))
    new = suggest(p, frames, audio=None if no_audio else audio)
    # keep earlier decisions for the same suggestion
    old = {(e.source, e.kind, round(e.start, 1), round(e.end, 1)): e.status
           for e in p.edits if isinstance(e, CutEdit) and e.kind in AUTO_KINDS}
    for e in new:
        e.status = old.get((e.source, e.kind, round(e.start, 1), round(e.end, 1)), "suggested")
    p.edits = [e for e in p.edits if not (isinstance(e, CutEdit) and e.kind in AUTO_KINDS)] + new
    p.save(project)
    by = {}
    for e in new:
        by[e.kind] = by.get(e.kind, 0) + 1
    _echo(f"{len(new)} suggestions: " + (", ".join(f"{k} {v}" for k, v in sorted(by.items())) or "none"))


def _fmt(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


@app.command()
def review(project: Path,
           out: Annotated[Path, typer.Option("--out", "-o", help="CSV file (opens in Excel).")] = Path("review.csv")) -> None:
    """Write suggestions as a table: fill the `decision` column with y / n, then `holos review-apply`."""
    import csv
    from .edit import program_time, timeline_map
    from .project import CutEdit
    p = Project.load(project)
    tm = timeline_map(p)
    names = {s.id: Path(s.path).name for s in p.sources}
    rows = [e for e in p.edits if isinstance(e, CutEdit) and e.kind]
    rows.sort(key=lambda e: program_time(p, e.source, e.start, tm))
    with open(out, "w", newline="", encoding="utf-8-sig") as f:      # BOM: Excel shows Cyrillic correctly
        w = csv.writer(f)
        w.writerow(["id", "decision", "kind", "episode_time", "file", "file_time", "seconds",
                    "before", "cut", "after", "reason"])
        for e in rows:
            dec = {"accepted": "y", "rejected": "n"}.get(e.status, "y" if e.kind in RECOMMENDED else "")
            w.writerow([e.id, dec, e.kind, _fmt(program_time(p, e.source, e.start, tm)), names[e.source],
                        _fmt(e.start), round(e.end - e.start, 2), e.before, e.text, e.after, e.reason])
    _echo(f"Wrote {out}: {len(rows)} rows. Set decision to y (cut) / n (keep), save as CSV, then run review-apply.")


@app.command("review-apply")
def review_apply(project: Path, sheet: Path) -> None:
    """Read decisions from the review CSV: y = cut, n = keep, empty = undecided."""
    import csv
    p = Project.load(project)
    yes, no = {"y", "yes", "так", "т", "+", "1", "x"}, {"n", "no", "ні", "н", "-", "0"}
    with open(sheet, newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096); f.seek(0)
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")      # Excel may save with ';'
        decided = {r["id"]: (r.get("decision") or "").strip().lower() for r in csv.DictReader(f, dialect=dialect)}
    n_y = n_n = 0
    for e in p.edits:
        d = decided.get(e.id)
        if d in yes:
            e.status = "accepted"; n_y += 1
        elif d in no:
            e.status = "rejected"; n_n += 1
    p.save(project)
    _echo(f"cut {n_y}, keep {n_n}, undecided {len(decided) - n_y - n_n}")


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
