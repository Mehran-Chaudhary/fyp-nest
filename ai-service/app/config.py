"""Service configuration, read once from the environment (and an optional `.env`).

Names that the backend also reads (`AI_SERVICE_SIGNING_SECRET`, `AI_SERVICE_KEY_ID`,
`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) are spelled identically on both sides,
so one value can be copied across without translation.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parent.parent

MIN_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVICE_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # ── Request signing (contract §Authentication) ──────────────────────────
    AI_SERVICE_SIGNING_SECRET: str = Field(min_length=MIN_SECRET_LENGTH)
    AI_SERVICE_KEY_ID: str = Field(default="v1", pattern=r"^[A-Za-z0-9._-]{1,32}$")
    # A second key accepted during rotation; see README "Rotating the secret".
    AI_SERVICE_PREVIOUS_SIGNING_SECRET: str = ""
    AI_SERVICE_PREVIOUS_KEY_ID: str = ""
    SIGNATURE_TOLERANCE_SECONDS: int = Field(default=300, ge=30, le=900)
    # Shared nonce store for several replicas. Empty: in-process memory, which
    # is exact for one replica (the recommended deployment).
    REPLAY_REDIS_URL: str = ""

    # ── Models ──────────────────────────────────────────────────────────────
    # A label from app/models/registry.py; the backend's EMBEDDING_MODEL must match.
    EMBEDDING_MODEL: str = "embeddinggemma-300m-int8"
    # 0 means the model's native dimension. A smaller value truncates and
    # re-normalises (Matryoshka models only). Must match the backend's.
    EMBEDDING_DIMENSIONS: int = Field(default=0, ge=0, le=8192)
    RERANK_MODEL: str = "bge-reranker-base"  # "none" disables /v1/rerank
    PII_ENABLED: bool = True
    PII_SPACY_MODEL: str = "en_core_web_md"
    # Transformer NER run beside spaCy ("none" for spaCy alone).
    PII_TRANSFORMER_MODEL: str = "bert-base-NER"
    OCR_ENABLED: bool = True  # used only when the `ocr` extra is installed
    OCR_MAX_PAGES: int = Field(default=50, ge=0, le=2000)
    MODEL_CACHE_DIR: Path = SERVICE_ROOT / ".models"
    # Fetch missing model files from Hugging Face at startup. Off in the
    # container image, which bakes the models in at build time.
    MODEL_DOWNLOAD: bool = True
    # How long a request waits for a model that is still loading before
    # answering 503 MODEL_LOADING with Retry-After.
    MODEL_WAIT_SECONDS: float = Field(default=25.0, ge=0, le=120)
    # ONNX Runtime intra-op threads per model. 0: one per CPU core.
    ONNX_THREADS: int = Field(default=0, ge=0, le=64)

    # ── Limits ──────────────────────────────────────────────────────────────
    MAX_DOCUMENT_BYTES: int = Field(default=64 * 1024 * 1024, ge=1024)
    MAX_JSON_BYTES: int = Field(default=16 * 1024 * 1024, ge=1024)
    MAX_EMBED_INPUTS: int = Field(default=256, ge=1, le=4096)
    MAX_RERANK_DOCUMENTS: int = Field(default=200, ge=1, le=2000)
    MAX_PII_TEXTS: int = Field(default=64, ge=1, le=1024)
    MAX_PII_CHARACTERS: int = Field(default=250_000, ge=1000)
    # Hard ceiling on one chunk's characters, independent of tokens (the
    # contract allows 100,000; staying well under it is cheap insurance).
    MAX_CHUNK_CHARACTERS: int = Field(default=20_000, ge=1000, le=100_000)
    # Prefix each chunk with its section path ("Leave policy > Annual leave").
    CHUNK_CONTEXT_HEADERS: bool = True

    # ── Concurrency: separate lanes so a long parse never starves PII ────────
    PARSE_CONCURRENCY: int = Field(default=2, ge=1, le=32)
    EMBED_CONCURRENCY: int = Field(default=1, ge=1, le=32)
    RERANK_CONCURRENCY: int = Field(default=1, ge=1, le=32)
    PII_CONCURRENCY: int = Field(default=2, ge=1, le=32)

    # ── Server and logs ─────────────────────────────────────────────────────
    PORT: int = Field(default=8000, ge=1, le=65535)
    LOG_LEVEL: str = Field(default="INFO", pattern=r"^(DEBUG|INFO|WARNING|ERROR)$")
    LOG_FORMAT: str = Field(default="json", pattern=r"^(json|text)$")
    # Interactive API docs at /docs. They are unauthenticated, so off by default.
    DOCS_ENABLED: bool = False

    @field_validator("AI_SERVICE_PREVIOUS_SIGNING_SECRET")
    @classmethod
    def _previous_secret_length(cls, value: str) -> str:
        if value and len(value) < MIN_SECRET_LENGTH:
            raise ValueError(f"must be at least {MIN_SECRET_LENGTH} characters")
        return value

    @model_validator(mode="after")
    def _rotation_pair(self) -> "Settings":
        if bool(self.AI_SERVICE_PREVIOUS_SIGNING_SECRET) != bool(self.AI_SERVICE_PREVIOUS_KEY_ID):
            raise ValueError(
                "AI_SERVICE_PREVIOUS_SIGNING_SECRET and AI_SERVICE_PREVIOUS_KEY_ID go together"
            )
        if self.AI_SERVICE_PREVIOUS_KEY_ID == self.AI_SERVICE_KEY_ID:
            raise ValueError("AI_SERVICE_PREVIOUS_KEY_ID must differ from AI_SERVICE_KEY_ID")
        return self

    @property
    def signing_keys(self) -> dict[str, bytes]:
        keys = {self.AI_SERVICE_KEY_ID: self.AI_SERVICE_SIGNING_SECRET.encode()}
        if self.AI_SERVICE_PREVIOUS_KEY_ID:
            keys[self.AI_SERVICE_PREVIOUS_KEY_ID] = self.AI_SERVICE_PREVIOUS_SIGNING_SECRET.encode()
        return keys

    @property
    def onnx_threads(self) -> int | None:
        return self.ONNX_THREADS or None

    @property
    def rerank_enabled(self) -> bool:
        return _enabled(self.RERANK_MODEL)

    @property
    def transformer_ner_enabled(self) -> bool:
        return _enabled(self.PII_TRANSFORMER_MODEL)


def _enabled(model: str) -> bool:
    return model.strip().lower() not in ("", "none", "off", "false")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()  # type: ignore[call-arg]
    # fastembed and Hugging Face read their cache location from the environment.
    os.environ.setdefault("FASTEMBED_CACHE_PATH", str(settings.MODEL_CACHE_DIR))
    os.environ.setdefault("HF_HOME", str(settings.MODEL_CACHE_DIR / "hf"))
    return settings
