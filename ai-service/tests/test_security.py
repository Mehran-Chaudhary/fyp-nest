"""The signature gate: every way a request can be forged, replayed or altered."""

from __future__ import annotations

import time

import orjson
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.security import MemoryNonceStore, SignatureMiddleware

from .conftest import SECRET, make_settings, signed_headers


async def echo(request: Request) -> JSONResponse:
    body = await request.body()
    return JSONResponse({"bytes": len(body), "query": request.url.query})


def client(**overrides: object) -> TestClient:
    settings = make_settings(MAX_JSON_BYTES=4096, MAX_DOCUMENT_BYTES=8192, **overrides)
    inner = Starlette(
        routes=[
            Route("/v1/echo", echo, methods=["GET", "POST"]),
            Route("/v1/documents/parse", echo, methods=["POST"]),
            Route("/livez", echo, methods=["GET"]),
        ]
    )
    return TestClient(SignatureMiddleware(inner, settings, MemoryNonceStore()))


def test_valid_signature_passes_and_body_arrives_intact() -> None:
    body = orjson.dumps({"hello": "world"})
    response = client().post("/v1/echo", content=body, headers=signed_headers("POST", "/v1/echo", body))
    assert response.status_code == 200
    assert response.json()["bytes"] == len(body)


def test_query_is_verified_exactly_as_sent() -> None:
    # URLSearchParams encodes a space as "+" and parentheses as %28/%29.
    target = "/v1/documents/parse?chunk_size=512&file_type=pdf&filename=leave+policy+%28v2%29.pdf"
    response = client().post(target, content=b"%PDF-", headers=signed_headers("POST", target, b"%PDF-"))
    assert response.status_code == 200
    assert response.json()["query"] == target.split("?", 1)[1]


def test_altered_query_is_rejected() -> None:
    signed = "/v1/documents/parse?chunk_size=512"
    headers = signed_headers("POST", signed, b"x")
    response = client().post("/v1/documents/parse?chunk_size=4096", content=b"x", headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_SIGNATURE"


def test_altered_body_is_rejected() -> None:
    headers = signed_headers("POST", "/v1/echo", b'{"a":1}')
    response = client().post("/v1/echo", content=b'{"a":2}', headers=headers)
    assert response.status_code == 401
    assert "body hash" in response.json()["error"]["message"]


def test_wrong_secret_is_rejected() -> None:
    headers = signed_headers("POST", "/v1/echo", b"{}", secret="another-secret-of-at-least-32-characters!!")
    assert client().post("/v1/echo", content=b"{}", headers=headers).status_code == 401


def test_unknown_key_id_is_rejected() -> None:
    headers = signed_headers("POST", "/v1/echo", b"{}", key_id="v9")
    assert client().post("/v1/echo", content=b"{}", headers=headers).status_code == 401


def test_stale_timestamp_is_rejected() -> None:
    headers = signed_headers("POST", "/v1/echo", b"{}", timestamp=int(time.time()) - 301)
    response = client().post("/v1/echo", content=b"{}", headers=headers)
    assert response.status_code == 401
    assert "tolerance" in response.json()["error"]["message"]


def test_replayed_nonce_is_rejected() -> None:
    c = client()
    headers = signed_headers("POST", "/v1/echo", b"{}")
    assert c.post("/v1/echo", content=b"{}", headers=headers).status_code == 200
    replay = c.post("/v1/echo", content=b"{}", headers=headers)
    assert replay.status_code == 401
    assert "replayed" in replay.json()["error"]["message"]


def test_missing_headers_are_rejected() -> None:
    assert client().post("/v1/echo", content=b"{}").status_code == 401


def test_method_is_part_of_the_signature() -> None:
    headers = signed_headers("POST", "/v1/echo", b"")
    assert client().get("/v1/echo", headers=headers).status_code == 401


def test_oversized_json_body_is_413_before_verification() -> None:
    body = b"x" * 5000
    response = client().post("/v1/echo", content=body, headers=signed_headers("POST", "/v1/echo", body))
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"


def test_oversized_document_is_document_too_large() -> None:
    body = b"x" * 9000
    target = "/v1/documents/parse"
    response = client().post(target, content=body, headers=signed_headers("POST", target, body))
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "DOCUMENT_TOO_LARGE"


def test_previous_key_is_accepted_during_rotation() -> None:
    old = "the-previous-secret-still-at-least-32-chars"
    c = client(AI_SERVICE_PREVIOUS_SIGNING_SECRET=old, AI_SERVICE_PREVIOUS_KEY_ID="v0")
    headers = signed_headers("POST", "/v1/echo", b"{}", secret=old, key_id="v0")
    assert c.post("/v1/echo", content=b"{}", headers=headers).status_code == 200
    # ...but only under its own key id.
    swapped = signed_headers("POST", "/v1/echo", b"{}", secret=old, key_id="v1")
    assert c.post("/v1/echo", content=b"{}", headers=swapped).status_code == 401


def test_unprotected_paths_need_no_signature() -> None:
    assert client().get("/livez").status_code == 200


@pytest.mark.parametrize("bad", ["v1=zz", "v2=" + "0" * 64, "0" * 64])
def test_malformed_signatures_are_rejected(bad: str) -> None:
    headers = signed_headers("POST", "/v1/echo", b"{}")
    headers["x-daiap-signature"] = bad
    assert client().post("/v1/echo", content=b"{}", headers=headers).status_code == 401


def test_secret_shorter_than_32_characters_is_refused() -> None:
    with pytest.raises(ValueError):
        make_settings(AI_SERVICE_SIGNING_SECRET="short")
    assert len(SECRET) >= 32
