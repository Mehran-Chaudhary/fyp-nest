"""Errors in the contract's shape: `{"error": {"code": ..., "message": ...}}`.

The status code is a decision the backend acts on (contract §Errors):

- 400/413/415/422: a permanent problem with *this input*. The document is marked
  FAILED with our code and message, which the end user sees, so messages are
  written for them and never carry internals.
- 401/403: signature rejected (a deployment fault; the backend retries).
- 408/429/5xx: transient. Retried with backoff, honouring Retry-After.
"""

from __future__ import annotations

from typing import Any

import orjson
from starlette.responses import Response


class ServiceError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


def error_response(
    status: int,
    code: str,
    message: str,
    *,
    retry_after: int | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    out_headers = dict(headers or {})
    if retry_after is not None:
        out_headers["retry-after"] = str(retry_after)
    return Response(
        content=orjson.dumps({"error": {"code": code, "message": message}}),
        status_code=status,
        media_type="application/json",
        headers=out_headers,
    )


def from_service_error(error: ServiceError, headers: dict[str, str] | None = None) -> Response:
    return error_response(
        error.status, error.code, error.message, retry_after=error.retry_after, headers=headers
    )


# Convenience constructors, one per code the contract suggests.


def unsupported_file_type(file_type: str) -> ServiceError:
    return ServiceError(415, "UNSUPPORTED_FILE_TYPE", f"Files of type '{file_type}' are not supported.")


def document_too_large(limit: int) -> ServiceError:
    return ServiceError(
        413, "DOCUMENT_TOO_LARGE", f"The document is larger than the {limit // (1024 * 1024)} MB limit."
    )


def unparseable(message: str = "The document could not be read. It may be damaged.") -> ServiceError:
    return ServiceError(422, "UNPARSEABLE_DOCUMENT", message)


def encrypted() -> ServiceError:
    return ServiceError(
        422,
        "ENCRYPTED_DOCUMENT",
        "The document is password protected. Remove the password and upload it again.",
    )


def too_many_chunks(count: int, limit: int) -> ServiceError:
    return ServiceError(
        422,
        "TOO_MANY_CHUNKS",
        f"The document is too long: it produced {count} chunks, above the limit of {limit}.",
    )


def invalid_request(message: str) -> ServiceError:
    return ServiceError(400, "INVALID_REQUEST", message)


def model_loading(retry_after: int = 10) -> ServiceError:
    return ServiceError(
        503, "MODEL_LOADING", "The model is still loading. Try again shortly.", retry_after=retry_after
    )


def model_not_available(message: str) -> ServiceError:
    return ServiceError(503, "MODEL_NOT_AVAILABLE", message, retry_after=30)


def details(error: BaseException) -> dict[str, Any]:
    """What may be logged about an unexpected error: its type, never its text."""
    return {"error_type": type(error).__name__}
