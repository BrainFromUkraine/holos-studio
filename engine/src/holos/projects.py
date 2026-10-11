"""Project folders: `<HOLOS_HOME>/Проєкти/<episode name>/` with the project file, a copy of the recordings
(`Записи/`) and, after export, `export/`. Projects are self-contained: originals can be moved or deleted.
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from . import templates as T
from .ops import Progress, _noop, cache_dir, create_project, process_project, safe_name

RECORDINGS = "Записи"


def projects_root() -> Path:
    st = T.load_state()
    root = Path(st["projects_dir"]) if st.get("projects_dir") else T.home() / "Проєкти"
    return root


def set_projects_root(path: str) -> Path:
    st = T.load_state()
    st["projects_dir"] = str(Path(path))
    T._state_path().parent.mkdir(parents=True, exist_ok=True)
    T._state_path().write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    return projects_root()


def new_project_path(name: str, root: Path | None = None) -> Path:
    """A free folder for the episode: "Name", "Name (2)", … → <folder>/<Name>.holos"""
    root = root or projects_root()
    base = safe_name(name)
    folder, n = root / base, 1
    while folder.exists() and any(folder.iterdir()):
        n += 1
        folder = root / f"{base} ({n})"
    return folder / f"{base}.holos"


def copy_recordings(files: list[str], dest: Path, progress: Progress = _noop) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    total = sum(Path(f).stat().st_size for f in files) or 1
    done, out = 0, []
    for f in files:
        src = Path(f)
        target = dest / src.name
        k = 1
        while target.exists() and target.stat().st_size != src.stat().st_size:
            k += 1
            target = dest / f"{src.stem} ({k}){src.suffix}"
        if not target.exists():
            with open(src, "rb") as fi, open(target, "wb") as fo:
                while chunk := fi.read(8 << 20):
                    fo.write(chunk)
                    done += len(chunk)
                    progress("copy", int(done * 100 / total), 100, src.name)
            shutil.copystat(src, target)
        else:
            done += src.stat().st_size
        out.append(str(target))
    progress("copy", 100, 100, "done")
    return out


def new_episode(name: str, files: list[str], automation: dict | None = None, language: str | None = None,
                glossary: list[str] | None = None, path: str | None = None, progress: Progress = _noop) -> dict:
    """Create the folder, copy the recordings, create the project and run the full automatic pass."""
    from . import automation as A
    from .project import Project
    proj = Path(path) if path else new_project_path(name)
    progress("copy", 0, 100, "")
    copies = copy_recordings(files, proj.parent / RECORDINGS, progress)
    p, skipped = create_project(proj, copies, name)
    if language:
        p.asr.language = language
    if glossary is not None:
        p.asr.glossary = glossary
    if automation:
        A.update(p, dict(automation))
    else:
        default = T.load_state().get("automation")
        if default:
            A.update(p, dict(default))
    p.save(proj)
    T.touch_recent(str(proj))
    result = process_project(proj, progress)
    p = Project.load(proj)
    return {"path": str(proj), "skipped": [s["name"] for s in skipped], "result": result,
            "summary_counts": {k: v.get("accepted", 0) for k, v in _counts(p).items()}}


def _counts(p) -> dict:
    out: dict = {}
    for e in p.edits:
        k = getattr(e, "kind", "") or e.type
        out.setdefault(k, {}).setdefault(e.status, 0)
        out[k][e.status] += 1
    return out


def thumb(path: Path, bins: int = 120) -> list[int]:
    """Tiny waveform of the whole episode (0–100), from the editor's cached peaks."""
    from .project import Project
    from .view import _files
    f = cache_dir(path) / "view" / f"thumb{bins}.json"
    try:
        if f.is_file() and f.stat().st_mtime >= path.stat().st_mtime - 1:
            return json.loads(f.read_text())
    except OSError:
        pass
    try:
        p = Project.load(path)
        import numpy as np
        parts = []
        for s in p.sources:
            pf = _files(path, p, s.id)["peaks"]
            if not pf.is_file():
                return []
            d = np.frombuffer(pf.read_bytes(), np.int8).reshape(-1, 2)
            parts.append(np.maximum(-d[:, 0].astype(int), d[:, 1]))
        allp = np.concatenate(parts)
        out = [int(c.max() * 100 / 127) if len(c) else 0 for c in np.array_split(allp, bins)]
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(out))
        return out
    except Exception:
        return []


def list_projects(running: set[str] | None = None) -> list[dict]:
    """Projects in the projects folder plus recently opened ones elsewhere, newest first."""
    from .chapters import episode_length
    from .project import Project
    running = running or set()
    seen: dict[str, Path] = {}
    root = projects_root()
    if root.is_dir():
        for f in root.glob("*/*.holos"):
            seen[str(f.resolve())] = f
    for r in T.recent_projects():
        f = Path(r)
        if f.is_file():
            seen.setdefault(str(f.resolve()), f)
    rows = []
    for key, f in seen.items():
        try:
            p = Project.load(f)
            ready = bool(p.sources) and len(p.analysis) == len(p.sources)
            length = round(episode_length(p), 2) if ready else None
        except Exception:
            continue
        exported = (f.parent / "export").is_dir() and any((f.parent / "export").glob("*.wav")) or \
            (f.parent / "export").is_dir() and any((f.parent / "export").glob("*.mp3"))
        status = "processing" if key in running else ("exported" if exported else ("ready" if ready else "new"))
        rows.append({"path": str(f), "name": p.name, "folder": str(f.parent), "modified": f.stat().st_mtime,
                     "length": length, "recorded": round(sum(s.duration for s in p.sources), 2),
                     "files": len(p.sources), "status": status, "chapters": len(p.chapters),
                     "thumb": thumb(f) if ready else []})
    rows.sort(key=lambda r: r["modified"], reverse=True)
    return rows
