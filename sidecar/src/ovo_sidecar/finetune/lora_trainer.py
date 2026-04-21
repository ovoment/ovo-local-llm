"""LoRA Training Runner — wraps mlx-lm fine-tuning API.

Runs training in a background thread with progress callbacks.
Supports: train, resume, cancel.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from ovo_sidecar.config import settings
from ovo_sidecar.finetune.models import (
    Adapter,
    TrainingConfig,
    TrainingRun,
    _new_id,
    _now_kst,
)
from ovo_sidecar.finetune.adapter_manager import (
    _adapter_dir,
    save_adapter_meta,
)

logger = logging.getLogger(__name__)

_active_runs: dict[str, TrainingRun] = {}
_cancel_flags: dict[str, bool] = {}


def get_run(run_id: str) -> TrainingRun | None:
    return _active_runs.get(run_id)


def list_runs() -> list[TrainingRun]:
    return list(_active_runs.values())


def cancel_run(run_id: str) -> bool:
    if run_id in _cancel_flags:
        _cancel_flags[run_id] = True
        return True
    return False


async def start_training(config: TrainingConfig) -> TrainingRun:
    """Start a LoRA fine-tuning run in the background."""
    run = TrainingRun(
        adapter_name=config.adapter_name,
        base_model=config.base_model,
        dataset_id=config.dataset_id,
        config=config,
        total_epochs=config.epochs,
        started_at=_now_kst(),
    )
    _active_runs[run.run_id] = run
    _cancel_flags[run.run_id] = False

    asyncio.create_task(_run_training(run))
    return run


async def _run_training(run: TrainingRun) -> None:
    """Background training worker."""
    run.status = "running"
    start_time = time.time()

    try:
        adapter_path = _adapter_dir(run.run_id)
        adapter_path.mkdir(parents=True, exist_ok=True)

        def _train() -> None:
            try:
                from mlx_lm import load as mlx_load  # type: ignore[import-untyped]
                from mlx_lm.tuner.trainer import TrainingArgs, train  # type: ignore[import-untyped]
                from mlx_lm.tuner.utils import linear_to_lora_layers  # type: ignore[import-untyped]
            except ImportError:
                raise RuntimeError(
                    "mlx-lm not installed. Run: pip install mlx-lm"
                )

            from ovo_sidecar.finetune.dataset_manager import get_dataset
            dataset = get_dataset(run.config.dataset_id)
            if not dataset:
                raise ValueError(f"Dataset not found: {run.config.dataset_id}")

            logger.info(
                "Loading model %s for LoRA training (rank=%d, layers=%d)",
                run.config.base_model, run.config.lora_rank, run.config.lora_layers,
            )
            model, tokenizer = mlx_load(run.config.base_model)

            linear_to_lora_layers(
                model,
                num_layers=run.config.lora_layers,
                config={"rank": run.config.lora_rank, "alpha": run.config.lora_rank, "dropout": 0.0, "scale": 1.0},
            )

            from mlx_lm.tuner.datasets import ChatDataset, CacheDataset  # type: ignore[import-untyped]

            raw_train = _load_jsonl(dataset.train_path)
            raw_valid = _load_jsonl(dataset.valid_path)
            train_data = CacheDataset(ChatDataset(raw_train, tokenizer))
            valid_data = CacheDataset(ChatDataset(raw_valid, tokenizer))

            iters_per_epoch = max(1, len(raw_train) // run.config.batch_size)
            total_iters = iters_per_epoch * run.config.epochs

            adapter_file = str(adapter_path / "adapters.safetensors")

            args = TrainingArgs(
                adapter_file=adapter_file,
                iters=total_iters,
                steps_per_eval=max(1, iters_per_epoch),
                batch_size=run.config.batch_size,
                max_seq_length=run.config.max_seq_length,
            )

            from mlx_lm.tuner.callbacks import TrainingCallback as _TCB  # type: ignore[import-untyped]

            class ProgressCallback(_TCB):
                def __init__(self, run_ref: TrainingRun) -> None:
                    self.run = run_ref

                def on_train_loss_report(self, train_info: dict) -> None:
                    step = train_info.get("iteration", 0)
                    loss = train_info.get("train_loss", 0.0)
                    self.run.progress = min(1.0, step / max(1, total_iters))
                    self.run.current_epoch = step // max(1, iters_per_epoch)
                    self.run.train_loss = loss
                    self.run.elapsed_seconds = time.time() - start_time

                    if _cancel_flags.get(run.run_id, False):
                        raise KeyboardInterrupt("Training cancelled by user")

                def on_val_loss_report(self, val_info: dict) -> None:
                    val_loss = val_info.get("val_loss", 0.0)
                    self.run.valid_loss = val_loss

            import mlx.optimizers as optim  # type: ignore[import-untyped]
            optimizer = optim.Adam(learning_rate=run.config.learning_rate)

            try:
                train(
                    model=model,
                    optimizer=optimizer,
                    train_dataset=train_data,
                    val_dataset=valid_data,
                    args=args,
                    training_callback=ProgressCallback(run),
                )
            except KeyboardInterrupt:
                logger.info("Training cancelled: %s", run.adapter_name)
                run.status = "cancelled"
                return

            adapter = Adapter(
                adapter_id=run.run_id,
                name=run.adapter_name,
                base_model=run.config.base_model,
                dataset_id=run.config.dataset_id,
                dataset_name=run.dataset_name,
                adapter_path=str(adapter_path),
                created_at=_now_kst(),
                config=run.config,
            )
            save_adapter_meta(adapter)

        await asyncio.to_thread(_train)

        if run.status != "cancelled":
            run.status = "done"
            run.progress = 1.0
            run.completed_at = _now_kst()
            logger.info("Training complete: %s (%.1fs)", run.adapter_name, run.elapsed_seconds)

    except Exception as e:
        logger.exception("Training failed: %s", run.adapter_name)
        run.status = "error"
        run.error = str(e)
    finally:
        run.elapsed_seconds = time.time() - start_time
        _cancel_flags.pop(run.run_id, None)


def _load_jsonl(path: str) -> list[dict]:
    data: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                data.append(json.loads(line))
    return data
