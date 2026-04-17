import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from ovo_sidecar.config import settings
from ovo_sidecar.registry import registry

logger = logging.getLogger(__name__)


@dataclass
class SearchResult:
    repo_id: str
    downloads: int
    likes: int
    last_modified: str | None
    tags: list[str] = field(default_factory=list)


@dataclass
class DownloadTask:
    task_id: str
    repo_id: str
    status: Literal["pending", "downloading", "done", "error"] = "pending"
    error: str | None = None
    snapshot_path: Path | None = None
    started_at: float = 0.0
    finished_at: float | None = None


class HfDownloader:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self._tasks: dict[str, DownloadTask] = {}

    async def search(self, query: str, limit: int = 25) -> list[SearchResult]:
        from huggingface_hub import HfApi

        api = HfApi()

        def _call() -> list[SearchResult]:
            # [START] HF API compat — `direction` was removed; newer versions
            # default to descending on numeric sort fields (downloads, likes).
            models = api.list_models(
                search=query or None,
                filter="mlx",
                limit=limit,
                sort="downloads",
                cardData=False,
                full=False,
            )
            # [END]
            return [
                SearchResult(
                    repo_id=m.id,
                    downloads=int(getattr(m, "downloads", 0) or 0),
                    likes=int(getattr(m, "likes", 0) or 0),
                    last_modified=str(m.last_modified) if getattr(m, "last_modified", None) else None,
                    tags=list(getattr(m, "tags", []) or []),
                )
                for m in models
            ]

        return await asyncio.to_thread(_call)

    def get_task(self, task_id: str) -> DownloadTask | None:
        return self._tasks.get(task_id)

    def list_tasks(self) -> list[DownloadTask]:
        return list(self._tasks.values())

    async def start_download(self, repo_id: str) -> DownloadTask:
        task = DownloadTask(task_id=uuid.uuid4().hex[:16], repo_id=repo_id, started_at=time.time())
        self._tasks[task.task_id] = task
        asyncio.create_task(self._run(task))
        return task

    async def _run(self, task: DownloadTask) -> None:
        from huggingface_hub import snapshot_download

        task.status = "downloading"
        try:
            path = await asyncio.to_thread(
                snapshot_download,
                task.repo_id,
                cache_dir=str(self.cache_dir),
            )
            task.snapshot_path = Path(path)
            task.status = "done"
            task.finished_at = time.time()
            registry.record_download(task.repo_id)
            logger.info("download finished: %s -> %s", task.repo_id, path)
        except BaseException as e:
            task.status = "error"
            task.error = str(e)
            task.finished_at = time.time()
            logger.exception("download failed: %s", task.repo_id)


downloader = HfDownloader(settings.hf_cache_dir)
