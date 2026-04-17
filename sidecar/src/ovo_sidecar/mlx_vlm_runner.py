import asyncio
import base64
import binascii
import io
import logging
import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class LoadedVlmModel:
    ref: str
    snapshot_path: Path | None
    model: Any
    processor: Any
    config: Any


@dataclass
class VlmChatMessage:
    role: str
    content: str
    images: list[str] = field(default_factory=list)
    audios: list[str] = field(default_factory=list)


@dataclass
class GenerationChunk:
    text: str
    token: int | None = None
    done: bool = False
    finish_reason: str | None = None
    prompt_tokens: int | None = None
    generation_tokens: int | None = None


# [START] Image source resolution — mlx-vlm accepts path/URL strings and PIL Images.
# Data URLs (`data:image/png;base64,...`) must be decoded locally since mlx-vlm
# doesn't parse them. Http(s) URLs and local paths pass through unchanged.
def _decode_image(src: str):
    if src.startswith("data:"):
        from PIL import Image

        _, _, b64 = src.partition(",")
        try:
            data = base64.b64decode(b64, validate=False)
        except (binascii.Error, ValueError) as e:
            raise ValueError(f"invalid data URL: {e}") from e
        return Image.open(io.BytesIO(data)).convert("RGB")
    return src
# [END]


# [START] Audio source resolution — mlx-vlm stream_generate accepts file paths.
# Data URLs (`data:audio/mpeg;base64,...`) are written to a temp file so
# mlx-vlm's miniaudio-based decoder can read them by path.
def _decode_audio(src: str) -> str:
    """Return a filesystem path mlx-vlm can open.

    For data URLs: decode base64 payload, write to a NamedTemporaryFile (not
    auto-deleted so the path stays valid until the caller is done), and return
    the path string.  The caller is responsible for cleanup if needed; since
    audio inference is a one-shot request the OS will reclaim the file after
    the process exits.
    """
    if not src.startswith("data:"):
        return src
    header, _, b64 = src.partition(",")
    # header looks like "data:audio/mpeg;base64"
    mime = header[5:].split(";")[0]  # e.g. "audio/mpeg"
    subtype = mime.split("/")[-1] if "/" in mime else "bin"
    # Normalise common MIME subtypes to recognised extensions
    ext_map = {"mpeg": "mp3", "x-m4a": "m4a", "mp4": "m4a"}
    ext = ext_map.get(subtype, subtype)
    try:
        data = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"invalid audio data URL: {e}") from e
    import tempfile

    tmp = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
    tmp.write(data)
    tmp.flush()
    tmp.close()
    return tmp.name
# [END]


class MlxVlmRunner:
    """Thread-safe wrapper around mlx-vlm load + stream_generate.

    Mirrors MlxRunner but loads (model, processor) and passes a flat images
    list alongside the chat-template-formatted prompt.
    """

    def __init__(self) -> None:
        self._loaded: LoadedVlmModel | None = None
        self._load_lock = asyncio.Lock()
        # [START] Track in-flight worker for preemptive cancel on model swap.
        self._active_cancel: threading.Event | None = None
        self._active_thread: threading.Thread | None = None
        # [END]
        from ovo_sidecar import model_lifecycle

        model_lifecycle.register_unloader(self.unload)

    def unload(self) -> None:
        """Drop cached VLM model + force Metal cache release.

        Signals + joins the active worker so the old model reference is
        released from thread-local scope before Metal cache is cleared.
        """
        # [START] Preemptive worker cancel — mirrors mlx_runner pattern.
        if self._active_cancel is not None:
            self._active_cancel.set()
        if self._active_thread is not None and self._active_thread.is_alive():
            self._active_thread.join(timeout=2.0)
        self._active_cancel = None
        self._active_thread = None
        # [END]
        if self._loaded is None:
            return
        from ovo_sidecar import model_lifecycle

        logger.info("unloading MLX-VLM model: %s", self._loaded.ref)
        self._loaded = None
        model_lifecycle.release_gpu_memory()

    async def ensure_loaded(self, model_ref: str | Path) -> LoadedVlmModel:
        ref_str = str(model_ref)
        async with self._load_lock:
            if self._loaded is not None and self._loaded.ref == ref_str:
                return self._loaded
            # [START] Single-slot tenancy — unload self + sibling text runner
            # before loading new VLM so unified memory doesn't double-book.
            self.unload()
            from ovo_sidecar import model_lifecycle

            model_lifecycle.unload_others(skip=self.unload)
            # [END]
            logger.info("loading MLX-VLM model: %s", ref_str)
            loaded = await asyncio.to_thread(self._load, ref_str)
            self._loaded = loaded
            return loaded

    def _load(self, ref: str) -> LoadedVlmModel:
        from mlx_vlm import load  # heavy, imported lazily

        path: Path | None = None
        maybe_path = Path(ref)
        if maybe_path.exists():
            path = maybe_path

        model, processor = load(ref if path is None else str(path))
        config = getattr(model, "config", None)
        return LoadedVlmModel(
            ref=ref,
            snapshot_path=path,
            model=model,
            processor=processor,
            config=config,
        )

    async def stream_chat(
        self,
        model_ref: str | Path,
        messages: list[VlmChatMessage],
        max_tokens: int = 512,
        temperature: float | None = None,
        top_p: float | None = None,
    ) -> AsyncIterator[GenerationChunk]:
        loaded = await self.ensure_loaded(model_ref)

        # [START] Flatten images and audios across all turns.
        # apply_chat_template needs the counts; stream_generate needs the decoded values.
        images: list = []
        for m in messages:
            for src in m.images:
                images.append(_decode_image(src))

        audios: list[str] = []
        for m in messages:
            for src in m.audios:
                audios.append(_decode_audio(src))
        # [END]

        from mlx_vlm.prompt_utils import apply_chat_template

        flat_msgs = [{"role": m.role, "content": m.content} for m in messages]
        formatted = apply_chat_template(
            loaded.processor,
            loaded.config,
            flat_msgs,
            num_images=len(images),
            num_audios=len(audios),
        )

        async for chunk in self._astream(loaded, formatted, images, audios, max_tokens, temperature, top_p):
            yield chunk

    # [START] Token counting — VLMs format the prompt with apply_chat_template
    # that injects image/audio placeholders; count AFTER formatting so the number
    # reflects what the model actually sees.
    async def count_tokens(
        self,
        model_ref: str | Path,
        messages: list[VlmChatMessage],
    ) -> int:
        loaded = await self.ensure_loaded(model_ref)
        from mlx_vlm.prompt_utils import apply_chat_template

        flat_msgs = [{"role": m.role, "content": m.content} for m in messages]
        num_images = sum(len(m.images) for m in messages)
        num_audios = sum(len(m.audios) for m in messages)
        formatted = apply_chat_template(
            loaded.processor,
            loaded.config,
            flat_msgs,
            num_images=num_images,
            num_audios=num_audios,
        )
        # processors expose `tokenizer` attr; fall back to processor.encode
        tokenizer = getattr(loaded.processor, "tokenizer", None) or loaded.processor
        encode = getattr(tokenizer, "encode", None)
        if callable(encode):
            try:
                tokens = encode(formatted)
                return len(tokens)
            except Exception as e:
                logger.debug("vlm tokenizer.encode failed, approximating: %s", e)
        return max(1, len(formatted) // 4)
    # [END]

    async def _astream(
        self,
        loaded: LoadedVlmModel,
        prompt: str,
        images: list,
        audios: list[str],
        max_tokens: int,
        temperature: float | None,
        top_p: float | None,
    ) -> AsyncIterator[GenerationChunk]:
        from mlx_vlm import stream_generate

        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        # [START] Cancellable worker — matches mlx_runner.py pattern. Signals
        # the MLX loop via threading.Event when the consumer is cancelled so
        # stream_generate stops instead of pushing to a dead queue.
        cancelled = threading.Event()

        def safe_put(item) -> bool:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, item)
                return True
            except RuntimeError:
                cancelled.set()
                return False

        def worker() -> None:
            try:
                kwargs: dict = {"max_tokens": max_tokens}
                if temperature is not None:
                    kwargs["temperature"] = float(temperature)
                if top_p is not None:
                    kwargs["top_p"] = float(top_p)
                # [START] Pass audio paths when present; stream_generate kwarg is `audio`
                if audios:
                    kwargs["audio"] = audios if len(audios) > 1 else audios[0]
                # [END]

                for chunk in stream_generate(
                    loaded.model, loaded.processor, prompt, images, **kwargs
                ):
                    if cancelled.is_set():
                        break
                    text = getattr(chunk, "text", "") or ""
                    finish = getattr(chunk, "finish_reason", None)
                    out = GenerationChunk(
                        text=text,
                        token=getattr(chunk, "token", None),
                        done=finish is not None,
                        finish_reason=finish,
                        prompt_tokens=getattr(chunk, "prompt_tokens", None),
                        generation_tokens=getattr(chunk, "generation_tokens", None),
                    )
                    if not safe_put(out):
                        break
            except BaseException as e:
                safe_put(e)
            finally:
                safe_put(None)

        # [START] Expose worker handles on self for preemptive cancel on swap.
        worker_thread = threading.Thread(target=worker, daemon=True, name="mlx-vlm-stream")
        self._active_cancel = cancelled
        self._active_thread = worker_thread
        worker_thread.start()
        # [END]

        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            cancelled.set()
            if self._active_cancel is cancelled:
                self._active_cancel = None
                self._active_thread = None
        # [END]


vlm_runner = MlxVlmRunner()
