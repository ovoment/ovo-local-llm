import logging
import shutil
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ovo_sidecar import hf_scanner
from ovo_sidecar.config import settings
from ovo_sidecar.hf_downloader import DownloadTask, downloader
from ovo_sidecar.mlx_runner import ChatMessage, runner
from ovo_sidecar.mlx_vlm_runner import VlmChatMessage, vlm_runner
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
        # [START] capabilities gate client-side features (e.g. image attachments)
        "capabilities": list(m.capabilities),
        # [END]
        # [START] max_context — UI denominator for the ContextIndicator; may be
        # overridden per-repo via model_context_overrides table on the frontend.
        "max_context": m.max_context,
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


# [START] Context management endpoints — used by the frontend's session store
# and auto-compact engine. Both accept the same OpenAI-ish message shape so
# the UI can reuse the same serializer.
class CountMessage(BaseModel):
    role: str
    content: str
    images: list[str] | None = None
    audios: list[str] | None = None


class CountTokensRequest(BaseModel):
    model: str
    messages: list[CountMessage]


def _resolve_ref_for_ovo(name: str):
    repo_id = registry.resolve(name)
    local = hf_scanner.resolve_path(repo_id)
    return local if local is not None else repo_id


@router.post("/count_tokens")
async def count_tokens(req: CountTokensRequest) -> dict[str, Any]:
    """Return the exact prompt token count for the given conversation.

    Routes through the VLM runner when the model declares vision capability
    so chat-template formatting (including image placeholders) matches what
    the OpenAI endpoint would eventually send.
    """
    model_id = _resolve_ref_for_ovo(req.model)
    repo_id = registry.resolve(req.model)
    caps = hf_scanner.resolve_capabilities(repo_id)
    use_vlm = "vision" in caps or "audio" in caps

    if use_vlm:
        vlm_messages = [
            VlmChatMessage(
                role=m.role,
                content=m.content,
                images=m.images or [],
                audios=m.audios or [],
            )
            for m in req.messages
        ]
        count = await vlm_runner.count_tokens(model_id, vlm_messages)
    else:
        text_messages = [ChatMessage(role=m.role, content=m.content) for m in req.messages]
        count = await runner.count_tokens(model_id, text_messages)

    return {"model": req.model, "prompt_tokens": count}


class SummarizeRequest(BaseModel):
    model: str
    messages: list[CountMessage]
    max_tokens: int = 512
    instruction: str | None = None


_DEFAULT_SUMMARY_INSTRUCTION = (
    "You are a summarization assistant. Produce a concise third-person summary "
    "of the conversation turns above in under 200 words. Preserve: user goals, "
    "key facts, decisions made, open questions, code references. Omit small talk. "
    "Start immediately with the summary — no preamble."
)


@router.post("/summarize")
async def summarize(req: SummarizeRequest) -> dict[str, Any]:
    """Summarize a slice of messages using the SAME loaded model.

    Non-streaming — auto-compact engine just needs the finished text. VLMs
    summarize text-only (strip attached images; summaries don't need pixels).
    """
    model_id = _resolve_ref_for_ovo(req.model)

    instruction = req.instruction or _DEFAULT_SUMMARY_INSTRUCTION
    text_messages = [ChatMessage(role=m.role, content=m.content) for m in req.messages]
    text_messages.append(ChatMessage(role="user", content=instruction))

    summary = ""
    prompt_tokens = 0
    gen_tokens = 0
    async for chunk in runner.stream_chat(
        model_id,
        text_messages,
        max_tokens=req.max_tokens,
    ):
        summary += chunk.text
        if chunk.done:
            prompt_tokens = chunk.prompt_tokens or 0
            gen_tokens = chunk.generation_tokens or 0

    return {
        "model": req.model,
        "summary": summary.strip(),
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": gen_tokens,
            "total_tokens": prompt_tokens + gen_tokens,
        },
    }


# [START] Explicit unload — lets the UI drop a loaded model immediately when
# the user swaps in the selector (otherwise unload is lazy and only happens
# when the next request arrives for a different model_ref).
@router.post("/unload")
async def unload_loaded_models() -> dict[str, Any]:
    """Unload every runner's currently-loaded model + clear Metal cache.

    Returns which runner(s) held a model so the caller can log what was
    freed. Never raises — best-effort cleanup.
    """
    from ovo_sidecar import model_lifecycle

    freed: list[str] = []
    if runner._loaded is not None:
        freed.append(f"text:{runner._loaded.ref}")
    if vlm_runner._loaded is not None:
        freed.append(f"vlm:{vlm_runner._loaded.ref}")

    # Signal every registered unloader (text + VLM + future runners).
    model_lifecycle.unload_others(skip=None)
    model_lifecycle.release_gpu_memory()
    return {"freed": freed}
# [END]


# [START] Phase 6.4 — built-in web search (key-less).
# Backed by duckduckgo-search so the OVO frontend can expose a 'web_search'
# tool that works out of the box without the user registering any API key.
# Intentionally kept minimal: title / url / snippet per hit, capped result
# count, no infinite pagination.
class WebSearchRequest(BaseModel):
    query: str
    limit: int = 8


class WebSearchHit(BaseModel):
    title: str
    url: str
    snippet: str


class WebSearchResponse(BaseModel):
    query: str
    results: list[WebSearchHit]


@router.post("/websearch", response_model=WebSearchResponse)
async def websearch(req: WebSearchRequest) -> WebSearchResponse:
    """Return DuckDuckGo text search hits for the given query.

    Runs the (sync) duckduckgo-search client in a worker thread so the
    event loop isn't blocked. Errors bubble up as HTTP 502 — callers
    should treat the tool as best-effort and fall back gracefully.
    """
    import asyncio

    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="empty query")
    limit = max(1, min(req.limit, 20))

    # [START] Try duckduckgo-search first; fall back to httpx + DDG Lite
    # scraping so web search works even when the pip package hasn't been
    # synced into the sidecar venv yet (user would otherwise hit 501 until
    # they manually run `uv sync`).
    raw: list[dict[str, Any]] = []
    used_fallback = False
    try:
        from duckduckgo_search import DDGS

        def _run() -> list[dict[str, Any]]:
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=limit))

        try:
            raw = await asyncio.to_thread(_run)
        except Exception as e:
            logger.warning("duckduckgo-search failed, trying fallback: %s", e)
            used_fallback = True
    except Exception as e:
        logger.info("duckduckgo-search not available, using httpx fallback: %s", e)
        used_fallback = True

    if used_fallback:
        # DDG Lite is a minimal HTML endpoint without JS. Parse the result
        # blocks with a tolerant regex pass — good enough for top-N hits.
        import re

        import httpx

        try:
            async with httpx.AsyncClient(
                timeout=10.0,
                headers={"User-Agent": "OVO/0.0.1 (web search)"},
                follow_redirects=True,
            ) as client:
                resp = await client.get(
                    "https://html.duckduckgo.com/html/",
                    params={"q": query},
                )
                resp.raise_for_status()
                html = resp.text
        except Exception as e:
            logger.warning("DDG fallback fetch failed: %s", e)
            raise HTTPException(status_code=502, detail=f"web search failed: {e}") from e

        pattern = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>'
            r'[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
            re.IGNORECASE,
        )
        tag_strip = re.compile(r"<[^>]+>")
        for match in pattern.finditer(html):
            href = match.group(1).strip()
            title = tag_strip.sub("", match.group(2) or "").strip()
            snippet = tag_strip.sub("", match.group(3) or "").strip()
            # DDG wraps redirect URLs like //duckduckgo.com/l/?uddg=... — try to
            # unwrap so downstream consumers see the real target.
            m = re.search(r"uddg=([^&]+)", href)
            if m:
                from urllib.parse import unquote

                href = unquote(m.group(1))
            raw.append({"title": title, "href": href, "body": snippet})
            if len(raw) >= limit:
                break
    # [END]

    hits: list[WebSearchHit] = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        hits.append(
            WebSearchHit(
                title=str(r.get("title") or ""),
                url=str(r.get("href") or r.get("url") or ""),
                snippet=str(r.get("body") or r.get("snippet") or ""),
            )
        )
    return WebSearchResponse(query=query, results=hits)
# [END]
