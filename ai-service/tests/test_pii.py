"""PII: span hygiene (no models) and the real Presidio + transformer engine."""

from __future__ import annotations

from functools import lru_cache

import pytest

from app import errors
from app.pii import PiiEngine, Span, _clean, _merge_same_type

from .conftest import ROOT, requires_models


def clean(text: str, start: int, end: int, kind: str = "PERSON") -> str | None:
    span = _clean(Span(kind, start, end, 0.9), text)
    return None if span is None else text[span.start : span.end]


def test_edges_are_trimmed() -> None:
    text = 'Signed: "Ayesha Raza", (Bilal).'
    assert clean(text, 8, 21) == "Ayesha Raza"
    assert clean(text, 23, 30) == "Bilal"


@pytest.mark.parametrize("value", ["Email", "CNIC", "Dear", "c12bee3c11f2", "INV-2026-09326", "XBxY!383PDbcc", "--"])
def test_implausible_person_spans_are_dropped(value: str) -> None:
    assert clean(value, 0, len(value)) is None


def test_non_person_types_keep_digits() -> None:
    assert clean("Flat 4B, Gulberg", 0, 16, "LOCATION") == "Flat 4B, Gulberg"


def test_same_type_overlaps_merge_and_scores_clamp() -> None:
    merged = _merge_same_type(
        [Span("PERSON", 0, 6, 0.7), Span("PERSON", 0, 11, 1.2), Span("LOCATION", 3, 9, 0.6)], length=20
    )
    assert [(s.entity_type, s.start, s.end, s.score) for s in merged] == [
        ("PERSON", 0, 11, 1.0),
        ("LOCATION", 3, 9, 0.6),
    ]


def test_out_of_range_spans_are_dropped() -> None:
    assert _merge_same_type([Span("PERSON", 5, 50, 0.9)], length=10) == []


# ── The real engine ──────────────────────────────────────────────────────────


def _spacy_installed() -> bool:
    try:
        import en_core_web_md  # noqa: F401
    except ImportError:
        return False
    return True


@lru_cache(maxsize=1)
def engine() -> PiiEngine:
    from app.models.onnx import NerModel, resolve_model_dir
    from app.models.registry import NER_MODELS

    spec = NER_MODELS["distilbert-NER"]
    ner = NerModel(spec, resolve_model_dir(spec.source, ROOT / ".models", allow_download=False), threads=None)
    return PiiEngine("en_core_web_md", ner)


def needs_engine(test):  # type: ignore[no-untyped-def]
    for mark in (requires_models, pytest.mark.models, pytest.mark.skipif(not _spacy_installed(), reason="spaCy model missing")):
        test = mark(test)
    return test


@needs_engine
def test_names_places_and_organisations() -> None:
    text = "Ayesha Raza (People Ops) met Bilal Qureshi in Lahore to review Meezan Bank's contract. Email: hr@acme.test"
    [spans] = engine().analyse([text], ["PERSON", "LOCATION", "ORGANIZATION"], "en", 0.5)
    found = {(s.entity_type, text[s.start : s.end]) for s in spans}
    assert {("PERSON", "Ayesha Raza"), ("PERSON", "Bilal Qureshi"), ("LOCATION", "Lahore")} <= found
    assert not any(text[s.start : s.end] == "Email" for s in spans)


@needs_engine
def test_offsets_are_code_points_after_emoji() -> None:
    text = "👋🏽 Welcome aboard, Sana Malik!"
    [spans] = engine().analyse([text], ["PERSON"], "en", 0.5)
    assert any(text[s.start : s.end] == "Sana Malik" for s in spans)


@needs_engine
def test_only_requested_entities_are_returned() -> None:
    [spans] = engine().analyse(["Ayesha Raza flew to Karachi."], ["LOCATION"], "en", 0.5)
    assert {s.entity_type for s in spans} == {"LOCATION"}


@needs_engine
def test_presidio_pattern_types_are_served() -> None:
    text = "Licence on file: medical licence number AB1234563 (DEA, checksum valid)."
    [spans] = engine().analyse([text], ["MEDICAL_LICENSE"], "en", 0.3)
    assert any(s.entity_type == "MEDICAL_LICENSE" for s in spans)


@needs_engine
def test_unsupported_language_is_422() -> None:
    with pytest.raises(errors.ServiceError) as caught:
        engine().analyse(["x"], ["PERSON"], "ur", 0.5)
    assert caught.value.status == 422 and caught.value.code == "UNSUPPORTED_LANGUAGE"


@needs_engine
def test_empty_and_whitespace_texts() -> None:
    assert engine().analyse(["", "   "], ["PERSON"], "en", 0.5) == [[], []]
