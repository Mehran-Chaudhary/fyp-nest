"""Model lifecycle and CPU lanes.

Models load in one background thread at startup, most important first
(tokenizer → embeddings → PII → reranker → OCR), so the HTTP server answers
health checks immediately and each capability comes up as soon as it can.
A request for a model still loading waits up to MODEL_WAIT_SECONDS, then gets
503 MODEL_LOADING with Retry-After, which the backend retries.

Each workload runs in its own bounded thread pool lane: a 300-second PDF parse
can never take the slot a 10-second PII request needs.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Generic, Literal, TypeVar

import anyio
from anyio import CapacityLimiter
from tokenizers import Tokenizer

from . import errors
from .config import Settings
from .models.onnx import EmbeddingModel, NerModel, RerankModel, resolve_model_dir
from .models.registry import EMBEDDING_MODELS, NER_MODELS, RERANK_MODELS, EmbeddingSpec
from .parsing.ocr import OcrEngine, load_ocr_engine
from .tokens import HfTokenCounter

log = logging.getLogger("daiap.runtime")

T = TypeVar("T")
State = Literal["pending", "loading", "ready", "failed", "disabled"]


@dataclass
class Component(Generic[T]):
    name: str
    state: State = "pending"
    value: T | None = None
    error: str | None = None
    load_seconds: float | None = None
    _ready: threading.Event = field(default_factory=threading.Event)

    def load(self, factory: Callable[[], T]) -> None:
        self.state = "loading"
        started = time.monotonic()
        try:
            self.value = factory()
            self.state = "ready"
            self.load_seconds = round(time.monotonic() - started, 1)
            log.info("model ready", extra={"component": self.name, "seconds": self.load_seconds})
        except Exception as error:  # noqa: BLE001 - one model failing must not stop the others
            self.state = "failed"
            self.error = type(error).__name__
            log.exception("model failed to load", extra={"component": self.name})
        finally:
            self._ready.set()

    def disable(self) -> None:
        self.state = "disabled"
        self._ready.set()

    async def get(self, wait_seconds: float) -> T:
        if self.state == "ready" and self.value is not None:
            return self.value
        if self.state == "disabled":
            # 404, not 503: a capability this deployment does not offer is not
            # a transient fault. The backend then degrades at once (rerank falls
            # back to the fused order; PII applies its policy) instead of
            # retrying and tripping its circuit breaker.
            raise errors.ServiceError(404, "NOT_ENABLED", f"{self.name} is not enabled on this service.")
        if self.state == "failed":
            raise errors.model_not_available(f"{self.name} failed to load; see the service logs.")
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            if self._ready.is_set():
                return await self.get(0)
            await asyncio.sleep(0.25)
        raise errors.model_loading()


@dataclass(frozen=True)
class Lanes:
    parse: CapacityLimiter
    embed: CapacityLimiter
    rerank: CapacityLimiter
    pii: CapacityLimiter

    @classmethod
    def from_settings(cls, settings: Settings) -> "Lanes":
        return cls(
            parse=CapacityLimiter(settings.PARSE_CONCURRENCY),
            embed=CapacityLimiter(settings.EMBED_CONCURRENCY),
            rerank=CapacityLimiter(settings.RERANK_CONCURRENCY),
            pii=CapacityLimiter(settings.PII_CONCURRENCY),
        )


async def run_in(lane: CapacityLimiter, function: Callable[..., T], *args: Any) -> T:
    return await anyio.to_thread.run_sync(function, *args, limiter=lane)


class Runtime:
    def __init__(self, settings: Settings) -> None:
        if settings.EMBEDDING_MODEL not in EMBEDDING_MODELS:
            raise ValueError(
                f"EMBEDDING_MODEL={settings.EMBEDDING_MODEL!r} is not one of: {', '.join(EMBEDDING_MODELS)}"
            )
        if settings.rerank_enabled and settings.RERANK_MODEL not in RERANK_MODELS:
            raise ValueError(f"RERANK_MODEL={settings.RERANK_MODEL!r} is not one of: {', '.join(RERANK_MODELS)}, none")
        if settings.transformer_ner_enabled and settings.PII_TRANSFORMER_MODEL not in NER_MODELS:
            raise ValueError(
                f"PII_TRANSFORMER_MODEL={settings.PII_TRANSFORMER_MODEL!r} is not one of: {', '.join(NER_MODELS)}, none"
            )
        self.settings = settings
        self.embedding_spec: EmbeddingSpec = EMBEDDING_MODELS[settings.EMBEDDING_MODEL]
        self.dimensions = settings.EMBEDDING_DIMENSIONS or self.embedding_spec.dimensions
        if self.dimensions != self.embedding_spec.dimensions and self.dimensions not in self.embedding_spec.matryoshka:
            raise ValueError(
                f"EMBEDDING_DIMENSIONS={self.dimensions} is not available for {self.embedding_spec.label} "
                f"(native {self.embedding_spec.dimensions}, Matryoshka {self.embedding_spec.matryoshka or 'none'})"
            )
        self.lanes = Lanes.from_settings(settings)
        self.counter: Component[HfTokenCounter] = Component("tokenizer")
        self.embedding: Component[EmbeddingModel] = Component("embedding")
        self.pii: Component[Any] = Component("pii")
        self.rerank: Component[RerankModel] = Component("rerank")
        self.ocr: Component[OcrEngine | None] = Component("ocr")
        self._thread: threading.Thread | None = None
        # Tokens the document prompt and special tokens take, so a chunk plus
        # its prompt always fits the model's window.
        self.prompt_overhead = 0

    @property
    def components(self) -> list[Component[Any]]:
        return [self.counter, self.embedding, self.pii, self.rerank, self.ocr]

    def start(self) -> None:
        if not self.settings.PII_ENABLED:
            self.pii.disable()
        if not self.settings.rerank_enabled:
            self.rerank.disable()
        self._thread = threading.Thread(target=self._load_all, name="model-loader", daemon=True)
        self._thread.start()

    def _model_dir(self, source) -> Path:  # type: ignore[no-untyped-def]
        return resolve_model_dir(source, self.settings.MODEL_CACHE_DIR, allow_download=self.settings.MODEL_DOWNLOAD)

    def _load_all(self) -> None:
        settings = self.settings
        threads = settings.onnx_threads
        spec = self.embedding_spec
        directory: dict[str, Path] = {}

        def tokenizer() -> HfTokenCounter:
            directory["embedding"] = self._model_dir(spec.source)
            tok = Tokenizer.from_file(str(directory["embedding"] / "tokenizer.json"))
            tok.no_padding()
            tok.no_truncation()
            self.prompt_overhead = len(tok.encode(spec.document_prompt).ids) + 2
            return HfTokenCounter(tok)

        self.counter.load(tokenizer)
        self.embedding.load(
            lambda: EmbeddingModel(
                spec,
                directory.get("embedding") or self._model_dir(spec.source),
                threads=threads,
                dimensions=self.dimensions,
            )
        )
        if self.pii.state != "disabled":
            self.pii.load(self._load_pii)
        if self.rerank.state != "disabled":
            rerank_spec = RERANK_MODELS[settings.RERANK_MODEL]
            self.rerank.load(lambda: RerankModel(rerank_spec, self._model_dir(rerank_spec.source), threads=threads))
        self.ocr.load(lambda: load_ocr_engine(settings.OCR_ENABLED))

    def _load_pii(self) -> Any:
        from .pii import PiiEngine

        ner = None
        if self.settings.transformer_ner_enabled:
            ner_spec = NER_MODELS[self.settings.PII_TRANSFORMER_MODEL]
            ner = NerModel(ner_spec, self._model_dir(ner_spec.source), threads=self.settings.onnx_threads)
        engine = PiiEngine(self.settings.PII_SPACY_MODEL, ner)
        # Warm both models so the first real request is not the slow one.
        engine.analyse(["Ayesha Raza joined the Lahore office in 2019."], ["PERSON"], "en", 0.5)
        return engine

    def status(self) -> dict[str, Any]:
        return {c.name: {"state": c.state, **({"error": c.error} if c.error else {})} for c in self.components}
