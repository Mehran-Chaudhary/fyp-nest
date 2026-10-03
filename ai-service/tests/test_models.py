"""The real models (int8 ONNX), on behaviour that matters to the platform.

Skipped when the model files have not been downloaded
(`python -m app.models.download`).
"""

from __future__ import annotations

import random
from functools import lru_cache
from pathlib import Path

import numpy as np
import pytest

from app.models.onnx import EmbeddingModel, NerModel, RerankModel, resolve_model_dir
from app.models.registry import EMBEDDING_MODELS, NER_MODELS, RERANK_MODELS

from .conftest import ROOT, requires_models

pytestmark = [requires_models, pytest.mark.models]
CACHE = ROOT / ".models"


def model_dir(source) -> Path:  # type: ignore[no-untyped-def]
    return resolve_model_dir(source, CACHE, allow_download=False)


@lru_cache(maxsize=1)
def embedder() -> EmbeddingModel:
    spec = EMBEDDING_MODELS["embeddinggemma-300m-int8"]
    return EmbeddingModel(spec, model_dir(spec.source), threads=None)


@lru_cache(maxsize=1)
def reranker() -> RerankModel:
    spec = RERANK_MODELS["bge-reranker-base"]
    return RerankModel(spec, model_dir(spec.source), threads=None)


@lru_cache(maxsize=1)
def ner() -> NerModel:
    spec = NER_MODELS["bert-base-NER"]
    return NerModel(spec, model_dir(spec.source), threads=None)


PASSAGES = [
    "Employees are entitled to twenty days of annual leave per calendar year, accrued monthly.",
    "Travel expenses are reimbursed within thirty days of submitting receipts to finance.",
    "The office network requires multi-factor authentication for every remote login.",
    "Salaries are paid on the last working day of each month by bank transfer.",
    "ملازمین کو ہر سال بیس دن کی سالانہ چھٹی ملتی ہے۔",  # Urdu: twenty days of annual leave
]
QUERIES = {
    "how many vacation days do I get?": 0,
    "when will my travel costs be paid back": 1,
    "do I need 2FA to log in from home": 2,
    "payday": 3,
}


def test_vectors_are_unit_length_and_768_dimensional() -> None:
    vectors, tokens = embedder().embed(PASSAGES, "document")
    assert vectors.shape == (5, 768)
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-4)
    assert tokens > 50


def test_retrieval_finds_the_right_passage_for_paraphrased_questions() -> None:
    documents, _ = embedder().embed(PASSAGES[:4], "document")
    queries, _ = embedder().embed(list(QUERIES), "query")
    best = (queries @ documents.T).argmax(axis=1)
    assert list(best) == list(QUERIES.values())


def test_cross_lingual_retrieval_urdu_passage_for_english_question() -> None:
    documents, _ = embedder().embed(PASSAGES, "document")
    [query], _ = embedder().embed(["how many days of annual leave do employees get?"], "query")
    scores = documents @ query
    # Both the English and the Urdu leave passages outrank everything else.
    assert set(np.argsort(-scores)[:2]) == {0, 4}


def test_query_and_document_prompts_differ() -> None:
    [q], _ = embedder().embed(["annual leave"], "query")
    [d], _ = embedder().embed(["annual leave"], "document")
    assert float(q @ d) < 0.999


def test_batching_preserves_input_order() -> None:
    texts = [("word " * random.Random(i).randint(1, 400)).strip() + f" #{i}" for i in range(40)]
    together, _ = embedder().embed(texts, "document")
    for i in (0, 17, 39):
        [alone], _ = embedder().embed([texts[i]], "document")
        assert float(together[i] @ alone) > 0.999


def test_over_long_input_is_truncated_not_failed() -> None:
    vectors, tokens = embedder().embed(["leave policy " * 3000], "document")
    assert vectors.shape == (1, 768)
    assert tokens <= EMBEDDING_MODELS["embeddinggemma-300m-int8"].max_tokens


def test_matryoshka_truncation() -> None:
    spec = EMBEDDING_MODELS["embeddinggemma-300m-int8"]
    small = EmbeddingModel(spec, model_dir(spec.source), threads=None, dimensions=256)
    vectors, _ = small.embed(PASSAGES[:2], "document")
    assert vectors.shape == (2, 256)
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-4)


def test_reranker_puts_the_answer_first() -> None:
    scores = reranker().score("how many days of annual leave do employees get?", PASSAGES[:4])
    assert int(np.argmax(scores)) == 0
    assert ((scores >= 0) & (scores <= 1)).all()


def test_ner_finds_names_with_code_point_offsets() -> None:
    text = "🎉 Welcome Ayesha Raza! Bilal Qureshi from Lahore will mentor her at Meezan Bank."
    [spans] = ner().analyse([text])
    found = {(s.entity_type, text[s.start : s.end]) for s in spans}
    assert ("PERSON", "Ayesha Raza") in found
    assert ("PERSON", "Bilal Qureshi") in found
    assert ("LOCATION", "Lahore") in found
    assert ("ORGANIZATION", "Meezan Bank") in found


def test_ner_handles_texts_longer_than_its_window() -> None:
    filler = "The quarterly report covers routine operational matters in detail. " * 120  # ~1,400 tokens
    text = filler + "It was approved by Imran Siddiqui on Friday."
    [spans] = ner().analyse([text])
    assert any(text[s.start : s.end] == "Imran Siddiqui" for s in spans)


def test_ner_batches_many_texts() -> None:
    texts = [f"Report {i} was filed by Sana Malik." for i in range(50)] + [""]
    results = ner().analyse(texts)
    assert len(results) == 51 and results[-1] == []
    assert all(any(t[s.start : s.end] == "Sana Malik" for s in r) for t, r in zip(texts[:50], results[:50]))
