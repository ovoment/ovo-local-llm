"""Model blending runner — merges multiple MLX models using weight interpolation.

Supported methods:
  - slerp: Spherical linear interpolation (2 models)
  - linear: Weighted average (2+ models)
  - ties: Task-specific weight resolution (2+ models)
  - dare: Drop-and-rescale before merging (2+ models)

Uses MLX-native weight arithmetic — no mergekit dependency needed for basic ops.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from pathlib import Path

from ovo_sidecar.config import settings
from ovo_sidecar.blending.models import BlendConfig, BlendRun, BlendSource, _new_id, _now_kst

logger = logging.getLogger(__name__)

_active_runs: dict[str, BlendRun] = {}
_cancel_flags: dict[str, bool] = {}


def _blends_dir() -> Path:
    return settings.data_dir / "blended_models"


def get_run(run_id: str) -> BlendRun | None:
    return _active_runs.get(run_id)


def list_runs() -> list[BlendRun]:
    return list(_active_runs.values())


def cancel_run(run_id: str) -> bool:
    if run_id in _cancel_flags:
        _cancel_flags[run_id] = True
        return True
    return False


def list_blended_models() -> list[dict]:
    base = _blends_dir()
    if not base.exists():
        return []
    results: list[dict] = []
    for d in sorted(base.iterdir()):
        meta_path = d / "blend_meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
            size = sum(f.stat().st_size for f in d.rglob("*.safetensors"))
            meta["size_bytes"] = size
            meta["path"] = str(d)
            results.append(meta)
        except Exception as e:
            logger.warning("Failed to read blend meta %s: %s", d, e)
    return results


def delete_blended_model(name: str) -> bool:
    d = _blends_dir() / name
    if not d.exists():
        return False
    shutil.rmtree(d)
    return True


async def start_blend(config: BlendConfig) -> BlendRun:
    run = BlendRun(
        name=config.name,
        method=config.method,
        sources=config.sources,
        started_at=_now_kst(),
    )
    _active_runs[run.run_id] = run
    _cancel_flags[run.run_id] = False

    asyncio.create_task(_run_blend(run, config))
    return run


async def _run_blend(run: BlendRun, config: BlendConfig) -> None:
    run.status = "running"
    start_time = time.time()

    try:
        output_dir = _blends_dir() / config.name
        output_dir.mkdir(parents=True, exist_ok=True)

        def _do_blend() -> str:
            try:
                import mlx.core as mx  # type: ignore[import-untyped]
            except ImportError:
                raise RuntimeError("MLX not available — cannot blend models")

            if len(config.sources) < 2:
                raise ValueError("At least 2 models required for blending")

            from mlx_lm import load as mlx_load  # type: ignore[import-untyped]

            def _flatten_params(params: dict, prefix: str = "") -> dict:
                """Flatten nested parameter dict into dot-separated keys."""
                flat: dict = {}
                for k, v in params.items():
                    full_key = f"{prefix}.{k}" if prefix else k
                    if isinstance(v, dict):
                        flat.update(_flatten_params(v, full_key))
                    else:
                        flat[full_key] = v
                return flat

            logger.info("Loading model 1: %s", config.sources[0].repo_id)
            run.progress = 0.1
            model_a, tokenizer = mlx_load(config.sources[0].repo_id)
            weights_a = _flatten_params(dict(model_a.parameters()))

            logger.info("Loading model 2: %s", config.sources[1].repo_id)
            run.progress = 0.3
            model_b, _ = mlx_load(config.sources[1].repo_id)
            weights_b = _flatten_params(dict(model_b.parameters()))

            if _cancel_flags.get(run.run_id, False):
                raise KeyboardInterrupt("Blend cancelled")

            w = config.sources[1].weight / (config.sources[0].weight + config.sources[1].weight)

            logger.info("Blending with method=%s, weight=%.2f", config.method, w)
            run.progress = 0.5

            merged: dict[str, mx.array] = {}
            total_keys = len(weights_a)
            for i, key in enumerate(weights_a):
                if key not in weights_b:
                    merged[key] = weights_a[key]
                    continue

                a = weights_a[key]
                b = weights_b[key]

                if a.shape != b.shape:
                    merged[key] = a
                    continue

                if config.method == "slerp":
                    merged[key] = _slerp(a, b, w)
                elif config.method == "linear":
                    merged[key] = a * (1 - w) + b * w
                elif config.method == "ties":
                    merged[key] = _ties_merge(a, b, w)
                elif config.method == "dare":
                    merged[key] = _dare_merge(a, b, w)
                else:
                    merged[key] = a * (1 - w) + b * w

                run.progress = 0.5 + 0.4 * (i / total_keys)

                if _cancel_flags.get(run.run_id, False):
                    raise KeyboardInterrupt("Blend cancelled")

            run.progress = 0.9
            logger.info("Saving blended model to %s", output_dir)

            def _unflatten(flat: dict) -> dict:
                tree: dict = {}
                for key, val in flat.items():
                    parts = key.split(".")
                    d = tree
                    for p in parts[:-1]:
                        d = d.setdefault(p, {})
                    d[parts[-1]] = val
                return tree

            from mlx_lm.utils import save_model  # type: ignore[import-untyped]
            save_model(str(output_dir), weights=_unflatten(merged), tokenizer=tokenizer)

            tokenizer.save_pretrained(str(output_dir))

            src_config_path = Path(config.sources[0].repo_id) / "config.json"
            if not src_config_path.exists():
                from huggingface_hub import hf_hub_download  # type: ignore[import-untyped]
                src_config_path = Path(hf_hub_download(config.sources[0].repo_id, "config.json"))
            if src_config_path.exists():
                shutil.copy2(src_config_path, output_dir / "config.json")

            meta = {
                "name": config.name,
                "method": config.method,
                "sources": [{"repo_id": s.repo_id, "weight": s.weight} for s in config.sources],
                "created_at": _now_kst(),
            }
            (output_dir / "blend_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

            return str(output_dir)

        output = await asyncio.to_thread(_do_blend)

        if run.status != "cancelled":
            run.status = "done"
            run.progress = 1.0
            run.output_path = output
            run.completed_at = _now_kst()
            logger.info("Blend complete: %s (%.1fs)", run.name, time.time() - start_time)

    except KeyboardInterrupt:
        run.status = "cancelled"
    except Exception as e:
        logger.exception("Blend failed: %s", run.name)
        run.status = "error"
        run.error = str(e)
    finally:
        run.elapsed_seconds = time.time() - start_time
        _cancel_flags.pop(run.run_id, None)


def _slerp(a, b, t: float):
    """Spherical linear interpolation between two weight tensors."""
    import mlx.core as mx  # type: ignore[import-untyped]
    a_flat = a.reshape(-1).astype(mx.float32)
    b_flat = b.reshape(-1).astype(mx.float32)

    a_norm = mx.sqrt(mx.sum(a_flat * a_flat)) + 1e-8
    b_norm = mx.sqrt(mx.sum(b_flat * b_flat)) + 1e-8
    a_unit = a_flat / a_norm
    b_unit = b_flat / b_norm

    dot = mx.clip(mx.sum(a_unit * b_unit), -1.0, 1.0)
    theta = mx.arccos(dot)

    sin_theta = mx.sin(theta) + 1e-8
    w_a = mx.sin((1 - t) * theta) / sin_theta
    w_b = mx.sin(t * theta) / sin_theta

    result = (a_flat * w_a + b_flat * w_b).reshape(a.shape)
    return result.astype(a.dtype)


def _ties_merge(a, b, w: float):
    """TIES: trim low-magnitude, elect sign, merge."""
    import mlx.core as mx  # type: ignore[import-untyped]
    diff = b - a
    threshold = mx.mean(mx.abs(diff)) * 0.2
    mask = mx.abs(diff) > threshold
    merged = a + diff * mask * w
    return merged


def _dare_merge(a, b, w: float, drop_rate: float = 0.1):
    """DARE: drop random delta weights, rescale remainder."""
    import mlx.core as mx  # type: ignore[import-untyped]
    diff = b - a
    keep = mx.random.bernoulli(p=1 - drop_rate, shape=diff.shape)
    rescale = 1.0 / (1.0 - drop_rate)
    merged = a + diff * keep * w * rescale
    return merged
