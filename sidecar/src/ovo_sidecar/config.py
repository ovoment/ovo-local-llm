from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OVO_", env_file=".env", extra="ignore")

    ollama_port: int = 11435
    openai_port: int = 11436
    native_port: int = 11437

    hf_cache_dir: Path = Path.home() / ".cache" / "huggingface" / "hub"
    # [START] LM Studio cache integration — discover MLX models from LM Studio layout
    lmstudio_cache_dir: Path = Path.home() / ".lmstudio" / "models"
    # [END]
    data_dir: Path = Path.home() / "Library" / "Application Support" / "OVO"

    default_model: str | None = None
    default_context_length: int = 4096
    max_tokens_cap: int = 4096

    expose_to_network: bool = False

    claude_integration_enabled: bool = False
    claude_read_claude_md: bool = True
    claude_read_settings: bool = True
    claude_read_plugins: bool = False

    log_level: str = "info"

    @property
    def registry_path(self) -> Path:
        return self.data_dir / "registry.toml"

    @property
    def audit_log_path(self) -> Path:
        return self.data_dir / "audit.log"

    @property
    def chats_db_path(self) -> Path:
        return self.data_dir / "chats.sqlite"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
