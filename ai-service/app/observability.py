"""Structured logging and per-request context.

The privacy rule from the contract is enforced here by construction: log lines
carry ids, counts, sizes and timings. Document text, queries, PII-analysis
texts and filenames (which often contain names) are never passed to a logger.
"""

from __future__ import annotations

import logging
import sys
import time
import traceback
import uuid
from contextvars import ContextVar
from typing import Any

import orjson
from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
organization_id_var: ContextVar[str] = ContextVar("organization_id", default="-")

_STANDARD_ATTRS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
            "organization_id": organization_id_var.get(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            # The type and the stack, never the exception's message: messages
            # from parsers and models can quote the input they choked on.
            entry["exc_type"] = record.exc_info[0].__name__
            entry["stack"] = "".join(traceback.format_tb(record.exc_info[2]))
        return orjson.dumps(entry, default=str).decode()


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _STANDARD_ATTRS and not k.startswith("_")
        }
        base = (
            f"{self.formatTime(record, '%H:%M:%S')} {record.levelname:<7} "
            f"[{request_id_var.get()[:8]}] {record.name}: {record.getMessage()}"
        )
        if extras:
            base += " " + " ".join(f"{k}={v}" for k, v in extras.items())
        if record.exc_info and record.exc_info[0] is not None:
            base += f" exc_type={record.exc_info[0].__name__}"
        return base


def configure_logging(level: str, fmt: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # Uvicorn's access log would print request lines without our context;
    # RequestContextMiddleware writes a better one.
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    logging.getLogger("uvicorn.access").disabled = True
    # Libraries that log at INFO about every model file they touch.
    for noisy in ("httpx", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, logging.getLevelName(level)))
    # Presidio warns at startup about every recognizer for a language we did
    # not configure (Spanish NIF, Italian fiscal code, ...): pure noise.
    logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)


access_log = logging.getLogger("daiap.access")


class RequestContextMiddleware:
    """Correlation ids in, one access log line out, `X-Request-Id` echoed back.

    Outermost middleware, so that requests the signature check refuses are
    logged with their id too.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        request_id = _safe_id(headers.get("x-request-id")) or uuid.uuid4().hex
        organization_id = _safe_id(headers.get("x-organization-id")) or "-"
        document_id = _safe_id(headers.get("x-document-id"))
        rid_token = request_id_var.set(request_id)
        org_token = organization_id_var.set(organization_id)

        started = time.perf_counter()
        status = 500
        response_bytes = 0

        async def send_wrapper(message: Message) -> None:
            nonlocal status, response_bytes
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [
                    (b"x-request-id", request_id.encode("latin-1"))
                ]
            elif message["type"] == "http.response.body":
                response_bytes += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            path = scope.get("path", "")
            if path not in ("/livez",):
                extra: dict[str, Any] = {
                    "method": scope.get("method"),
                    "path": path,
                    "status": status,
                    "duration_ms": duration_ms,
                    "request_bytes": int(headers.get("content-length") or 0),
                    "response_bytes": response_bytes,
                }
                if document_id:
                    extra["document_id"] = document_id
                level = logging.WARNING if status >= 400 else logging.INFO
                access_log.log(level, "request", extra=extra)
            request_id_var.reset(rid_token)
            organization_id_var.reset(org_token)


def _safe_id(value: str | None) -> str | None:
    """Accepts ids made of safe characters only, so a header cannot inject log lines."""
    if not value or len(value) > 128:
        return None
    return value if all(c.isalnum() or c in "-_.:" for c in value) else None
