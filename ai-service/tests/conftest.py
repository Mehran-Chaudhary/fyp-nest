from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SECRET = "test-secret-that-is-at-least-32-characters-long"
os.environ.setdefault("AI_SERVICE_SIGNING_SECRET", SECRET)
os.environ.setdefault("LOG_FORMAT", "text")
os.environ.setdefault("LOG_LEVEL", "WARNING")

from app.config import Settings  # noqa: E402
from app.security import sign  # noqa: E402


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "AI_SERVICE_SIGNING_SECRET": SECRET,
        "AI_SERVICE_KEY_ID": "v1",
        "MODEL_DOWNLOAD": False,
        "LOG_FORMAT": "text",
        "LOG_LEVEL": "WARNING",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def signed_headers(
    method: str,
    target: str,
    body: bytes = b"",
    *,
    secret: str = SECRET,
    key_id: str = "v1",
    timestamp: int | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    headers = sign(
        secret.encode(),
        method,
        target,
        str(timestamp if timestamp is not None else int(time.time())),
        nonce or str(uuid.uuid4()),
        body,
    )
    headers["x-daiap-key-id"] = key_id
    return headers


def models_available() -> bool:
    cache = ROOT / ".models"
    return (cache / "models--onnx-community--embeddinggemma-300m-ONNX").exists()


requires_models = pytest.mark.skipif(not models_available(), reason="model files not downloaded")
