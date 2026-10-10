"""Export templates (plugins): external scripts that turn the finished audio into something else.

A template is a folder with a `template.json` manifest and a script. The engine runs the script with
its own Python, passes the mastered audio and the parameters the user filled in (the app draws the
form from the manifest), reads progress from the script's output and, for video, replaces the
script's audio track with the stereo master and adds chapters.

Where templates live:
  built-in examples   holos/assets/templates/<id>/
  user templates      $HOLOS_HOME/templates/<id>/   (default: ~/Documents/Holos Studio)
  extra folders       $HOLOS_TEMPLATES (os.pathsep-separated)
A user template with the same id overrides a built-in one.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field

BUILTIN = Path(__file__).parent / "assets" / "templates"


class Choice(BaseModel):
    value: str
    label: str = ""


class Param(BaseModel):
    key: str
    label: str
    type: Literal["file", "int", "float", "choice", "bool", "text"]
    arg: str                                   # command-line flag, e.g. "--photo"
    required: bool = False
    default: Any = None
    help: str = ""
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[Choice] = []
    filters: list[str] = []                    # file extensions for the file picker
    auto: Literal["increment"] | None = None   # e.g. episode number: last used + 1 for a new project


class ProgressSpec(BaseModel):
    regex: str                                 # applied to each output line
    done: int = 1                              # group with seconds rendered
    total: int = 2                             # group with total seconds (optional)


class Manifest(BaseModel):
    id: str
    name: str
    kind: Literal["video"] = "video"
    description: str = ""
    entry: str
    imports: list[str] = []                    # Python modules the script needs
    install: str = ""                          # hint shown when imports are missing
    args: dict[str, str] = Field(default_factory=lambda: {"audio": "--audio", "out": "--out"})
    params: list[Param] = []
    progress: ProgressSpec | None = None
    output: str = "mp4"
    remux_audio: bool = True                   # replace the script's audio with the master


class Template(BaseModel):
    manifest: Manifest
    dir: str
    builtin: bool
    missing: list[str] = []

    def public(self) -> dict:
        m = self.manifest
        return {"id": m.id, "name": m.name, "kind": m.kind, "description": m.description,
                "params": [p.model_dump() for p in m.params], "preview": "preview" in m.args,
                "builtin": self.builtin, "dir": self.dir, "missing": self.missing, "install": m.install,
                "ready": not self.missing}


# ---- locations & state --------------------------------------------------------------------------
def home() -> Path:
    env = os.environ.get("HOLOS_HOME")
    return Path(env) if env else Path.home() / "Documents" / "Holos Studio"


def template_dirs() -> list[tuple[Path, bool]]:
    dirs = [(BUILTIN, True), (home() / "templates", False)]
    for d in filter(None, os.environ.get("HOLOS_TEMPLATES", "").split(os.pathsep)):
        dirs.append((Path(d), False))
    return dirs


def _missing(mods: list[str]) -> list[str]:
    out = []
    for m in mods:
        try:
            if importlib.util.find_spec(m) is None:
                out.append(m)
        except (ImportError, ValueError):
            out.append(m)
    return out


def discover() -> dict[str, Template]:
    found: dict[str, Template] = {}
    for root, builtin in template_dirs():
        if not root.is_dir():
            continue
        for mf in sorted(root.glob("*/template.json")):
            try:
                m = Manifest.model_validate_json(mf.read_text(encoding="utf-8"))
            except Exception as e:      # a broken user template must not break the app
                print(f"holos: skipping template {mf}: {e}", file=sys.stderr)
                continue
            found[m.id] = Template(manifest=m, dir=str(mf.parent), builtin=builtin, missing=_missing(m.imports))
    return found


def get(template_id: str) -> Template:
    t = discover().get(template_id)
    if t is None:
        raise KeyError(f"template not found: {template_id}")
    return t


def _state_path() -> Path:
    return home() / "state.json"


def load_state() -> dict:
    try:
        return json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remember(template_id: str, params: dict, project: str) -> None:
    """Last-used parameters per template (for the next episode)."""
    st = load_state()
    st.setdefault("templates", {})[template_id] = {"params": params, "project": project}
    try:
        _state_path().parent.mkdir(parents=True, exist_ok=True)
        _state_path().write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass


def initial_params(t: Template, project_params: dict | None, project: str) -> dict:
    """Parameters to show: the project's own, else last used (+1 for auto-increment), else defaults."""
    m = t.manifest
    if project_params:
        return {p.key: project_params.get(p.key, p.default) for p in m.params}
    last = load_state().get("templates", {}).get(m.id)
    out = {}
    for p in m.params:
        v = p.default
        if last and p.key in last["params"]:
            v = last["params"][p.key]
            if p.auto == "increment" and isinstance(v, (int, float)) and last.get("project") != project:
                v = int(v) + 1
        out[p.key] = v
    return out


# ---- running ------------------------------------------------------------------------------------
class TemplateError(RuntimeError):
    pass


def build_args(m: Manifest, params: dict) -> list[str]:
    out: list[str] = []
    for p in m.params:
        v = params.get(p.key, p.default)
        if v is None or v == "":
            if p.required:
                raise TemplateError(f"'{p.label}' is required")
            continue
        if p.type == "bool":
            if bool(v):
                out.append(p.arg)
            continue
        if p.type == "int":
            v = int(v)
        elif p.type == "float":
            v = float(v)
            if p.min is not None and v < p.min or p.max is not None and v > p.max:
                raise TemplateError(f"'{p.label}' must be between {p.min} and {p.max}")
        elif p.type == "choice" and p.options and str(v) not in {o.value for o in p.options}:
            raise TemplateError(f"'{p.label}': unknown option {v!r}")
        elif p.type == "file" and not Path(str(v)).is_file():
            raise TemplateError(f"'{p.label}': file not found: {v}")
        out += [p.arg, str(v)]
    return out


def run(t: Template, audio: str, out: str, params: dict, preview: float = 0,
        progress: Callable[[float, float, str], None] | None = None) -> None:
    """Run the template script; raises TemplateError with the script's last output on failure."""
    from .io import ffmpeg_path
    m = t.manifest
    if t.missing:
        raise TemplateError(f"template '{m.name}' needs Python modules: {', '.join(t.missing)}"
                            + (f" — install with: {m.install}" if m.install else ""))
    entry = Path(t.dir) / m.entry
    cmd = [sys.executable, "-u", str(entry), m.args.get("audio", "--audio"), audio, m.args.get("out", "--out"), out]
    if preview:
        if "preview" not in m.args:
            raise TemplateError(f"template '{m.name}' has no preview mode")
        cmd += [m.args["preview"], f"{preview:g}"]
    cmd += build_args(m, params)

    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    try:
        ff = ffmpeg_path()
        env["HOLOS_FFMPEG"] = ff
        env["PATH"] = str(Path(ff).parent) + os.pathsep + env.get("PATH", "")
    except Exception:
        pass
    rx = re.compile(m.progress.regex) if m.progress else None
    tail: deque[str] = deque(maxlen=25)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(cmd, cwd=t.dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags)
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail.append(line)
        if rx and progress:
            mt = rx.search(line)
            if mt:
                done = float(mt.group(m.progress.done))
                total = float(mt.group(m.progress.total)) if m.progress.total and mt.lastindex and \
                    mt.lastindex >= m.progress.total else 0.0
                progress(done, total, line.strip())
                continue
        if progress:
            progress(-1, 0, line.strip())
    code = proc.wait()
    if code != 0 or not Path(out).is_file():
        raise TemplateError(f"template '{m.name}' failed (exit {code}):\n" + "\n".join(tail))


# ---- recent projects (for the MCP server and the app) -------------------------------------------
def touch_recent(project: str, keep: int = 20) -> None:
    st = load_state()
    p = str(Path(project).resolve())
    st["recent"] = [p] + [x for x in st.get("recent", []) if x != p][: keep - 1]
    try:
        _state_path().parent.mkdir(parents=True, exist_ok=True)
        _state_path().write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass


def recent_projects() -> list[str]:
    return list(load_state().get("recent", []))
