"""Project file model (*.holos, JSON).

A project references source recordings (never modified), an ordered timeline,
edits (suggested / accepted / rejected), the processing chain and export settings.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

PROJECT_VERSION = 2

EditStatus = Literal["suggested", "accepted", "rejected"]


class Source(BaseModel):
    id: str
    path: str
    sha256: str
    sr: int
    channels: int
    duration: float


class SourceAnalysis(BaseModel):
    """Measurements of one source, all times source-relative (seconds)."""
    speech_on: float
    speech_off: float
    speech_level_db: float
    room_db: float
    loudness_lufs: float
    room_tone: list[tuple[float, float]] = []


class Word(BaseModel):
    w: str
    start: float
    end: float
    p: float = 1.0


class AsrSettings(BaseModel):
    model: str = "large-v3-turbo"
    language: str = "uk"
    glossary: list[str] = []          # English terms etc. to keep spelled correctly
    device: Literal["auto", "cuda", "cpu"] = "auto"
    compute_type: str = "auto"
    beam_size: int = 5


class Clip(BaseModel):
    source: str
    start: float
    end: float


class _EditBase(BaseModel):
    id: str
    source: str
    start: float
    end: float
    status: EditStatus = "suggested"
    reason: str = ""
    touched: bool = False           # changed by the user (or Claude) — automation never overrides it


class GainEdit(_EditBase):
    type: Literal["gain"] = "gain"
    db: float
    room: bool = False              # replace with the recording's room tone instead of lowering (breaths "Remove")


class CutEdit(_EditBase):
    type: Literal["cut"] = "cut"
    kind: str = ""          # retake | repeat | filler | fragment | sound | manual
    text: str = ""          # transcript of what is cut
    before: str = ""        # context
    after: str = ""


class PauseEdit(_EditBase):
    """Shorten a pause to `target` seconds by removing its middle."""
    type: Literal["pause"] = "pause"
    target: float


class FillEdit(_EditBase):
    """Fill a gate drop-out with captured room tone."""
    type: Literal["fill"] = "fill"


Edit = Annotated[Union[GainEdit, CutEdit, PauseEdit, FillEdit], Field(discriminator="type")]


class Chapter(BaseModel):
    """A chapter starts at a word in a source recording, so it moves with the edits."""
    source: str
    at: float                       # source time (seconds)
    title: str
    origin: str = "user"            # user | claude | ...


class VideoExport(BaseModel):
    template: str | None = None
    params: dict[str, Any] = {}


CutPolicy = Literal["cut", "keep"]


class Automation(BaseModel):
    """What the program does by itself after import ("Автоматика"). Manual edits are never overridden."""
    pauses: bool = True
    pause_max: float = 0.9          # pauses longer than this…
    pause_target: float = 0.7       # …are shortened to this (middle removed)
    breaths: Literal["duck", "cut", "off"] = "duck"
    breath_db: float = -12.0        # "duck" level; "cut" replaces the breath with room tone
    clicks: Literal["off", "light", "normal", "strong"] = "normal"   # mouth clicks / saliva
    kinds: dict[str, CutPolicy] = Field(default_factory=lambda: {
        "repeat": "cut", "retake": "cut", "filler": "cut",
        "fragment": "keep", "sound": "keep", "unclear": "keep"})
    fill_dropouts: bool = True
    level_match: bool = True
    crossfade_ms: float = 40.0      # at every splice
    target_lufs: float = -16.0      # podcast −16 · YouTube −14 · broadcast −23
    voice: dict[str, bool] = Field(default_factory=lambda: {
        "highpass": True, "declick": True, "eq": True, "deess": True, "compressor": True})


class ChainStep(BaseModel):
    module: str
    enabled: bool = True
    params: dict[str, Any] = {}


class AnalysisSettings(BaseModel):
    breath_db: float = -12.0
    pause_max: float = 0.9
    pause_target: float = 0.7
    breath_version: int = 1         # breath detector the edits were made with (analysis.BREATH_VERSION)


class TimelineSettings(BaseModel):
    level_match_lufs: float = -20.0
    gap_between: float = 0.6         # unused: recordings are joined back to back (kept so old projects load)
    lead_in: float = 0.4
    tail: float = 1.2
    crossfade: float = 0.04


class ExportSettings(BaseModel):
    wav: bool = True
    wav_bits: Literal[16, 24, 32] = 24
    channels: Literal[1, 2] = 2
    mp3: bool = True
    mp3_kbps: int = 192
    chapters_txt: bool = True       # YouTube description timecodes
    chapters_embed: bool = True     # chapters inside MP3 / MP4
    video: VideoExport = VideoExport()


def default_chain() -> list[ChainStep]:
    return [
        ChainStep(module="highpass", params={"freq": 75.0, "order": 4}),
        ChainStep(module="mouthclick", params={"strength": "normal"}),
        ChainStep(module="declick", params={"threshold": 6.0}),
        ChainStep(module="eq", params={"bands": [
            {"freq": 350.0, "gain": -2.0, "width_oct": 1.2},
            {"freq": 3200.0, "gain": 2.0, "width_oct": 1.3},
        ]}),
        ChainStep(module="deess", params={"threshold_pct": 70.0, "ratio": 3.0, "max_reduction": 8.0}),
        ChainStep(module="compressor", params={"preset": "voice"}),
        ChainStep(module="loudness", params={"target_lufs": -16.0, "ceiling_db": -2.0}),
    ]


class Project(BaseModel):
    version: int = PROJECT_VERSION
    name: str = "Untitled"
    sample_rate: int = 48000
    sources: list[Source] = []
    analysis: dict[str, SourceAnalysis] = {}
    timeline: list[Clip] = []
    edits: list[Edit] = []
    transcript: dict[str, list[Word]] = {}
    transcript_meta: dict[str, dict[str, Any]] = {}
    asr: AsrSettings = AsrSettings()
    analysis_settings: AnalysisSettings = AnalysisSettings()
    timeline_settings: TimelineSettings = TimelineSettings()
    chain: list[ChainStep] = Field(default_factory=default_chain)
    # edit kinds applied without asking; everything else becomes a question for the user
    auto_apply: list[str] = Field(default_factory=lambda: ["gain", "pause", "fill", "retake", "repeat", "filler"])
    export: ExportSettings = ExportSettings()
    chapters: list[Chapter] = []
    automation: Automation = Automation()

    # ---- persistence -------------------------------------------------
    @classmethod
    def load(cls, path: str | Path) -> "Project":
        p = cls.model_validate_json(Path(path).read_text(encoding="utf-8"))
        if p.version < PROJECT_VERSION:
            p._migrate()
        return p

    def _migrate(self) -> None:
        """v1 → v2: questions are gone, automation decides; answers given to old questions are kept."""
        from .automation import apply
        if self.version < 2:
            ask = {"unclear", "fragment", "sound"}
            for e in self.edits:
                if isinstance(e, CutEdit) and (e.kind == "manual" or (e.kind in ask and e.status != "suggested")):
                    e.touched = True
            self.automation.kinds.update({k: ("cut" if k in self.auto_apply else "keep")
                                          for k in ("repeat", "retake", "filler")})
            loud = next((c for c in self.chain if c.module == "loudness"), None)
            if loud is not None:
                self.automation.target_lufs = float(loud.params.get("target_lufs", -16.0))
            apply(self)
        self.version = PROJECT_VERSION

    def save(self, path: str | Path) -> None:
        Path(path).write_text(self.model_dump_json(indent=1), encoding="utf-8")

    # ---- helpers ------------------------------------------------------
    def source(self, sid: str) -> Source:
        for s in self.sources:
            if s.id == sid:
                return s
        raise KeyError(sid)

    def edits_for(self, sid: str, status: EditStatus | None = "accepted") -> list[Edit]:
        return [e for e in self.edits if e.source == sid and (status is None or e.status == status)]

    def set_status(self, status: EditStatus, types: set[str] | None = None, ids: set[str] | None = None) -> int:
        n = 0
        for e in self.edits:
            if (types is None or e.type in types) and (ids is None or e.id in ids):
                e.status = status
                n += 1
        return n


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()


def natural_key(s: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def dump_json(obj: Any, path: str | Path) -> None:
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False), encoding="utf-8")
