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
    status: Literal["pending", "downloading", "done", "error", "cancelled"] = "pending"
    error: str | None = None
    snapshot_path: Path | None = None
    started_at: float = 0.0
    finished_at: float | None = None
    # [START] Phase 7 — progress tracking + cancellation
    total_bytes: int | None = None
    downloaded_bytes: int | None = None
    total_files: int | None = None
    downloaded_files: int | None = None
    cancel_requested: bool = False
    # [END]


class HfDownloader:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self._tasks: dict[str, DownloadTask] = {}

    async def search(
        self,
        query: str,
        limit: int = 25,
        # [START] Phase 7 — filter type lets the Image tab scope HF search to
        # text-to-image checkpoints (SDXL / Flux / Kandinsky etc.) instead of
        # the mlx tag used by chat models.
        kind: Literal["mlx", "image"] = "mlx",
        # [END]
    ) -> list[SearchResult]:
        from huggingface_hub import HfApi

        api = HfApi()
        hf_filter = "text-to-image" if kind == "image" else "mlx"

        def _call() -> list[SearchResult]:
            # [START] HF API compat — `direction` was removed; newer versions
            # default to descending on numeric sort fields (downloads, likes).
            models = api.list_models(
                search=query or None,
                filter=hf_filter,
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

    @staticmethod
    def parse_model_url(url: str) -> str | None:
        """Extract repo_id from a HuggingFace URL.
        Accepts: https://huggingface.co/org/model or org/model"""
        import re
        url = url.strip()
        m = re.match(r"https?://huggingface\.co/([^/]+/[^/\s?#]+)", url)
        if m:
            return m.group(1)
        if re.match(r"^[^/\s]+/[^/\s]+$", url):
            return url
        return None

    async def start_download_from_url(self, url: str) -> DownloadTask:
        repo_id = self.parse_model_url(url)
        if not repo_id:
            task = DownloadTask(
                task_id=uuid.uuid4().hex[:16],
                repo_id=url,
                started_at=time.time(),
            )
            task.status = "error"
            task.error = "Invalid URL. Use a HuggingFace URL (https://huggingface.co/org/model) or repo ID (org/model)."
            task.finished_at = time.time()
            return task
        return await self.start_download(repo_id)

    async def start_download(self, repo_id: str) -> DownloadTask:
        task = DownloadTask(task_id=uuid.uuid4().hex[:16], repo_id=repo_id, started_at=time.time())
        self._tasks[task.task_id] = task
        asyncio.create_task(self._run(task))
        return task

    def cancel(self, task_id: str) -> bool:
        """Mark a running download as cancel-requested. The per-file loop in
        `_run` picks this up between files and stops before kicking off the
        next one. Already-completed bytes are left in the HF cache — the next
        retry will skip them."""
        task = self._tasks.get(task_id)
        if task is None:
            return False
        if task.status in {"done", "error", "cancelled"}:
            return False
        task.cancel_requested = True
        return True

    async def _run(self, task: DownloadTask) -> None:
        # [START] Phase 7 — per-file download loop.
        # Replaces the single `snapshot_download` call so we get progress +
        # cancellation. Each sibling file is fetched via `hf_hub_download`;
        # the task's cancel flag is checked between files.
        from huggingface_hub import HfApi, hf_hub_download

        task.status = "downloading"
        api = HfApi()

        # Enumerate repo files + sum their sizes for the progress denominator.
        try:
            info = await asyncio.to_thread(
                api.repo_info, task.repo_id, files_metadata=True
            )
        except Exception as e:
            task.status = "error"
            task.error = f"repo_info failed: {e}"
            task.finished_at = time.time()
            logger.exception("repo_info failed: %s", task.repo_id)
            return

        siblings = list(info.siblings or [])
        total_bytes = sum(int(s.size or 0) for s in siblings)
        task.total_bytes = total_bytes
        task.total_files = len(siblings)
        task.downloaded_bytes = 0
        task.downloaded_files = 0

        last_snapshot_path: Path | None = None

        for sib in siblings:
            if task.cancel_requested:
                task.status = "cancelled"
                task.finished_at = time.time()
                logger.info("download cancelled: %s", task.repo_id)
                return
            try:
                local = await asyncio.to_thread(
                    hf_hub_download,
                    repo_id=task.repo_id,
                    filename=sib.rfilename,
                    cache_dir=str(self.cache_dir),
                )
            except BaseException as e:
                task.status = "error"
                task.error = str(e)
                task.finished_at = time.time()
                logger.exception("file fetch failed: %s/%s", task.repo_id, sib.rfilename)
                return

            # [START] LFS pointer detection + size verification
            local_path = Path(local)
            if local_path.exists():
                try:
                    with open(local_path, "rb") as f:
                        head = f.read(128)
                    if b"git-lfs.github.com/spec/v1" in head:
                        local_path.unlink(missing_ok=True)
                        task.status = "error"
                        task.error = f"LFS pointer detected for {sib.rfilename} — file not resolved. Check repo access or try again."
                        task.finished_at = time.time()
                        logger.error("LFS pointer: %s/%s", task.repo_id, sib.rfilename)
                        return
                except OSError:
                    pass

                expected = int(sib.size or 0)
                actual = local_path.stat().st_size
                if expected > 0 and actual < expected * 0.95:
                    local_path.unlink(missing_ok=True)
                    task.status = "error"
                    task.error = f"Size mismatch for {sib.rfilename}: expected {expected} bytes, got {actual}. Download may be incomplete."
                    task.finished_at = time.time()
                    logger.error("size mismatch: %s/%s expected=%d actual=%d", task.repo_id, sib.rfilename, expected, actual)
                    return
            # [END]

            # Snapshot dir is the file's parent (cache layout:
            # .../snapshots/<rev>/<filename>); stash once.
            if last_snapshot_path is None:
                last_snapshot_path = Path(local).parent
            task.downloaded_bytes = (task.downloaded_bytes or 0) + int(sib.size or 0)
            task.downloaded_files = (task.downloaded_files or 0) + 1

        task.snapshot_path = last_snapshot_path
        task.status = "done"
        task.finished_at = time.time()
        registry.record_download(task.repo_id)
        # [START] Invalidate scan cache so the next /ovo/models call sees the new model.
        from ovo_sidecar.hf_scanner import invalidate_scan_cache
        invalidate_scan_cache()
        # [END]
        logger.info(
            "download finished: %s -> %s (%d files, %d bytes)",
            task.repo_id, last_snapshot_path, task.downloaded_files, task.downloaded_bytes,
        )
        # [END]


downloader = HfDownloader(settings.hf_cache_dir)
