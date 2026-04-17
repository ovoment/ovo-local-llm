import json
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ovo_sidecar import hf_scanner
from ovo_sidecar.config import settings
from ovo_sidecar.mlx_runner import ChatMessage, runner
from ovo_sidecar.registry import registry

logger = logging.getLogger(__name__)
router = APIRouter(tags=["openai"])


class OpenAIMessage(BaseModel):
    role: str
    content: str


class OpenAIChatRequest(BaseModel):
    model: str
    messages: list[OpenAIMessage]
    stream: bool = False
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None


class OpenAICompletionRequest(BaseModel):
    model: str
    prompt: str
    stream: bool = False
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None


def _cap(mt: int | None) -> int:
    if mt is None:
        return settings.max_tokens_cap
    return min(int(mt), settings.max_tokens_cap)


# [START] resolve alias + local path so mlx-lm gets a filesystem path when available
def _resolve_ref(name: str):
    repo_id = registry.resolve(name)
    local = hf_scanner.resolve_path(repo_id)
    return local if local is not None else repo_id
# [END]


@router.get("/models")
async def list_models() -> dict[str, Any]:
    # [START] merged HF + LM Studio scan
    scanned = hf_scanner.scan_all()
    return {
        "object": "list",
        "data": [
            {"id": m.repo_id, "object": "model", "created": 0, "owned_by": m.source}
            for m in scanned
            if m.is_mlx
        ],
    }
    # [END]


@router.post("/chat/completions")
async def chat_completions(req: OpenAIChatRequest):
    model_id = _resolve_ref(req.model)
    messages = [ChatMessage(role=m.role, content=m.content) for m in req.messages]
    max_tokens = _cap(req.max_tokens)
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    if req.stream:

        async def event_stream():
            first = True
            final_reason = "stop"
            async for chunk in runner.stream_chat(
                model_id,
                messages,
                max_tokens=max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
            ):
                delta: dict[str, Any] = {"content": chunk.text}
                if first:
                    delta = {"role": "assistant", "content": chunk.text}
                    first = False
                payload = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": req.model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                }
                yield f"data: {json.dumps(payload)}\n\n"
                if chunk.done:
                    final_reason = chunk.finish_reason or "stop"
            end = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": req.model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": final_reason}],
            }
            yield f"data: {json.dumps(end)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    content = ""
    final_reason = "stop"
    prompt_tokens = 0
    gen_tokens = 0
    async for chunk in runner.stream_chat(
        model_id,
        messages,
        max_tokens=max_tokens,
        temperature=req.temperature,
        top_p=req.top_p,
    ):
        content += chunk.text
        if chunk.done:
            final_reason = chunk.finish_reason or "stop"
            prompt_tokens = chunk.prompt_tokens or 0
            gen_tokens = chunk.generation_tokens or 0

    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": final_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": gen_tokens,
            "total_tokens": prompt_tokens + gen_tokens,
        },
    }


@router.post("/completions")
async def completions(req: OpenAICompletionRequest):
    model_id = _resolve_ref(req.model)
    max_tokens = _cap(req.max_tokens)
    completion_id = f"cmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    if req.stream:

        async def event_stream():
            final_reason = "stop"
            async for chunk in runner.stream_generate(
                model_id,
                req.prompt,
                max_tokens=max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
            ):
                payload = {
                    "id": completion_id,
                    "object": "text_completion",
                    "created": created,
                    "model": req.model,
                    "choices": [{"text": chunk.text, "index": 0, "finish_reason": None}],
                }
                yield f"data: {json.dumps(payload)}\n\n"
                if chunk.done:
                    final_reason = chunk.finish_reason or "stop"
            end = {
                "id": completion_id,
                "object": "text_completion",
                "created": created,
                "model": req.model,
                "choices": [{"text": "", "index": 0, "finish_reason": final_reason}],
            }
            yield f"data: {json.dumps(end)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    text = ""
    final_reason = "stop"
    async for chunk in runner.stream_generate(
        model_id,
        req.prompt,
        max_tokens=max_tokens,
        temperature=req.temperature,
        top_p=req.top_p,
    ):
        text += chunk.text
        if chunk.done:
            final_reason = chunk.finish_reason or "stop"

    return {
        "id": completion_id,
        "object": "text_completion",
        "created": created,
        "model": req.model,
        "choices": [{"text": text, "index": 0, "finish_reason": final_reason}],
    }
