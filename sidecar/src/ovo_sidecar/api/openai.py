import json
import logging
import time
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ovo_sidecar import hf_scanner
from ovo_sidecar.config import settings
from ovo_sidecar.mlx_runner import ChatMessage, runner
from ovo_sidecar.mlx_vlm_runner import VlmChatMessage, vlm_runner
from ovo_sidecar.registry import registry

logger = logging.getLogger(__name__)
router = APIRouter(tags=["openai"])


# [START] OpenAI content-parts — `content` may be a plain string OR a list of
# parts mixing text and image_url. We accept both shapes and normalize downstream.
class OpenAITextPart(BaseModel):
    type: Literal["text"]
    text: str


class OpenAIImageUrlBody(BaseModel):
    url: str


class OpenAIImagePart(BaseModel):
    type: Literal["image_url"]
    image_url: OpenAIImageUrlBody


OpenAIContentPart = OpenAITextPart | OpenAIImagePart


class OpenAIMessage(BaseModel):
    role: str
    content: str | list[OpenAIContentPart]


def _split_content(content: str | list[OpenAIContentPart]) -> tuple[str, list[str]]:
    if isinstance(content, str):
        return content, []
    text_parts: list[str] = []
    images: list[str] = []
    for p in content:
        if isinstance(p, OpenAITextPart):
            text_parts.append(p.text)
        else:
            images.append(p.image_url.url)
    return "\n".join(text_parts), images
# [END]


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
    max_tokens = _cap(req.max_tokens)
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    # [START] Capability-based routing: vision-capable models go through mlx-vlm
    # which handles both text-only and image-bearing turns; text-only models
    # reject images to surface the mismatch loudly instead of silently dropping.
    repo_id = registry.resolve(req.model)
    caps = hf_scanner.resolve_capabilities(repo_id)
    is_vision = "vision" in caps

    normalized: list[tuple[str, str, list[str]]] = []
    for m in req.messages:
        text, images = _split_content(m.content)
        normalized.append((m.role, text, images))

    has_any_images = any(imgs for _, _, imgs in normalized)
    if has_any_images and not is_vision:
        raise HTTPException(
            status_code=400,
            detail=(
                f"model {req.model} is text-only; attach-capable models must declare "
                f"the 'vision' capability (e.g. Qwen2-VL, LLaVA, Gemma3)."
            ),
        )
    # [END]

    if is_vision:
        vlm_messages = [VlmChatMessage(role=r, content=t, images=imgs) for r, t, imgs in normalized]

        def _vlm_stream():
            return vlm_runner.stream_chat(
                model_id,
                vlm_messages,
                max_tokens=max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
            )

        stream_iter = _vlm_stream
    else:
        text_messages = [ChatMessage(role=r, content=t) for r, t, _ in normalized]

        def _text_stream():
            return runner.stream_chat(
                model_id,
                text_messages,
                max_tokens=max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
            )

        stream_iter = _text_stream

    if req.stream:

        async def event_stream():
            first = True
            final_reason = "stop"
            # [START] Guarded streaming — once response headers are sent (200),
            # an exception from the generator silently aborts the connection and
            # surfaces in the webview as "TypeError: Load failed". Catch here and
            # emit a final OpenAI-style error frame so the UI can render it.
            try:
                async for chunk in stream_iter():
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
            except Exception as e:
                logger.exception("chat stream failed")
                err = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": req.model,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "error"}
                    ],
                    "error": {"type": e.__class__.__name__, "message": str(e) or "stream failed"},
                }
                yield f"data: {json.dumps(err)}\n\n"
                yield "data: [DONE]\n\n"
                return
            # [END]
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
    async for chunk in stream_iter():
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
