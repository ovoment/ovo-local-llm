import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ovo_sidecar import hf_scanner
from ovo_sidecar.config import settings
from ovo_sidecar.hf_downloader import downloader
from ovo_sidecar.mlx_runner import ChatMessage, runner
from ovo_sidecar.registry import registry

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ollama"])


class OllamaMessage(BaseModel):
    role: str
    content: str


class OllamaChatRequest(BaseModel):
    model: str
    messages: list[OllamaMessage]
    stream: bool = True
    options: dict[str, Any] | None = None


class OllamaGenerateRequest(BaseModel):
    model: str
    prompt: str
    stream: bool = True
    options: dict[str, Any] | None = None


class OllamaPullRequest(BaseModel):
    name: str
    stream: bool = False


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _opts(o: dict | None) -> tuple[int, float | None, float | None]:
    o = o or {}
    raw = o.get("num_predict") or o.get("max_tokens") or settings.max_tokens_cap
    max_tokens = min(int(raw), settings.max_tokens_cap)
    return max_tokens, o.get("temperature"), o.get("top_p")


# [START] resolve alias + local path (LM Studio / HF cache)
def _resolve_ref(name: str):
    repo_id = registry.resolve(name)
    local = hf_scanner.resolve_path(repo_id)
    return local if local is not None else repo_id
# [END]


@router.get("/api/tags")
async def list_tags() -> dict[str, Any]:
    # [START] merged HF + LM Studio scan
    scanned = hf_scanner.scan_all()
    models: list[dict[str, Any]] = []
    # [END]
    for m in scanned:
        if not m.is_mlx:
            continue
        quant = m.config.get("quantization")
        quant_level = None
        if isinstance(quant, dict):
            bits = quant.get("bits")
            quant_level = f"Q{bits}" if bits is not None else None
        models.append(
            {
                "name": m.repo_id,
                "model": m.repo_id,
                "modified_at": _now(),
                "size": m.size_bytes,
                "digest": m.revision,
                "details": {
                    "format": "mlx",
                    "family": m.config.get("model_type", "unknown"),
                    "parameter_size": m.config.get("hidden_size"),
                    "quantization_level": quant_level,
                },
            }
        )
    return {"models": models}


@router.post("/api/chat")
async def chat(req: OllamaChatRequest):
    model_id = _resolve_ref(req.model)
    messages = [ChatMessage(role=m.role, content=m.content) for m in req.messages]
    max_tokens, temp, top_p = _opts(req.options)

    if req.stream:

        async def event_stream():
            final_reason: str | None = None
            prompt_tokens: int | None = None
            gen_tokens: int | None = None
            async for chunk in runner.stream_chat(
                model_id, messages, max_tokens=max_tokens, temperature=temp, top_p=top_p
            ):
                yield json.dumps(
                    {
                        "model": req.model,
                        "created_at": _now(),
                        "message": {"role": "assistant", "content": chunk.text},
                        "done": False,
                    }
                ) + "\n"
                if chunk.done:
                    final_reason = chunk.finish_reason
                    prompt_tokens = chunk.prompt_tokens
                    gen_tokens = chunk.generation_tokens
            yield json.dumps(
                {
                    "model": req.model,
                    "created_at": _now(),
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": final_reason or "stop",
                    "prompt_eval_count": prompt_tokens,
                    "eval_count": gen_tokens,
                }
            ) + "\n"

        return StreamingResponse(event_stream(), media_type="application/x-ndjson")

    content = ""
    final_reason: str | None = None
    async for chunk in runner.stream_chat(
        model_id, messages, max_tokens=max_tokens, temperature=temp, top_p=top_p
    ):
        content += chunk.text
        if chunk.done:
            final_reason = chunk.finish_reason
    return {
        "model": req.model,
        "created_at": _now(),
        "message": {"role": "assistant", "content": content},
        "done": True,
        "done_reason": final_reason or "stop",
    }


@router.post("/api/generate")
async def generate(req: OllamaGenerateRequest):
    model_id = _resolve_ref(req.model)
    max_tokens, temp, top_p = _opts(req.options)

    if req.stream:

        async def event_stream():
            final_reason: str | None = None
            async for chunk in runner.stream_generate(
                model_id, req.prompt, max_tokens=max_tokens, temperature=temp, top_p=top_p
            ):
                yield json.dumps(
                    {
                        "model": req.model,
                        "created_at": _now(),
                        "response": chunk.text,
                        "done": False,
                    }
                ) + "\n"
                if chunk.done:
                    final_reason = chunk.finish_reason
            yield json.dumps(
                {
                    "model": req.model,
                    "created_at": _now(),
                    "response": "",
                    "done": True,
                    "done_reason": final_reason or "stop",
                }
            ) + "\n"

        return StreamingResponse(event_stream(), media_type="application/x-ndjson")

    content = ""
    final_reason: str | None = None
    async for chunk in runner.stream_generate(
        model_id, req.prompt, max_tokens=max_tokens, temperature=temp, top_p=top_p
    ):
        content += chunk.text
        if chunk.done:
            final_reason = chunk.finish_reason
    return {
        "model": req.model,
        "created_at": _now(),
        "response": content,
        "done": True,
        "done_reason": final_reason or "stop",
    }


@router.post("/api/pull")
async def pull(req: OllamaPullRequest):
    task = await downloader.start_download(req.name)
    if not req.stream:
        return {"status": "pulling", "task_id": task.task_id, "repo_id": task.repo_id}

    async def event_stream():
        yield json.dumps({"status": "pulling manifest", "digest": task.repo_id}) + "\n"
        while True:
            await asyncio.sleep(0.5)
            t = downloader.get_task(task.task_id)
            if t is None:
                break
            yield json.dumps({"status": t.status, "digest": t.repo_id}) + "\n"
            if t.status in ("done", "error"):
                break
        final = "success" if task.status == "done" else "error"
        payload: dict[str, Any] = {"status": final, "digest": task.repo_id}
        if task.error:
            payload["error"] = task.error
        yield json.dumps(payload) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
