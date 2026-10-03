"""HMAC request verification (contract §Authentication), as pure ASGI middleware.

Every `/v1/*` request must carry a valid `DAIAP-HMAC-SHA256` signature. The
checks run in order of cost, and anything that fails gets 401:

1. the key id is one we hold (two during a rotation);
2. the timestamp is within ±SIGNATURE_TOLERANCE_SECONDS of our clock;
3. the body fits its size limit (413 otherwise), then its SHA-256 matches
   `X-DAIAP-Content-SHA256`;
4. the HMAC over the canonical string matches, compared in constant time;
5. the nonce has not been seen inside the window (replay). It is recorded only
   after the signature is proven, so unsigned junk cannot fill the store.

The canonical string uses the path and query **exactly as received** (the raw
bytes, not a re-encoding of parsed parameters): the backend signs what
`URLSearchParams` produced, `+` for spaces and all.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import time
from collections import OrderedDict
from typing import Protocol

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings
from .errors import error_response

log = logging.getLogger("daiap.security")

SCHEME = "DAIAP-HMAC-SHA256"
PROTECTED_PREFIX = "/v1/"
PARSE_PATH = "/v1/documents/parse"

_TIMESTAMP = re.compile(r"^\d{1,12}$")
_NONCE = re.compile(r"^[A-Za-z0-9-]{8,128}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def canonical_string(method: str, target: str, timestamp: str, nonce: str, content_sha256: str) -> bytes:
    return "\n".join([SCHEME, method.upper(), target, timestamp, nonce, content_sha256]).encode()


def sign(secret: bytes, method: str, target: str, timestamp: str, nonce: str, body: bytes) -> dict[str, str]:
    """Produces signing headers exactly as the backend does. Used by tests and tools."""
    content = hashlib.sha256(body).hexdigest()
    mac = hmac.new(secret, canonical_string(method, target, timestamp, nonce, content), hashlib.sha256)
    return {
        "x-daiap-timestamp": timestamp,
        "x-daiap-nonce": nonce,
        "x-daiap-content-sha256": content,
        "x-daiap-signature": "v1=" + mac.hexdigest(),
    }


# ── Replay protection ────────────────────────────────────────────────────────


class NonceStore(Protocol):
    async def add_if_new(self, nonce: str, ttl_seconds: int) -> bool:
        """Records the nonce; False when it was already present (a replay)."""
        ...

    async def close(self) -> None: ...


class MemoryNonceStore:
    """Exact for a single replica. Entries expire in insertion order."""

    def __init__(self, max_entries: int = 500_000) -> None:
        self._entries: OrderedDict[str, float] = OrderedDict()
        self._max = max_entries

    async def add_if_new(self, nonce: str, ttl_seconds: int) -> bool:
        now = time.monotonic()
        while self._entries:
            oldest, expires = next(iter(self._entries.items()))
            if expires > now:
                break
            del self._entries[oldest]
        if nonce in self._entries:
            return False
        if len(self._entries) >= self._max:
            # Only verified requests reach here, so this is real traffic far
            # beyond design. Refusing is safer than forgetting live nonces.
            raise ReplayStoreUnavailable("nonce store full")
        self._entries[nonce] = now + ttl_seconds
        return True

    async def close(self) -> None:
        self._entries.clear()


class RedisNonceStore:
    """Shared across replicas: `SET key 1 NX EX ttl` is an atomic check-and-set."""

    def __init__(self, url: str) -> None:
        from redis import asyncio as aioredis

        self._client = aioredis.from_url(url, socket_timeout=3, socket_connect_timeout=3)

    async def add_if_new(self, nonce: str, ttl_seconds: int) -> bool:
        try:
            return bool(await self._client.set(f"daiap:ai:nonce:{nonce}", b"1", nx=True, ex=ttl_seconds))
        except Exception as error:  # noqa: BLE001 - any store failure fails closed
            raise ReplayStoreUnavailable(type(error).__name__) from error

    async def close(self) -> None:
        await self._client.aclose()


class ReplayStoreUnavailable(Exception):
    pass


def build_nonce_store(settings: Settings) -> NonceStore:
    return RedisNonceStore(settings.REPLAY_REDIS_URL) if settings.REPLAY_REDIS_URL else MemoryNonceStore()


# ── Middleware ───────────────────────────────────────────────────────────────


class _BodyTooLarge(Exception):
    pass


async def _read_body(receive: Receive, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise ConnectionAbortedError
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > limit:
            raise _BodyTooLarge
        chunks.append(chunk)
        if not message.get("more_body", False):
            return b"".join(chunks)


class SignatureMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings, nonce_store: NonceStore) -> None:
        self.app = app
        self.keys = settings.signing_keys
        self.tolerance = settings.SIGNATURE_TOLERANCE_SECONDS
        self.nonce_ttl = settings.SIGNATURE_TOLERANCE_SECONDS * 2
        self.document_limit = settings.MAX_DOCUMENT_BYTES
        self.json_limit = settings.MAX_JSON_BYTES
        self.nonces = nonce_store

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(PROTECTED_PREFIX):
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}

        async def reject(reason: str) -> None:
            log.warning("signature rejected", extra={"reason": reason, "path": scope["path"]})
            await error_response(401, "INVALID_SIGNATURE", f"Request signature rejected: {reason}.")(
                scope, receive, send
            )

        # 1-2: cheap header checks before reading any body.
        secret = self.keys.get(headers.get("x-daiap-key-id", ""))
        timestamp = headers.get("x-daiap-timestamp", "")
        nonce = headers.get("x-daiap-nonce", "")
        presented = headers.get("x-daiap-signature", "")
        declared_sha = headers.get("x-daiap-content-sha256", "").lower()
        if secret is None:
            return await reject("unknown key id")
        if not _TIMESTAMP.match(timestamp) or not _NONCE.match(nonce):
            return await reject("missing or malformed timestamp or nonce")
        if not presented.startswith("v1=") or not _HEX64.match(presented[3:].lower()):
            return await reject("missing or malformed signature")
        if not _HEX64.match(declared_sha):
            return await reject("missing or malformed content hash")
        if abs(time.time() - int(timestamp)) > self.tolerance:
            return await reject("timestamp outside the tolerance window (check both clocks)")

        # 3: the body, bounded.
        is_parse = scope["path"] == PARSE_PATH
        limit = self.document_limit if is_parse else self.json_limit
        declared_length = headers.get("content-length")
        if declared_length and declared_length.isdigit() and int(declared_length) > limit:
            return await self._too_large(scope, receive, send, is_parse, limit)
        try:
            body = await _read_body(receive, limit)
        except _BodyTooLarge:
            return await self._too_large(scope, receive, send, is_parse, limit)
        except ConnectionAbortedError:
            return

        if not hmac.compare_digest(hashlib.sha256(body).hexdigest(), declared_sha):
            return await reject("body hash mismatch")

        # 4: the MAC over the exact target received.
        raw_path = scope.get("raw_path") or scope["path"].encode()
        target = raw_path.decode("latin-1")
        query = scope.get("query_string", b"")
        if query:
            target += "?" + query.decode("latin-1")
        expected = hmac.new(
            secret,
            canonical_string(scope["method"], target, timestamp, nonce, declared_sha),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, presented[3:].lower()):
            return await reject("signature mismatch")

        # 5: single use.
        try:
            fresh = await self.nonces.add_if_new(nonce, self.nonce_ttl)
        except ReplayStoreUnavailable:
            log.error("nonce store unavailable; refusing request")
            return await error_response(
                503, "REPLAY_STORE_UNAVAILABLE", "Temporarily unable to verify requests.", retry_after=5
            )(scope, receive, send)
        if not fresh:
            return await reject("replayed nonce")

        delivered = False

        async def replay_body() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay_body, send)

    @staticmethod
    async def _too_large(scope: Scope, receive: Receive, send: Send, is_parse: bool, limit: int) -> None:
        mb = limit // (1024 * 1024)
        code, message = (
            ("DOCUMENT_TOO_LARGE", f"The document is larger than the {mb} MB limit.")
            if is_parse
            else ("REQUEST_TOO_LARGE", f"The request body is larger than the {mb} MB limit.")
        )
        await error_response(413, code, message)(scope, receive, send)
