"""Cross-language proof: the backend's own TypeScript signer and verifier agree
with this service, in both directions. Skipped when Node or the backend source
is not next to this service."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import orjson
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from app.security import MemoryNonceStore, SignatureMiddleware, sign

from .conftest import SECRET, make_settings

BACKEND = Path(__file__).resolve().parents[2]
SIGNER = BACKEND / "src" / "shared" / "ai-service" / "request-signing.ts"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not SIGNER.exists() or not (BACKEND / "node_modules" / "ts-node").exists(),
    reason="backend source or Node not available",
)

SCRIPT = """
require('ts-node').register({ transpileOnly: true });
const s = require(process.argv[1]);
const input = JSON.parse(process.argv[2]);
const body = Buffer.from(input.body, 'base64');
if (input.mode === 'sign') {
  process.stdout.write(JSON.stringify(s.signRequest({ method: input.method, pathAndQuery: input.target, body, secret: input.secret, keyId: 'v1' })));
} else {
  process.stdout.write(JSON.stringify(s.verifySignature({ method: input.method, pathAndQuery: input.target, body, headers: input.headers, secret: input.secret })));
}
"""


def run_node(payload: dict) -> dict:
    import base64

    payload = {**payload, "body": base64.b64encode(payload["body"]).decode()}
    result = subprocess.run(
        ["node", "-e", SCRIPT, str(SIGNER), json.dumps(payload)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads(result.stdout)


async def echo(request: Request) -> JSONResponse:
    return JSONResponse({"bytes": len(await request.body())})


def gate() -> TestClient:
    inner = Starlette(routes=[Route("/v1/documents/parse", echo, methods=["POST"])])
    return TestClient(SignatureMiddleware(inner, make_settings(), MemoryNonceStore()))


def test_backend_signature_verifies_here() -> None:
    target = "/v1/documents/parse?chunk_overlap=64&chunk_size=512&file_type=pdf&filename=Ayesha+Raza+%C3%A9t%C3%A9.pdf&max_chunks=20000"
    body = b"%PDF-1.7 synthetic body \x00\x01\x02"
    headers = run_node({"mode": "sign", "method": "POST", "target": target, "body": body, "secret": SECRET})
    response = gate().post(target, content=body, headers=headers)
    assert response.status_code == 200, response.text


def test_signature_made_here_verifies_in_the_backend() -> None:
    target = "/v1/embeddings"
    body = orjson.dumps({"model": "m", "input_type": "query", "inputs": ["naïve café ☕"]})
    headers = sign(SECRET.encode(), "POST", target, str(int(time.time())), str(uuid.uuid4()), body)
    verdict = run_node(
        {"mode": "verify", "method": "POST", "target": target, "body": body, "secret": SECRET, "headers": headers}
    )
    assert verdict == {"valid": True}
