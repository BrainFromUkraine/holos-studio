"""Editing operations used by the editor screen, with undo / redo.

Every operation snapshots the edit list before changing it. History is kept next to the project
(`<project>.holos-cache/history.json`) so it survives restarting the engine.
"""
from __future__ import annotations

import json
from pathlib import Path

from .project import CutEdit, Edit, Project
from pydantic import TypeAdapter

HISTORY_MAX = 100
_edits_adapter = TypeAdapter(list[Edit])


class EditError(ValueError):
    pass


# ---- history ------------------------------------------------------------------------------------
def _hist_file(path: str | Path) -> Path:
    path = Path(path)
    d = path.parent / f"{path.stem}.holos-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d / "history.json"


def _read_hist(path) -> dict:
    try:
        h = json.loads(_hist_file(path).read_text(encoding="utf-8"))
        return {"undo": h.get("undo", []), "redo": h.get("redo", [])}
    except (OSError, ValueError):
        return {"undo": [], "redo": []}


def _write_hist(path, h: dict) -> None:
    _hist_file(path).write_text(json.dumps(h, ensure_ascii=False), encoding="utf-8")


def _snap(p: Project, label: str) -> dict:
    return {"label": label, "edits": json.loads(_edits_adapter.dump_json(p.edits)),
            "automation": p.automation.model_dump(), "chain": [c.model_dump() for c in p.chain]}


def _restore(p: Project, snap: dict) -> None:
    from .project import Automation, ChainStep
    p.edits = _edits_adapter.validate_python(snap["edits"])
    if "automation" in snap:
        p.automation = Automation.model_validate(snap["automation"])
        p.analysis_settings.pause_max = p.automation.pause_max
        p.analysis_settings.pause_target = p.automation.pause_target
        p.analysis_settings.breath_db = p.automation.breath_db
    if "chain" in snap:
        p.chain = [ChainStep.model_validate(c) for c in snap["chain"]]


def history_state(path) -> dict:
    h = _read_hist(path)
    return {"can_undo": bool(h["undo"]), "can_redo": bool(h["redo"]),
            "undo_label": h["undo"][-1]["label"] if h["undo"] else None,
            "redo_label": h["redo"][-1]["label"] if h["redo"] else None}


def _commit(p: Project, path, before: dict) -> None:
    h = _read_hist(path)
    h["undo"] = (h["undo"] + [before])[-HISTORY_MAX:]
    h["redo"] = []
    _write_hist(path, h)
    p.save(path)


def undo(p: Project, path) -> str | None:
    h = _read_hist(path)
    if not h["undo"]:
        return None
    snap = h["undo"].pop()
    h["redo"].append(_snap(p, snap["label"]))
    _restore(p, snap)
    _write_hist(path, h)
    p.save(path)
    return snap["label"]


def redo(p: Project, path) -> str | None:
    h = _read_hist(path)
    if not h["redo"]:
        return None
    snap = h["redo"].pop()
    h["undo"].append(_snap(p, snap["label"]))
    _restore(p, snap)
    _write_hist(path, h)
    p.save(path)
    return snap["label"]


# ---- helpers ------------------------------------------------------------------------------------
def _find(p: Project, eid: str):
    for e in p.edits:
        if e.id == eid:
            return e
    raise EditError(f"edit not found: {eid}")


def _snapper(p: Project, path, sid: str):
    from .analysis.features import Frames
    from .suggest import Snapper
    from .view import rms_track
    import numpy as np
    r = rms_track(p, path, sid)
    z = np.zeros(len(r))
    return Snapper(Frames(rms_db=r, flat=z, hi=z, lo=z, speech=z.astype(bool)), pad=0.12)


def _words_text(p: Project, sid: str, a: float, b: float) -> tuple[str, str, str]:
    from .chapters import join_words
    ws = p.transcript.get(sid, [])
    inside = [i for i, w in enumerate(ws) if (w.start + w.end) / 2 >= a and (w.start + w.end) / 2 < b]
    if not inside:
        before = [w.w for w in ws if w.end <= a][-6:]
        after = [w.w for w in ws if w.start >= b][:6]
        return join_words(before), "", join_words(after)
    i, j = inside[0], inside[-1] + 1
    return join_words([w.w for w in ws[max(0, i - 6):i]]), join_words([w.w for w in ws[i:j]]), \
        join_words([w.w for w in ws[j:j + 6]])


def _next_manual_id(p: Project, sid: str) -> str:
    n = 1
    ids = {e.id for e in p.edits}
    while f"{sid}-m{n}" in ids:
        n += 1
    return f"{sid}-m{n}"


# ---- operations ---------------------------------------------------------------------------------
def set_status(p: Project, path, ids: list[str], status: str) -> None:
    if status not in ("accepted", "rejected", "suggested"):
        raise EditError("status must be accepted, rejected or suggested")
    before = _snap(p, "Вирізати" if status == "accepted" else "Залишити")
    found = 0
    for e in p.edits:
        if e.id in ids:
            e.status = status  # type: ignore[assignment]
            e.touched = True
            found += 1
    if not found:
        raise EditError(f"edit not found: {ids}")
    _commit(p, path, before)


def adjust(p: Project, path, eid: str, start: float | None = None, end: float | None = None,
           snap: str | None = None) -> None:
    """Move an edit's boundaries (source seconds). `snap` = "start" | "end" | "both": move to the quietest spot nearby."""
    e = _find(p, eid)
    before = _snap(p, "Межі правки")
    dur = p.source(e.source).duration
    s = e.start if start is None else float(start)
    t = e.end if end is None else float(end)
    if snap:
        sn = _snapper(p, path, e.source)
        if snap in ("start", "both"):
            s = sn.between(s - 0.03, s + 0.03)
        if snap in ("end", "both"):
            t = sn.between(t - 0.03, t + 0.03)
    s, t = max(0.0, min(s, dur)), max(0.0, min(t, dur))
    if t - s < 0.01:
        raise EditError("an edit must be at least 10 ms long")
    e.start, e.end = round(s, 4), round(t, 4)
    e.touched = True
    if isinstance(e, CutEdit):
        e.before, e.text, e.after = _words_text(p, e.source, e.start, e.end)
    _commit(p, path, before)


def add_cut(p: Project, path, sid: str, start: float, end: float, snap: bool = True) -> str:
    """Manual cut of a source range (source seconds); edges snap to the quietest spot nearby."""
    src = p.source(sid)
    a, b = sorted((float(start), float(end)))
    if snap:
        sn = _snapper(p, path, sid)
        a, b = sn.between(a - 0.03, a + 0.03), sn.between(b - 0.03, b + 0.03)
    a, b = max(0.0, a), min(src.duration, b)
    if b - a < 0.02:
        raise EditError("selection is too short to cut")
    before = _snap(p, "Вирізати виділене")
    eid = _next_manual_id(p, sid)
    pre, text, post = _words_text(p, sid, a, b)
    p.edits.append(CutEdit(id=eid, source=sid, start=round(a, 4), end=round(b, 4), status="accepted", kind="manual",
                           text=text, before=pre, after=post, reason="manual", touched=True))
    _commit(p, path, before)
    return eid


def add_cuts(p: Project, path, ranges: list[dict], snap: bool = True) -> list[str]:
    """Several cuts as ONE undo step (a range that spans recordings arrives split per recording)."""
    before = _snap(p, "Вирізати діапазон")
    ids = []
    for r in ranges:
        sid = r["source"]
        src = p.source(sid)
        a, b = sorted((float(r["start"]), float(r["end"])))
        if snap:
            sn = _snapper(p, path, sid)
            a, b = sn.between(a - 0.03, a + 0.03), sn.between(b - 0.03, b + 0.03)
        a, b = max(0.0, a), min(src.duration, b)
        if b - a < 0.02:
            continue
        eid = _next_manual_id(p, sid)
        pre, text, post = _words_text(p, sid, a, b)
        p.edits.append(CutEdit(id=eid, source=sid, start=round(a, 4), end=round(b, 4), status="accepted",
                               kind="manual", text=text, before=pre, after=post, reason="manual", touched=True))
        ids.append(eid)
    if not ids:
        raise EditError("selection is too short to cut")
    _commit(p, path, before)
    return ids


def set_automation(p: Project, path, changes: dict) -> None:
    from . import automation
    before = _snap(p, "Автоматика")
    automation.update(p, dict(changes))
    _commit(p, path, before)


def cut_words(p: Project, path, sid: str, i0: int, i1: int) -> str:
    """Cut transcript words i0..i1 (inclusive): from the gap before the first word to the gap after the last."""
    ws = p.transcript.get(sid, [])
    if not ws or not (0 <= i0 <= i1 < len(ws)):
        raise EditError("word range out of bounds")
    sn = _snapper(p, path, sid)
    prev_end = ws[i0 - 1].end if i0 > 0 else max(0.0, ws[i0].start - 0.25)
    next_start = ws[i1 + 1].start if i1 + 1 < len(ws) else min(p.source(sid).duration, ws[i1].end + 0.25)
    a = sn.between(prev_end, ws[i0].start)
    b = sn.between(ws[i1].end, next_start)
    return add_cut(p, path, sid, a, b, snap=False)


def delete(p: Project, path, eid: str) -> None:
    e = _find(p, eid)
    if not (isinstance(e, CutEdit) and e.kind == "manual"):
        raise EditError("only your own cuts can be deleted — use Keep for automatic ones")
    before = _snap(p, "Видалити правку")
    p.edits = [x for x in p.edits if x.id != eid]
    _commit(p, path, before)
