"""Data models for model blending."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

KST = timezone(offset=__import__("datetime").timedelta(hours=9))


def _now_kst() -> str:
    return datetime.now(KST).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class BlendSource:
    repo_id: str
    weight: float = 1.0


@dataclass
class BlendConfig:
    name: str = ""
    method: str = "slerp"
    sources: list[BlendSource] = field(default_factory=list)
    output_dir: str = ""


@dataclass
class BlendRun:
    run_id: str = field(default_factory=_new_id)
    name: str = ""
    method: str = "slerp"
    sources: list[BlendSource] = field(default_factory=list)
    status: str = "pending"
    progress: float = 0.0
    output_path: str = ""
    error: str | None = None
    started_at: str = ""
    completed_at: str = ""
    elapsed_seconds: float = 0.0
