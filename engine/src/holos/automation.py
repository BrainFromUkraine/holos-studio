"""Apply the project's automation settings ("Автоматика") to its edits and processing chain.

Analysis and suggestions record every candidate (all pauses, breaths, repeats, …); this module decides
which of them are applied. Edits the user or Claude changed (`touched`) are never overridden, so the
settings can be changed at any time without losing manual work.
"""
from __future__ import annotations

from .project import Automation, ChainStep, CutEdit, GainEdit, PauseEdit, Project

MIN_PAUSE = 0.35          # analysis records pauses from this length; automation picks the long ones
BREATH_CUT_DB = -30.0     # level used if a recording has no room tone to replace a breath with


def _chain_step(p: Project, module: str) -> ChainStep | None:
    return next((c for c in p.chain if c.module == module), None)


def sync_chain(p: Project) -> None:
    a = p.automation
    mc = _chain_step(p, "mouthclick")
    if mc is None:                                     # projects made before the module existed
        i = next((k + 1 for k, c in enumerate(p.chain) if c.module == "highpass"), 0)
        mc = ChainStep(module="mouthclick", params={})
        p.chain.insert(i, mc)
    mc.enabled = a.clicks != "off"
    if a.clicks != "off":
        mc.params["strength"] = a.clicks
    for c in p.chain:
        if c.module in a.voice:
            c.enabled = bool(a.voice[c.module])
        if c.module == "loudness":
            c.params["target_lufs"] = a.target_lufs


def apply(p: Project) -> dict:
    """Set statuses / parameters of untouched edits from `p.automation`. Returns counts of applied edits."""
    a: Automation = p.automation
    p.analysis_settings.pause_max = a.pause_max
    p.analysis_settings.pause_target = a.pause_target
    p.analysis_settings.breath_db = a.breath_db
    p.timeline_settings.crossfade = max(0.005, min(0.25, a.crossfade_ms / 1000))
    counts: dict[str, int] = {}
    for e in p.edits:
        if e.touched:
            continue
        if isinstance(e, PauseEdit):
            e.target = a.pause_target
            on = a.pauses and (e.end - e.start) >= a.pause_max and (e.end - e.start) > a.pause_target
        elif isinstance(e, GainEdit):
            e.db = BREATH_CUT_DB if a.breaths == "cut" else a.breath_db
            e.room = a.breaths == "cut"           # "Remove": the room tone takes its place, the timing stays
            on = a.breaths != "off"
        elif isinstance(e, CutEdit):
            if e.kind == "manual":
                continue
            on = a.kinds.get(e.kind, "keep") == "cut"
        elif e.type == "fill":
            on = a.fill_dropouts
        else:
            continue
        e.status = "accepted" if on else "rejected"
        if on:
            k = e.kind if isinstance(e, CutEdit) else e.type
            counts[k] = counts.get(k, 0) + 1
    sync_chain(p)
    return counts


def update(p: Project, changes: dict) -> Automation:
    """Merge partial settings (as sent by the app or Claude) and re-apply."""
    data = p.automation.model_dump()
    kinds = changes.pop("kinds", None)
    voice = changes.pop("voice", None)
    data.update({k: v for k, v in changes.items() if k in data})
    if kinds:
        data["kinds"] = {**data["kinds"], **kinds}
    if voice:
        data["voice"] = {**data["voice"], **voice}
    p.automation = Automation.model_validate(data)
    apply(p)
    return p.automation
