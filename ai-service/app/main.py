"""HTTP surface: contract v1 (docs/contracts/ai-service-v1.md).

    GET  /v1/health              signed   model and capability report
    POST /v1/documents/parse     signed   bytes → structured, token-sized chunks
    POST /v1/embeddings          signed   texts → unit vectors
    POST /v1/rerank              signed   query + passages → relevance order
    POST /v1/pii/analyze         signed   texts → entity spans (code points)
    GET  /livez                  open     process liveness for the platform

Run: `uvicorn app.main:app --host 0.0.0.0 --port 8000` (one worker: models are
loaded once per process and shared by the thread-pool lanes).
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator, Literal

import numpy as np
import orjson
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.responses import Response
from starlette.types import ASGIApp

from . import __version__, errors
from .chunking import Chunker
from .config import Settings, get_settings
from .language import detect_language
from .observability import RequestContextMiddleware, configure_logging
from .parsing import SUPPORTED_TYPES, extract
from .runtime import Runtime, run_in
from .security import SignatureMiddleware, build_nonce_store

CONTRACT_VERSION = 1
log = logging.getLogger("daiap.api")


def json_response(payload: Any, status: int = 200) -> Response:
    return Response(
        orjson.dumps(payload, option=orjson.OPT_SERIALIZE_NUMPY),
        status_code=status,
        media_type="application/json",
    )


# ── Request bodies ───────────────────────────────────────────────────────────

EntityName = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9_]{1,40}$")]


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


class EmbeddingRequest(_Body):
    model: str = Field(min_length=1, max_length=200)
    input_type: Literal["document", "query"] = "document"
    inputs: list[str] = Field(min_length=1)


class RerankRequest(_Body):
    query: str = Field(min_length=1, max_length=20_000)
    documents: list[str] = Field(min_length=1)
    top_n: int = Field(default=8, ge=1)


class PiiRequest(_Body):
    texts: list[str]
    entities: list[EntityName] = Field(default_factory=lambda: ["PERSON"])
    language: str = Field(default="en", pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
    score_threshold: float = Field(default=0.5, ge=0.0, le=1.0)


# ── Application ──────────────────────────────────────────────────────────────


def create_app(settings: Settings | None = None, runtime: Runtime | None = None) -> ASGIApp:
    settings = settings or get_settings()
    configure_logging(settings.LOG_LEVEL, settings.LOG_FORMAT)
    runtime = runtime or Runtime(settings)
    nonce_store = build_nonce_store(settings)
    wait = settings.MODEL_WAIT_SECONDS

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        log.info(
            "starting",
            extra={
                "version": __version__,
                "embedding_model": runtime.embedding_spec.label,
                "dimensions": runtime.dimensions,
                "rerank_model": settings.RERANK_MODEL if settings.rerank_enabled else None,
                "pii": settings.PII_ENABLED,
            },
        )
        runtime.start()
        yield
        await nonce_store.close()

    api = FastAPI(
        title="DAIAP AI service",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.DOCS_ENABLED else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.DOCS_ENABLED else None,
    )
    api.state.runtime = runtime

    @api.exception_handler(errors.ServiceError)
    async def _service_error(_: Request, error: errors.ServiceError) -> Response:
        return errors.from_service_error(error)

    @api.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, error: RequestValidationError) -> Response:
        # Field locations only: never echo input values (they may be PII).
        fields = sorted({".".join(str(p) for p in e["loc"] if p != "body") or "body" for e in error.errors()})
        return errors.error_response(400, "INVALID_REQUEST", f"Invalid request: check {', '.join(fields)}.")

    @api.exception_handler(Exception)
    async def _unexpected(_: Request, error: Exception) -> Response:
        log.error("unhandled error", exc_info=error)
        return errors.error_response(500, "INTERNAL_ERROR", "The AI service hit an unexpected error.")

    # ── Health ───────────────────────────────────────────────────────────────

    @api.get("/livez", include_in_schema=False)
    async def livez() -> Response:
        return json_response({"status": "alive"})

    @api.get("/v1/health")
    async def health() -> Response:
        embedding_state = runtime.embedding.state
        status = {"ready": "ok", "failed": "error"}.get(embedding_state, "loading")
        pii = runtime.pii.value if runtime.pii.state == "ready" else None
        return json_response(
            {
                "status": status,
                "contract_version": CONTRACT_VERSION,
                "service": {"name": "daiap-ai-service", "version": __version__},
                "embedding": {"model": runtime.embedding_spec.label, "dimensions": runtime.dimensions},
                "rerank": {
                    "available": runtime.rerank.state == "ready",
                    "model": settings.RERANK_MODEL if settings.rerank_enabled else None,
                },
                "pii": {"available": pii is not None, "detector": pii.detector_label if pii else None},
                "ocr": {"available": runtime.ocr.state == "ready" and runtime.ocr.value is not None},
                "models": runtime.status(),
            }
        )

    # ── Parse ────────────────────────────────────────────────────────────────

    @api.post("/v1/documents/parse")
    async def parse(
        request: Request,
        file_type: Annotated[str, Query()],
        chunk_size: Annotated[int, Query(ge=16, le=8192)],
        chunk_overlap: Annotated[int, Query(ge=0, le=4096)],
        max_chunks: Annotated[int, Query(ge=1, le=1_000_000)],
        filename: Annotated[str, Query(max_length=1024)] = "",  # for logs only; never logged
    ) -> Response:
        del filename  # often contains a person's name: deliberately unused
        if file_type not in SUPPORTED_TYPES:
            raise errors.unsupported_file_type(file_type)
        if chunk_overlap >= chunk_size:
            raise errors.invalid_request("chunk_overlap must be smaller than chunk_size.")
        data = await request.body()
        counter = await runtime.counter.get(wait)
        ocr = runtime.ocr.value if runtime.ocr.state == "ready" else None
        window = runtime.embedding_spec.max_tokens - runtime.prompt_overhead
        effective_size = min(chunk_size, window)

        def work() -> dict[str, Any]:
            started = time.perf_counter()
            document = extract(data, file_type, ocr=ocr, max_ocr_pages=settings.OCR_MAX_PAGES)
            extracted = time.perf_counter()
            chunker = Chunker(
                counter,
                effective_size,
                chunk_overlap,
                context_headers=settings.CHUNK_CONTEXT_HEADERS,
                max_characters=settings.MAX_CHUNK_CHARACTERS,
            )
            chunks = chunker.chunk(document.blocks)
            if len(chunks) > max_chunks:
                raise errors.too_many_chunks(len(chunks), max_chunks)
            language = detect_language(document.text[:20_000])
            log.info(
                "document parsed",
                extra={
                    "file_type": file_type,
                    "bytes": len(data),
                    "pages": document.page_count,
                    "empty_pages": document.empty_pages,
                    "ocr_pages": document.ocr_pages,
                    "blocks": len(document.blocks),
                    "chunks": len(chunks),
                    "chunk_size": effective_size,
                    "extract_ms": round((extracted - started) * 1000),
                    "chunk_ms": round((time.perf_counter() - extracted) * 1000),
                },
            )
            parser = document.parser + ("+ocr" if document.ocr_pages else "")
            return {
                "document": {"page_count": document.page_count, "language": language},
                "chunks": [
                    {
                        "text": chunk.text,
                        "token_count": chunk.token_count,
                        "page_start": chunk.page_start,
                        "page_end": chunk.page_end,
                    }
                    for chunk in chunks
                ],
                "parser": {"name": parser[:40], "version": document.parser_version[:20]},
            }

        return json_response(await run_in(runtime.lanes.parse, work))

    # ── Embeddings ───────────────────────────────────────────────────────────

    @api.post("/v1/embeddings")
    async def embeddings(body: EmbeddingRequest) -> Response:
        label = runtime.embedding_spec.label
        if body.model != label:
            raise errors.model_not_available(
                f"This service embeds with '{label}' but the request asked for '{body.model}'. "
                "Set EMBEDDING_MODEL to the same label on the backend and on the AI service."
            )
        if len(body.inputs) > settings.MAX_EMBED_INPUTS:
            raise errors.invalid_request(f"At most {settings.MAX_EMBED_INPUTS} inputs per request.")
        model = await runtime.embedding.get(wait)
        vectors, tokens = await run_in(runtime.lanes.embed, model.embed, body.inputs, body.input_type)
        if not np.isfinite(vectors).all() or (np.abs(vectors).sum(axis=1) == 0).any():
            log.error("embedding produced a non-finite or zero vector")
            raise errors.ServiceError(500, "EMBEDDING_FAILED", "The embedding model produced an invalid vector.")
        return json_response(
            {"model": label, "dimensions": runtime.dimensions, "embeddings": vectors, "usage": {"tokens": tokens}}
        )

    # ── Rerank ───────────────────────────────────────────────────────────────

    @api.post("/v1/rerank")
    async def rerank(body: RerankRequest) -> Response:
        if len(body.documents) > settings.MAX_RERANK_DOCUMENTS:
            raise errors.invalid_request(f"At most {settings.MAX_RERANK_DOCUMENTS} documents per request.")
        model = await runtime.rerank.get(wait)
        scores = await run_in(runtime.lanes.rerank, model.score, body.query, body.documents)
        order = np.argsort(-scores, kind="stable")[: min(body.top_n, len(body.documents))]
        return json_response(
            {
                "model": model.spec.label,
                "results": [{"index": int(i), "score": round(float(scores[i]), 6)} for i in order],
            }
        )

    # ── PII ──────────────────────────────────────────────────────────────────

    @api.post("/v1/pii/analyze")
    async def pii_analyze(body: PiiRequest) -> Response:
        if len(body.texts) > settings.MAX_PII_TEXTS:
            raise errors.invalid_request(f"At most {settings.MAX_PII_TEXTS} texts per request.")
        if sum(len(t) for t in body.texts) > settings.MAX_PII_CHARACTERS:
            raise errors.ServiceError(
                413, "REQUEST_TOO_LARGE", f"At most {settings.MAX_PII_CHARACTERS} characters per request."
            )
        engine = await runtime.pii.get(wait)
        results = await run_in(
            runtime.lanes.pii, engine.analyse, body.texts, body.entities, body.language, body.score_threshold
        )
        return json_response(
            {
                "results": [
                    [{"entity_type": s.entity_type, "start": s.start, "end": s.end, "score": s.score} for s in spans]
                    for spans in results
                ],
                "detector": engine.detector,
            }
        )

    # Outermost first: correlation and access log, then the signature gate.
    return RequestContextMiddleware(SignatureMiddleware(api, settings, nonce_store))


def __getattr__(name: str) -> Any:
    # `uvicorn app.main:app` builds the app on first access, so importing this
    # module (tests, tools) does not require the signing secret to be set.
    if name == "app":
        application = create_app()
        globals()["app"] = application
        return application
    raise AttributeError(name)
