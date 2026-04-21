"""Model blending API endpoints.

Routes:
  POST /ovo/blend/start          — start model blending
  GET  /ovo/blend/runs           — list active runs
  GET  /ovo/blend/runs/{id}      — get run progress
  POST /ovo/blend/runs/{id}/cancel — cancel blending
  GET  /ovo/blend/models         — list blended models
  DELETE /ovo/blend/models/{name} — delete blended model
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ovo_sidecar.blending.blend_runner import (
    start_blend,
    get_run,
    list_runs,
    cancel_run,
    list_blended_models,
    delete_blended_model,
)
from ovo_sidecar.blending.models import BlendConfig, BlendSource

logger = logging.getLogger(__name__)

router = APIRouter(tags=["blending"])


class BlendSourceReq(BaseModel):
    repo_id: str
    weight: float = 1.0


class StartBlendRequest(BaseModel):
    name: str
    method: str = "slerp"
    sources: list[BlendSourceReq]


@router.post("/blend/start")
async def api_start_blend(req: StartBlendRequest) -> dict:
    if len(req.sources) < 2:
        raise HTTPException(status_code=400, detail="At least 2 models required")

    config = BlendConfig(
        name=req.name,
        method=req.method,
        sources=[BlendSource(repo_id=s.repo_id, weight=s.weight) for s in req.sources],
    )

    run = await start_blend(config)
    return {"run_id": run.run_id, "name": run.name, "status": run.status}


@router.get("/blend/runs")
async def api_list_runs() -> list[dict]:
    return [
        {
            "run_id": r.run_id,
            "name": r.name,
            "method": r.method,
            "status": r.status,
            "progress": r.progress,
            "elapsed_seconds": r.elapsed_seconds,
            "error": r.error,
        }
        for r in list_runs()
    ]


@router.get("/blend/runs/{run_id}")
async def api_get_run(run_id: str) -> dict:
    run = get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {
        "run_id": run.run_id,
        "name": run.name,
        "method": run.method,
        "sources": [{"repo_id": s.repo_id, "weight": s.weight} for s in run.sources],
        "status": run.status,
        "progress": run.progress,
        "output_path": run.output_path,
        "elapsed_seconds": run.elapsed_seconds,
        "error": run.error,
    }


@router.post("/blend/runs/{run_id}/cancel")
async def api_cancel_run(run_id: str) -> dict:
    if not cancel_run(run_id):
        raise HTTPException(status_code=404, detail="Run not found or already finished")
    return {"cancelled": True}


@router.get("/blend/models")
async def api_list_models() -> list[dict]:
    return list_blended_models()


@router.delete("/blend/models/{name}")
async def api_delete_model(name: str) -> dict:
    if not delete_blended_model(name):
        raise HTTPException(status_code=404, detail="Model not found")
    return {"deleted": True}
