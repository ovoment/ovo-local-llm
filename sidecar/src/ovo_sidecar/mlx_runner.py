import asyncio
import glob
import json
import logging
import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


# [START] Mixed-precision quantization autodetect — some community quants
# (e.g. JANGQ MiniMax-M2) ship embed_tokens / lm_head at higher bits than the
# declared `quantization.bits` in config.json. mlx-lm 0.31+ supports per-module
# overrides via `config["quantization"][module_name] = {"bits": ..., "group_size": ...}`,
# but only if the config actually carries them. Scan safetensor shapes and inject
# overrides so any user-downloaded mixed-precision model loads correctly.
_VALID_BITS = (2, 3, 4, 6, 8)


def _infer_quant_overrides(model_path: Path) -> dict | None:
    """Scan safetensors; return patched `quantization` dict or None if no
    overrides are needed. Reads only tensor *metadata* — no weight data.
    """
    cfg_path = model_path / "config.json"
    if not cfg_path.exists():
        return None

    try:
        config = json.loads(cfg_path.read_text())
    except Exception as e:
        logger.debug("quant autodetect: config.json unreadable: %s", e)
        return None

    # Only the `quantization` (affine) path uses per-module overrides; bitnet/
    # mxfp4/awq/gptq live under `quantization_config` with their own handling.
    quant = config.get("quantization")
    if not isinstance(quant, dict) or "bits" not in quant or "group_size" not in quant:
        return None

    try:
        declared_bits = int(quant["bits"])
        group_size = int(quant["group_size"])
    except (TypeError, ValueError):
        return None

    try:
        from safetensors import safe_open
    except ImportError:
        logger.debug("quant autodetect: safetensors not available")
        return None

    overrides: dict[str, dict] = {}
    shards = sorted(glob.glob(str(model_path / "model*.safetensors")))
    if not shards:
        return None

    for shard in shards:
        try:
            with safe_open(shard, framework="np") as sf:
                keys = list(sf.keys())
                key_set = set(keys)
                for key in keys:
                    if not key.endswith(".scales"):
                        continue
                    weight_key = key[:-len(".scales")] + ".weight"
                    if weight_key not in key_set:
                        continue
                    try:
                        scales_shape = sf.get_slice(key).get_shape()
                        weight_shape = sf.get_slice(weight_key).get_shape()
                    except Exception:
                        continue
                    if len(scales_shape) < 2 or len(weight_shape) < 2:
                        continue
                    groups = scales_shape[-1]
                    packed_cols = weight_shape[-1]
                    in_real = groups * group_size
                    if in_real <= 0 or packed_cols <= 0:
                        continue
                    # packed is uint32; each element packs 32/bits values → bits = packed*32/in_real
                    numer = packed_cols * 32
                    if numer % in_real != 0:
                        continue
                    bits = numer // in_real
                    if bits == declared_bits or bits not in _VALID_BITS:
                        continue
                    module = weight_key[:-len(".weight")]
                    overrides[module] = {"bits": bits, "group_size": group_size}
        except Exception as e:
            logger.debug("quant autodetect: skipping %s (%s)", shard, e)
            continue

    if not overrides:
        return None

    patched = dict(quant)
    patched.update(overrides)
    logger.info(
        "mixed-quant autodetect: base=%dbit, %d module override(s): %s",
        declared_bits,
        len(overrides),
        ", ".join(sorted(overrides.keys())[:5]) + ("..." if len(overrides) > 5 else ""),
    )
    return patched
# [END]


@dataclass
class LoadedModel:
    ref: str
    snapshot_path: Path | None
    model: object
    tokenizer: object


@dataclass
class ChatMessage:
    role: str
    content: str


@dataclass
class GenerationChunk:
    text: str
    token: int | None = None
    done: bool = False
    finish_reason: str | None = None
    prompt_tokens: int | None = None
    generation_tokens: int | None = None


class MlxRunner:
    """Thread-safe wrapper around mlx-lm load + stream_generate.

    Keeps at most one model in memory; loading a different ref swaps it.
    Streaming works by pushing GenerationResponse chunks from a worker
    thread onto an asyncio.Queue consumed by async generators.
    """

    def __init__(self) -> None:
        self._loaded: LoadedModel | None = None
        self._load_lock = asyncio.Lock()
        # [START] Track the in-flight worker so unload() can signal it to exit
        # before a model swap — prevents zombie threads holding the old model.
        self._active_cancel: threading.Event | None = None
        self._active_thread: threading.Thread | None = None
        # [END]
        from ovo_sidecar import model_lifecycle

        model_lifecycle.register_unloader(self.unload)

    def unload(self) -> None:
        """Drop cached model + force Metal cache release.

        Signals the active worker (if any) and waits briefly so the thread
        releases its reference to the old weights before Metal cache clears.
        """
        # [START] Cancel + join active worker BEFORE dropping the reference so
        # Python GC can actually reclaim the old model on Metal.
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

        logger.info("unloading MLX model: %s", self._loaded.ref)
        self._loaded = None
        model_lifecycle.release_gpu_memory()

    async def ensure_loaded(self, model_ref: str | Path) -> LoadedModel:
        ref_str = str(model_ref)
        async with self._load_lock:
            if self._loaded is not None and self._loaded.ref == ref_str:
                return self._loaded
            # [START] Single-slot tenancy — kill the old model (self + sibling
            # runners) before loading a new one so unified memory isn't doubly
            # occupied. Users repeatedly swapping 31B-class models otherwise OOM.
            self.unload()
            from ovo_sidecar import model_lifecycle

            model_lifecycle.unload_others(skip=self.unload)
            # [END]
            logger.info("loading MLX model: %s", ref_str)
            loaded = await asyncio.to_thread(self._load, ref_str)
            self._loaded = loaded
            return loaded

    def _load(self, ref: str) -> LoadedModel:
        from mlx_lm import load  # heavy, imported lazily

        path: Path | None = None
        maybe_path = Path(ref)
        if maybe_path.exists():
            path = maybe_path

        # [START] inject per-module quantization overrides for mixed-precision
        # community quants; no-op for standard uniform-bits models
        model_config: dict | None = None
        if path is not None:
            patched_quant = _infer_quant_overrides(path)
            if patched_quant is not None:
                model_config = {"quantization": patched_quant}
        # [END]

        target = ref if path is None else str(path)
        if model_config is not None:
            model, tokenizer = load(target, model_config=model_config)
        else:
            model, tokenizer = load(target)
        return LoadedModel(ref=ref, snapshot_path=path, model=model, tokenizer=tokenizer)

    async def stream_chat(
        self,
        model_ref: str | Path,
        messages: list[ChatMessage],
        max_tokens: int = 512,
        temperature: float | None = None,
        top_p: float | None = None,
        repetition_penalty: float | None = None,
    ) -> AsyncIterator[GenerationChunk]:
        loaded = await self.ensure_loaded(model_ref)
        prompt = self._apply_chat_template(loaded.tokenizer, messages)
        async for chunk in self._astream(
            loaded, prompt, max_tokens, temperature, top_p, repetition_penalty
        ):
            yield chunk

    # [START] Token counting — preview how many prompt tokens a pending turn
    # will consume BEFORE sending. Reuses the loaded model's tokenizer so the
    # preview matches server-side usage exactly. Loads the model if not yet
    # resident (single-slot tenancy still applies).
    async def count_tokens(
        self,
        model_ref: str | Path,
        messages: list[ChatMessage],
    ) -> int:
        loaded = await self.ensure_loaded(model_ref)
        prompt = self._apply_chat_template(loaded.tokenizer, messages)
        encode = getattr(loaded.tokenizer, "encode", None)
        if callable(encode):
            try:
                tokens = encode(prompt)
                return len(tokens)
            except Exception as e:
                logger.debug("tokenizer.encode failed, approximating: %s", e)
        # fallback: char/4 is the OpenAI-ish rough estimate for unknown tokenizers
        return max(1, len(prompt) // 4)
    # [END]

    async def stream_generate(
        self,
        model_ref: str | Path,
        prompt: str,
        max_tokens: int = 512,
        temperature: float | None = None,
        top_p: float | None = None,
        repetition_penalty: float | None = None,
    ) -> AsyncIterator[GenerationChunk]:
        loaded = await self.ensure_loaded(model_ref)
        async for chunk in self._astream(
            loaded, prompt, max_tokens, temperature, top_p, repetition_penalty
        ):
            yield chunk

    def _apply_chat_template(self, tokenizer, messages: list[ChatMessage]) -> str:
        dicts = [{"role": m.role, "content": m.content} for m in messages]
        apply = getattr(tokenizer, "apply_chat_template", None)
        if callable(apply):
            try:
                return apply(dicts, tokenize=False, add_generation_prompt=True)
            except Exception as e:  # tokenizer w/o chat template
                logger.debug("chat template failed, falling back: %s", e)
        return "\n".join(f"{m.role}: {m.content}" for m in messages) + "\nassistant:"

    async def _astream(
        self,
        loaded: LoadedModel,
        prompt: str,
        max_tokens: int,
        temperature: float | None,
        top_p: float | None,
        repetition_penalty: float | None = None,
    ) -> AsyncIterator[GenerationChunk]:
        from mlx_lm import stream_generate

        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        # [START] Cancellable worker — client disconnects set this flag so
        # the MLX loop stops promptly instead of pushing to a dead queue.
        cancelled = threading.Event()

        def safe_put(item) -> bool:
            """Schedule a put on the asyncio queue. Returns False if the loop
            is closed or the consumer has gone away — caller should stop work."""
            try:
                loop.call_soon_threadsafe(queue.put_nowait, item)
                return True
            except RuntimeError:
                cancelled.set()
                return False

        def worker() -> None:
            try:
                kwargs: dict = {"max_tokens": max_tokens}
                try:
                    from mlx_lm.sample_utils import make_sampler

                    kwargs["sampler"] = make_sampler(
                        temp=float(temperature) if temperature is not None else 0.0,
                        top_p=float(top_p) if top_p is not None else 1.0,
                    )
                except Exception as e:  # older mlx_lm without make_sampler
                    logger.debug("sampler helper unavailable: %s", e)

                # [START] Phase 6.4 — repetition penalty logits processor.
                # Only attached when the caller explicitly passes >1.0 so
                # quantized / small models that loop can be nudged without
                # affecting users who rely on the default distribution.
                if repetition_penalty is not None and float(repetition_penalty) > 1.0:
                    try:
                        from mlx_lm.sample_utils import make_logits_processors

                        kwargs["logits_processors"] = make_logits_processors(
                            repetition_penalty=float(repetition_penalty),
                            repetition_context_size=20,
                        )
                    except Exception as e:  # older mlx_lm without the helper
                        logger.debug("logits processor helper unavailable: %s", e)
                # [END]

                for chunk in stream_generate(loaded.model, loaded.tokenizer, prompt, **kwargs):
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
        # [END]

        # [START] Expose worker state on self so unload() can preempt it when
        # a model swap is requested mid-stream.
        worker_thread = threading.Thread(target=worker, daemon=True, name="mlx-stream")
        self._active_cancel = cancelled
        self._active_thread = worker_thread
        worker_thread.start()
        # [END]

        # [START] Signal worker to stop if consumer is cancelled (client disconnect).
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
            # Clear active handles once the worker has drained; unload() will
            # no-op the join path when these are already None.
            if self._active_cancel is cancelled:
                self._active_cancel = None
                self._active_thread = None
        # [END]


runner = MlxRunner()
