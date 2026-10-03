"""Document language identification (py3langid: fast, deterministic, 97 languages)."""

from __future__ import annotations

import logging

log = logging.getLogger("daiap.language")

_SAMPLE_CHARACTERS = 8_000
_MIN_CHARACTERS = 40

try:
    from py3langid.langid import MODEL_FILE, LanguageIdentifier

    _IDENTIFIER: LanguageIdentifier | None = LanguageIdentifier.from_model_file(MODEL_FILE, norm_probs=True)
except Exception:  # noqa: BLE001 - language is optional metadata
    _IDENTIFIER = None
    log.info("py3langid unavailable; document language will not be reported")


def detect_language(text: str) -> str | None:
    """ISO 639-1 code of the dominant language, or None when unsure."""
    if _IDENTIFIER is None:
        return None
    sample = text[:_SAMPLE_CHARACTERS]
    if sum(c.isalpha() for c in sample) < _MIN_CHARACTERS:
        return None
    code, probability = _IDENTIFIER.classify(sample)
    return code if probability >= 0.8 else None
