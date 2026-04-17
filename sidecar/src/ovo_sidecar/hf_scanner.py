import json
import logging
from dataclasses import dataclass
from pathlib import Path

from ovo_sidecar.config import settings

logger = logging.getLogger(__name__)


@dataclass
class ScannedModel:
    repo_id: str
    revision: str
    snapshot_path: Path
    size_bytes: int
    config: dict
    is_mlx: bool
    source: str = "hf"
    capabilities: tuple[str, ...] = ("text",)
    # [START] max_context — inferred from config.json keys. UI uses this as the
    # denominator for the ContextIndicator ring. Order of preference matches
    # what Transformers/MLX actually honor at inference time.
    max_context: int | None = None
    # [END]


# [START] max_context detection — HF configs use several keys (legacy +
# model-specific). Return the first non-zero positive int found. Text_config
# fallback covers VLMs where the LM sub-config carries the real window.
_MAX_CONTEXT_KEYS: tuple[str, ...] = (
    "max_position_embeddings",
    "model_max_length",
    "max_seq_length",
    "n_positions",
    "seq_length",
)


def detect_max_context(config: dict) -> int | None:
    def _scan(d: dict) -> int | None:
        for key in _MAX_CONTEXT_KEYS:
            v = d.get(key)
            if isinstance(v, int) and v > 0:
                return v
            if isinstance(v, float) and v > 0:
                return int(v)
        return None

    found = _scan(config)
    if found is not None:
        return found
    text_cfg = config.get("text_config")
    if isinstance(text_cfg, dict):
        return _scan(text_cfg)
    return None
# [END]


# [START] Modality detection — HF config.json signals which non-text modalities
# the model actually supports. `model_type` is the primary signal (matches
# Transformers' registry); sub-config presence is a fallback for custom/new
# architectures. Each modality is independent so a single model can claim
# multiple (e.g. Phi-4-multimodal has vision + audio).
_VISION_MODEL_TYPES: frozenset[str] = frozenset({
    # Qwen line
    "qwen2_vl", "qwen2_5_vl", "qwen3_vl", "qwen2_5_omni",
    # LLaVA line
    "llava", "llava_next", "llava_onevision", "llava_next_video",
    "video_llava",
    # MiniCPM / CPM
    "minicpmv", "minicpm_v",
    # Idefics / Mistral vision
    "idefics2", "idefics3", "mllama", "mistral3", "pixtral",
    # InternVL / InternLM
    "internvl_chat", "internlm_xcomposer2", "internlm_xcomposer2_5",
    # Google
    "paligemma", "gemma3",
    # Microsoft
    "phi3_v", "phi4_multimodal",
    # HuggingFace SmolVLM
    "smolvlm",
    # DeepSeek
    "deepseek_vl", "deepseek_vl2", "deepseek_vl_v2", "janus", "janus_pro",
    # Misc
    "moondream1", "moondream2", "molmo", "aria",
    "cogvlm", "cogvlm2", "chameleon", "bunny", "ovis",
    "got_ocr2", "got_ocr_2",
    "h2ovl_mississippi", "nvlm", "ernie_vl",
    "glm4v", "glmv",
})

_AUDIO_MODEL_TYPES: frozenset[str] = frozenset({
    "phi4_multimodal",
    "qwen2_audio",
    "qwen2_5_omni",
    "whisper",
    "parakeet",
})


def detect_capabilities(config: dict) -> tuple[str, ...]:
    """
    Decide which modalities a model supports from its HF config.json.

    Primary signal: `model_type` (Transformers' registry). Secondary signals:
    presence of common vision/audio sub-config keys. Third-tier fallback:
    any config key containing "vision" / "audio" as a substring — this
    catches future architectures that haven't made it into the allow-list
    yet but whose configs still mention the modality.
    """
    model_type = str(config.get("model_type") or "").lower()
    caps: list[str] = ["text"]

    config_keys_lc = [str(k).lower() for k in config.keys()]

    has_vision = (
        model_type in _VISION_MODEL_TYPES
        or "vision_config" in config
        or "vision_tower" in config
        or "mm_vision_config" in config
        or "image_processor" in config
        or any(
            "vision" in k or "visual" in k or "image_encoder" in k
            for k in config_keys_lc
        )
    )
    has_audio = (
        model_type in _AUDIO_MODEL_TYPES
        or "audio_config" in config
        or "audio_processor_config" in config
        or any(
            "audio" in k or "speech" in k
            for k in config_keys_lc
        )
    )

    if has_vision:
        caps.append("vision")
    if has_audio:
        caps.append("audio")
    return tuple(caps)
# [END]


def _repo_id_from_cache(cache_dir: Path) -> str:
    name = cache_dir.name
    if name.startswith("models--"):
        return name[len("models--"):].replace("--", "/")
    return name


def _detect_mlx(config: dict, files: list[Path], repo_id: str = "") -> bool:
    if "mlx" in repo_id.lower():
        return True
    if any("mlx" in p.name.lower() for p in files):
        return True
    for key in ("quantization", "mlx_version"):
        if key in config:
            return True
    return False


def _build_scanned(
    repo_id: str,
    revision: str,
    snapshot: Path,
    source: str,
) -> ScannedModel | None:
    config_path = snapshot / "config.json"
    if not config_path.exists():
        return None
    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        logger.debug("skip %s: %s", snapshot, e)
        return None
    files = [p for p in snapshot.rglob("*") if p.is_file()]
    size_bytes = sum(f.stat().st_size for f in files)
    return ScannedModel(
        repo_id=repo_id,
        revision=revision,
        snapshot_path=snapshot,
        size_bytes=size_bytes,
        config=config,
        is_mlx=_detect_mlx(config, files, repo_id),
        source=source,
        capabilities=detect_capabilities(config),
        max_context=detect_max_context(config),
    )


def scan(cache_root: Path) -> list[ScannedModel]:
    """Scan HF Hub cache layout: `models--Org--Repo/snapshots/<rev>/`."""
    if not cache_root.exists():
        return []

    results: list[ScannedModel] = []
    for model_dir in cache_root.iterdir():
        if not model_dir.is_dir() or not model_dir.name.startswith("models--"):
            continue

        snapshots_dir = model_dir / "snapshots"
        if not snapshots_dir.exists():
            continue

        for snapshot in snapshots_dir.iterdir():
            if not snapshot.is_dir():
                continue
            repo_id = _repo_id_from_cache(model_dir)
            sm = _build_scanned(repo_id, snapshot.name, snapshot, "hf")
            if sm is not None:
                results.append(sm)

    return results


# [START] LM Studio cache scanner — layout: `<org>/<repo>/<files directly>`
def scan_lmstudio(cache_root: Path) -> list[ScannedModel]:
    """Scan LM Studio cache layout: `<org>/<repo>/config.json`.

    LM Studio does not track HF revisions, so revision is a stable hash-like
    string derived from the snapshot path.
    """
    if not cache_root.exists():
        return []

    results: list[ScannedModel] = []
    for org_dir in cache_root.iterdir():
        if not org_dir.is_dir() or org_dir.name.startswith("."):
            continue
        for repo_dir in org_dir.iterdir():
            if not repo_dir.is_dir():
                continue
            repo_id = f"{org_dir.name}/{repo_dir.name}"
            sm = _build_scanned(repo_id, "lmstudio", repo_dir, "lmstudio")
            if sm is not None:
                results.append(sm)
    return results
# [END]


# [START] Combined scan + path resolver (used by all model-listing APIs)
def scan_all() -> list[ScannedModel]:
    """Return HF + LM Studio models merged, HF wins on repo_id collision."""
    hf_models = scan(settings.hf_cache_dir)
    ls_models = scan_lmstudio(settings.lmstudio_cache_dir)
    seen = {m.repo_id for m in hf_models}
    merged = list(hf_models)
    for m in ls_models:
        if m.repo_id in seen:
            continue
        merged.append(m)
        seen.add(m.repo_id)
    return merged


def resolve_path(repo_id: str) -> Path | None:
    """Given a repo_id, return the local filesystem path if discoverable."""
    for m in scan_all():
        if m.repo_id == repo_id:
            return m.snapshot_path
    return None


def resolve_capabilities(repo_id: str) -> tuple[str, ...]:
    """Look up capabilities for a local model by repo_id. Unknown → text-only."""
    for m in scan_all():
        if m.repo_id == repo_id:
            return m.capabilities
    return ("text",)


def resolve_max_context(repo_id: str) -> int | None:
    """Look up context window for a local model. None if unknown."""
    for m in scan_all():
        if m.repo_id == repo_id:
            return m.max_context
    return None
# [END]
