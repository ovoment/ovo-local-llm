import asyncio
import logging
import traceback

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ovo_sidecar import __version__
from ovo_sidecar.api import ollama, openai, ovo
from ovo_sidecar.config import settings

logger = logging.getLogger("ovo_sidecar")


def create_app(api_flavor: str) -> FastAPI:
    app = FastAPI(
        title=f"OVO Sidecar ({api_flavor})",
        version=__version__,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if settings.expose_to_network else ["http://localhost:1420", "tauri://localhost"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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
