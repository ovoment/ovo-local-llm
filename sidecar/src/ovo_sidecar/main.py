import asyncio
import logging
import secrets
import traceback

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ovo_sidecar import __version__
from ovo_sidecar.api import ollama, openai, ovo, parsing, finetune, blending
from ovo_sidecar.config import settings

logger = logging.getLogger("ovo_sidecar")


# [START] Phase 5 — LAN exposure auth token.
# When `expose_to_network=true` the sidecar binds 0.0.0.0, making it reachable
# by every device (and every malicious site served to the user's browser) on
# the LAN. Without auth any neighbour can invoke `/ovo/tool_call`, flip
# `expose_to_network` back on if someone tries to disable it, or read
# attachments. We gate every non-loopback request behind a bearer token
# generated on first run and persisted under data_dir (chmod 600). Loopback
# callers (the Tauri frontend, local curl testing) bypass the check so the
# app-level UX isn't disturbed.
def _load_or_create_auth_token() -> str:
    path = settings.data_dir / "auth_token.txt"
    try:
        if path.exists():
            return path.read_text().strip()
    except OSError as e:
        logger.warning("auth token read failed: %s", e)
    tok = secrets.token_urlsafe(32)
    try:
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(tok)
        try:
            import os as _os
            _os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError as e:
        logger.warning("auth token write failed: %s", e)
    return tok


AUTH_TOKEN = _load_or_create_auth_token()
logger.info("sidecar auth token loaded (expose=%s)", settings.expose_to_network)


async def _auth_guard(request: Request, call_next):
    # Loopback is always trusted — Tauri webview & local curl.
    client = request.client.host if request.client else ""
    if client in ("127.0.0.1", "::1", "localhost") or not settings.expose_to_network:
        return await call_next(request)
    # Allow unauthenticated health probe so network monitoring tools still work.
    if request.url.path == "/healthz":
        return await call_next(request)
    header = request.headers.get("authorization") or ""
    if not header.startswith("Bearer ") or header[7:].strip() != AUTH_TOKEN:
        return JSONResponse(
            status_code=401,
            content={"error": {"type": "Unauthorized", "message": "bearer token required"}},
        )
    return await call_next(request)
# [END]


def create_app(api_flavor: str) -> FastAPI:
    app = FastAPI(
        title=f"OVO Sidecar ({api_flavor})",
        version=__version__,
    )
    # [START] Phase 5 — tightened CORS.
    # `allow_origins=["*"]` combined with `allow_credentials=True` is
    # rejected by browsers, and lets any site request the API from the
    # user's browser. We restrict to the Tauri webview origin plus local
    # dev (Vite) even in exposed mode; external clients authenticate via
    # Authorization header and don't need CORS anyway.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "tauri://localhost",
            "http://tauri.localhost",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # [END]
    # [START] Phase 5 — bearer auth guard for exposed mode.
    app.middleware("http")(_auth_guard)
    # [END]

    # [START] Catch-all exception handler — returns a JSONResponse via FastAPI's
    # exception path so the response traverses CORSMiddleware on the way out and
    # gets proper Access-Control-Allow-Origin headers. Without this, Starlette's
    # ServerErrorMiddleware short-circuits with a bare 500 that the webview sees
    # as a CORS violation → "TypeError: Load failed" in the UI, masking the real
    # error. Preserves HTTPException behavior (handled separately by FastAPI).
    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "type": exc.__class__.__name__,
                    "message": str(exc) or "internal server error",
                    # Full traceback only when debugging — stays behind log_level.
                    "trace": traceback.format_exc() if settings.log_level.lower() == "debug" else None,
                }
            },
        )
    # [END]

    if api_flavor == "ollama":
        app.include_router(ollama.router)
    elif api_flavor == "openai":
        app.include_router(openai.router, prefix="/v1")
    elif api_flavor == "ovo":
        app.include_router(ovo.router, prefix="/ovo")
        app.include_router(parsing.router, prefix="/ovo")
        app.include_router(finetune.router, prefix="/ovo")
        app.include_router(blending.router, prefix="/ovo")

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok", "flavor": api_flavor, "version": __version__}

    return app


async def _run_server(app: FastAPI, port: int) -> None:
    host = "0.0.0.0" if settings.expose_to_network else "127.0.0.1"
    config = uvicorn.Config(app, host=host, port=port, log_level=settings.log_level)
    server = uvicorn.Server(config)
    await server.serve()


async def _main() -> None:
    settings.ensure_dirs()
    # [START] Phase 8 — MLX memory discipline.
    # Cap MLX's Metal allocator + kernel cache before any model loads so we
    # never drift into macOS swap territory. See model_lifecycle.py for the
    # budget math; this is purely a startup hook.
    from ovo_sidecar.model_lifecycle import configure_memory_limits

    configure_memory_limits()
    # [END]
    logger.info("OVO sidecar %s starting on ports %d/%d/%d", __version__, settings.ollama_port, settings.openai_port, settings.native_port)
    await asyncio.gather(
        _run_server(create_app("ollama"), settings.ollama_port),
        _run_server(create_app("openai"), settings.openai_port),
        _run_server(create_app("ovo"), settings.native_port),
    )


def run() -> None:
    logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(name)s %(levelname)s: %(message)s")
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        logger.info("shutdown")


if __name__ == "__main__":
    run()
