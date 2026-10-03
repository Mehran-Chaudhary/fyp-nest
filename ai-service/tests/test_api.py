"""The HTTP contract, end to end through the signature gate, with stand-in models."""

from __future__ import annotations

import hashlib
from typing import Any, Literal, Sequence
from urllib.parse import urlencode

import numpy as np
import orjson
import pytest
from starlette.testclient import TestClient

from app.main import create_app
from app.pii import Span
from app.runtime import Runtime

from .conftest import make_settings, signed_headers
from .test_chunking import WordCounter


class FakeEmbedding:
    def embed(self, texts: Sequence[str], kind: Literal["query", "document"]) -> tuple[np.ndarray, int]:
        vectors = np.array(
            [np.frombuffer(hashlib.sha256((kind + t).encode()).digest() * 24, dtype=np.uint8)[:768] for t in texts],
            dtype=np.float32,
        ) + 1
        return vectors / np.linalg.norm(vectors, axis=1, keepdims=True), sum(len(t.split()) for t in texts)


class FakeRerank:
    class spec:  # noqa: N801
        label = "fake-reranker"
        multilingual = False

    def score(self, query: str, documents: Sequence[str]) -> np.ndarray:
        words = set(query.lower().split())
        return np.array([len(words & set(d.lower().split())) / (len(words) or 1) for d in documents])


class FakePii:
    detector = {"name": "fake", "version": "1", "model": "test"}
    detector_label = "fake@1/test"

    def analyse(self, texts: Sequence[str], entities: Sequence[str], language: str, threshold: float) -> list[list[Span]]:
        out = []
        for text in texts:
            start = text.find("Ayesha Raza")
            out.append([Span("PERSON", start, start + 11, 0.85)] if start >= 0 and "PERSON" in entities else [])
        return out


def make_client(ready: bool = True, **overrides: Any) -> TestClient:
    settings = make_settings(MODEL_WAIT_SECONDS=0, **overrides)
    runtime = Runtime(settings)
    runtime.start = lambda: None  # type: ignore[method-assign]
    if ready:
        runtime.counter.load(WordCounter)
        runtime.embedding.load(FakeEmbedding)
        runtime.rerank.load(FakeRerank) if settings.rerank_enabled else runtime.rerank.disable()
        runtime.pii.load(FakePii)
        runtime.ocr.load(lambda: None)
    return TestClient(create_app(settings, runtime))


def call(client: TestClient, method: str, path: str, body: Any = None, *, query: dict | None = None, raw: bytes | None = None):  # type: ignore[no-untyped-def]
    target = path + ("?" + urlencode(sorted(query.items())) if query else "")
    content = raw if raw is not None else (orjson.dumps(body) if body is not None else b"")
    headers = signed_headers(method, target, content)
    # Exactly what the backend's AiServiceClient sends.
    if raw is not None:
        headers["content-type"] = "application/octet-stream"
    elif body is not None:
        headers["content-type"] = "application/json"
    return client.request(method, target, content=content, headers=headers)


@pytest.fixture
def client() -> TestClient:
    return make_client()


def test_health_requires_a_signature(client: TestClient) -> None:
    assert client.get("/v1/health").status_code == 401


def test_health_reports_the_contract(client: TestClient) -> None:
    body = call(client, "GET", "/v1/health").json()
    assert body["status"] == "ok"
    assert body["contract_version"] == 1
    assert body["embedding"] == {"model": "embeddinggemma-300m-int8", "dimensions": 768}
    assert body["pii"] == {"available": True, "detector": "fake@1/test"}
    assert body["rerank"]["available"] is True


def test_health_while_loading_is_not_ok() -> None:
    body = call(make_client(ready=False), "GET", "/v1/health").json()
    assert body["status"] == "loading"
    assert body["pii"]["available"] is False


def test_requests_for_a_loading_model_get_503_with_retry_after() -> None:
    response = call(make_client(ready=False), "POST", "/v1/embeddings", {"model": "embeddinggemma-300m-int8", "inputs": ["x"]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "MODEL_LOADING"
    assert int(response.headers["retry-after"]) > 0


PARSE = {"chunk_overlap": 8, "chunk_size": 64, "file_type": "md", "filename": "Ayesha Raza notes.md", "max_chunks": 100}


def test_parse_returns_contract_shaped_chunks(client: TestClient) -> None:
    markdown = b"# Leave\n\n" + b"Employees get twenty days of leave every year. " * 30
    response = call(client, "POST", "/v1/documents/parse", query=PARSE, raw=markdown)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parser"]["name"] == "markdown-it"
    assert body["document"]["language"] == "en"
    assert len(body["chunks"]) > 1
    for chunk in body["chunks"]:
        assert set(chunk) == {"text", "token_count", "page_start", "page_end"}
        assert chunk["token_count"] <= 64
        assert chunk["text"].startswith("Leave\n\n")


@pytest.mark.parametrize(
    ("query", "raw", "status", "code"),
    [
        ({**PARSE, "file_type": "xlsx"}, b"x", 415, "UNSUPPORTED_FILE_TYPE"),
        ({**PARSE, "file_type": "pdf"}, b"not a pdf", 422, "UNPARSEABLE_DOCUMENT"),
        ({**PARSE, "chunk_overlap": 64}, b"x", 400, "INVALID_REQUEST"),
        ({**PARSE, "max_chunks": 1}, b"word " * 500, 422, "TOO_MANY_CHUNKS"),
        ({k: v for k, v in PARSE.items() if k != "chunk_size"}, b"x", 400, "INVALID_REQUEST"),
    ],
)
def test_parse_errors(client: TestClient, query: dict, raw: bytes, status: int, code: str) -> None:
    response = call(client, "POST", "/v1/documents/parse", query=query, raw=raw)
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


def test_empty_document_yields_no_chunks(client: TestClient) -> None:
    body = call(client, "POST", "/v1/documents/parse", query={**PARSE, "file_type": "txt"}, raw=b"").json()
    assert body["chunks"] == []


def test_embeddings(client: TestClient) -> None:
    body = call(
        client, "POST", "/v1/embeddings", {"model": "embeddinggemma-300m-int8", "input_type": "query", "inputs": ["a", "b c"]}
    ).json()
    assert body["model"] == "embeddinggemma-300m-int8"
    assert body["dimensions"] == 768
    assert len(body["embeddings"]) == 2 and all(len(v) == 768 for v in body["embeddings"])
    assert abs(sum(x * x for x in body["embeddings"][0]) - 1) < 1e-4
    assert body["usage"]["tokens"] == 3


def test_embeddings_for_another_model_are_refused_as_transient(client: TestClient) -> None:
    response = call(client, "POST", "/v1/embeddings", {"model": "nomic-embed-text", "inputs": ["x"]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "MODEL_NOT_AVAILABLE"


def test_validation_errors_never_echo_input(client: TestClient) -> None:
    response = call(client, "POST", "/v1/embeddings", {"model": "embeddinggemma-300m-int8", "inputs": "Ayesha Raza"})
    assert response.status_code == 400
    assert "Ayesha" not in response.text


def test_rerank_orders_best_first_and_honours_top_n(client: TestClient) -> None:
    body = call(
        client,
        "POST",
        "/v1/rerank",
        {"query": "annual leave days", "documents": ["parking rules", "annual leave is twenty days", "leave forms"], "top_n": 2},
    ).json()
    assert [r["index"] for r in body["results"]] == [1, 2]
    assert body["results"][0]["score"] >= body["results"][1]["score"]


def test_disabled_capabilities_answer_404_so_the_backend_degrades_at_once() -> None:
    client = make_client(RERANK_MODEL="none")
    response = call(client, "POST", "/v1/rerank", {"query": "q", "documents": ["d"], "top_n": 1})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_ENABLED"


def test_pii_analyze(client: TestClient) -> None:
    body = call(
        client,
        "POST",
        "/v1/pii/analyze",
        {"texts": ["Employee: Ayesha Raza, joined 2019.", ""], "entities": ["PERSON"], "language": "en", "score_threshold": 0.5},
    ).json()
    assert body["results"] == [[{"entity_type": "PERSON", "start": 10, "end": 21, "score": 0.85}], []]
    assert body["detector"]["name"] == "fake"


def test_pii_rejects_malformed_entity_names(client: TestClient) -> None:
    response = call(client, "POST", "/v1/pii/analyze", {"texts": ["x"], "entities": ["person"], "language": "en"})
    assert response.status_code == 400


def test_pii_limits_total_characters() -> None:
    client = make_client(MAX_PII_CHARACTERS=1000)
    response = call(client, "POST", "/v1/pii/analyze", {"texts": ["a" * 1001], "entities": ["PERSON"]})
    assert response.status_code == 413


def test_responses_carry_the_request_id(client: TestClient) -> None:
    target = "/v1/health"
    headers = signed_headers("GET", target) | {"x-request-id": "req-123"}
    assert client.get(target, headers=headers).headers["x-request-id"] == "req-123"


def test_livez_is_open(client: TestClient) -> None:
    assert client.get("/livez").json() == {"status": "alive"}


@pytest.mark.parametrize(
    ("query", "documents", "reason"),
    [
        ("سالانہ چھٹیاں کتنی ہیں؟", ["annual leave is twenty days"], "query"),
        ("annual leave", ["سالانہ چھٹی بیس دن", "دفتر نو بجے کھلتا ہے"], "passages"),
        ("annual leave", ["parking rules", "canteen hours"], "clearly relevant"),
    ],
)
def test_rerank_declines_when_it_cannot_help(client: TestClient, query: str, documents: list[str], reason: str) -> None:
    response = call(client, "POST", "/v1/rerank", {"query": query, "documents": documents, "top_n": 1})
    assert response.status_code == 422  # the backend keeps its fused order, no retry
    assert response.json()["error"]["code"] == "RERANK_NOT_APPLICABLE"
    assert reason in response.json()["error"]["message"]
