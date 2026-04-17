import logging
import shutil
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ovo_sidecar import hf_scanner
from ovo_sidecar.config import settings
from ovo_sidecar.hf_downloader import DownloadTask, downloader
from ovo_sidecar.registry import registry

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ovo"])


class DownloadRequest(BaseModel):
    repo_id: str


class SettingsUpdate(BaseModel):
    default_model: str | None = None
    expose_to_network: bool | None = None
    claude_integration_enabled: bool | None = None
    default_context_length: int | None = None
    max_tokens_cap: int | None = None


class AliasRequest(BaseModel):
    alias: str
    repo_id: str


def _serialize_model(m: hf_scanner.ScannedModel) -> dict[str, Any]:
    arch = m.config.get("architectures") or []
    quant = m.config.get("quantization")
    return {
        "repo_id": m.repo_id,
        "revision": m.revision,
        "snapshot_path": str(m.snapshot_path),
        "size_bytes": m.size_bytes,
        "is_mlx": m.is_mlx,
        "model_type": m.config.get("model_type"),
        "architecture": arch[0] if arch else None,
        "quantization": quant,
        "hidden_size": m.config.get("hidden_size"),
        # [START] surface cache source so UI can distinguish HF vs LM Studio
        "source": m.source,
        # [END]
    }


def _serialize_task(t: DownloadTask) -> dict[str, Any]:
    return {
        "task_id": t.task_id,
        "repo_id": t.repo_id,
        "status": t.status,
        "error": t.error,
        "snapshot_path": str(t.snapshot_path) if t.snapshot_path else None,
        "started_at": t.started_at,
        "finished_at": t.finished_at,
    }


@router.get("/models")
async def list_local_models(mlx_only: bool = True) -> dict[str, Any]:
    # [START] use merged HF + LM Studio scan
    scanned = hf_scanner.scan_all()
    models = [_serialize_model(m) for m in scanned if (not mlx_only or m.is_mlx)]
    return {
        "models": models,
        "count": len(models),
        "cache_dirs": {
            "hf": str(settings.hf_cache_dir),
            "lmstudio": str(settings.lmstudio_cache_dir),
        },
    }
    # [END]


@router.get("/models/search")
async def search_models(q: str = "", limit: int = 25) -> dict[str, Any]:
    try:
        results = await downloader.search(q, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"HF search failed: {e}") from e
    return {"query": q, "results": [r.__dict__ for r in results]}


@router.post("/models/download")
async def start_download(req: DownloadRequest) -> dict[str, Any]:
    task = await downloader.start_download(req.repo_id)
    return _serialize_task(task)


@router.get("/download/{task_id}")
async def get_download(task_id: str) -> dict[str, Any]:
    task = downloader.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return _serialize_task(task)


@router.get("/downloads")
async def list_downloads() -> dict[str, Any]:
    return {"tasks": [_serialize_task(t) for t in downloader.list_tasks()]}


@router.delete("/models/{repo_id:path}")
async def delete_model(repo_id: str) -> dict[str, Any]:
    # [START] reject deletes targeting foreign stores (LM Studio)
    target_name = f"models--{repo_id.replace('/', '--')}"
    model_dir = settings.hf_cache_dir / target_name
    if not model_dir.exists():
        resolved = hf_scanner.resolve_path(repo_id)
        if resolved is not None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{repo_id} lives in a non-HF store ({resolved}); "
                    "OVO only manages ~/.cache/huggingface/hub"
                ),
            )
        raise HTTPException(status_code=404, detail=f"model not found: {repo_id}")
    shutil.rmtree(model_dir)
    return {"deleted": repo_id}
    # [END]


@router.get("/settings")
async def get_settings() -> dict[str, Any]:
    return {
        "default_model": registry.default_model,
        "aliases": registry.aliases,
        "ports": {
            "ollama": settings.ollama_port,
            "openai": settings.openai_port,
            "native": settings.native_port,
        },
        "hf_cache_dir": str(settings.hf_cache_dir),
        "lmstudio_cache_dir": str(settings.lmstudio_cache_dir),
        "data_dir": str(settings.data_dir),
        "default_context_length": settings.default_context_length,
        "max_tokens_cap": settings.max_tokens_cap,
        "expose_to_network": settings.expose_to_network,
        "claude_integration": {
            "enabled": settings.claude_integration_enabled,
            "read_claude_md": settings.claude_read_claude_md,
            "read_settings": settings.claude_read_settings,
            "read_plugins": settings.claude_read_plugins,
        },
    }


@router.put("/settings")
async def update_settings(patch: SettingsUpdate) -> dict[str, Any]:
    if patch.default_model is not None:
        registry.default_model = patch.default_model or None
    if patch.expose_to_network is not None:
        settings.expose_to_network = patch.expose_to_network
    if patch.claude_integration_enabled is not None:
        settings.claude_integration_enabled = patch.claude_integration_enabled
    if patch.default_context_length is not None:
        settings.default_context_length = patch.default_context_length
    if patch.max_tokens_cap is not None:
        settings.max_tokens_cap = patch.max_tokens_cap
    return await get_settings()


@router.post("/aliases")
async def add_alias(req: AliasRequest) -> dict[str, Any]:
    registry.set_alias(req.alias, req.repo_id)
    return {"alias": req.alias, "repo_id": req.repo_id}


@router.get("/audit")
async def audit() -> dict[str, Any]:
    return registry.snapshot()
