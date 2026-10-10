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

PROJECT_VERSION = 1

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


class GainEdit(_EditBase):
    type: Literal["gain"] = "gain"
    db: float


class CutEdit(_EditBase):
    type: Literal["cut"] = "cut"


class PauseEdit(_EditBase):
    """Shorten a pause to `target` seconds by removing its middle."""
    type: Literal["pause"] = "pause"
    target: float


class FillEdit(_EditBase):
    """Fill a gate drop-out with captured room tone."""
    type: Literal["fill"] = "fill"


Edit = Annotated[Union[GainEdit, CutEdit, PauseEdit, FillEdit], Field(discriminator="type")]


class ChainStep(BaseModel):
    module: str
    enabled: bool = True
    params: dict[str, Any] = {}


class AnalysisSettings(BaseModel):
    breath_db: float = -12.0
    pause_max: float = 0.9
    pause_target: float = 0.7


class TimelineSettings(BaseModel):
    level_match_lufs: float = -20.0
    gap_between: float = 0.6
    lead_in: float = 0.4
    tail: float = 1.2
    crossfade: float = 0.04


class ExportSettings(BaseModel):
    wav: bool = True
    wav_bits: Literal[16, 24, 32] = 24
    channels: Literal[1, 2] = 2
    mp3: bool = True
    mp3_kbps: int = 192


def default_chain() -> list[ChainStep]:
    return [
        ChainStep(module="highpass", params={"freq": 75.0, "order": 4}),
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
    analysis_settings: AnalysisSettings = AnalysisSettings()
    timeline_settings: TimelineSettings = TimelineSettings()
    chain: list[ChainStep] = Field(default_factory=default_chain)
    export: ExportSettings = ExportSettings()

    # ---- persistence -------------------------------------------------
    @classmethod
    def load(cls, path: str | Path) -> "Project":
        return cls.model_validate_json(Path(path).read_text(encoding="utf-8"))

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
