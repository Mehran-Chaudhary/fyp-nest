"""Latency of each model on this machine, at the backend's real request sizes.

    python scripts/benchmark.py

Embedding: one ingestion batch (32 chunks of ~500 tokens, EMBEDDING_BATCH_SIZE)
and one query. Rerank: 32 candidates of ~500 tokens (RAG_DEFAULT_TOP_K x
RAG_CANDIDATE_MULTIPLIER). PII: one conversation turn's worth of text.
"""

from __future__ import annotations

import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AI_SERVICE_SIGNING_SECRET", "x" * 32)

import psutil  # noqa: E402

from app.models.onnx import EmbeddingModel, NerModel, RerankModel, resolve_model_dir  # noqa: E402
from app.models.registry import EMBEDDING_MODELS, NER_MODELS, RERANK_MODELS  # noqa: E402

CACHE = ROOT / ".models"
PARAGRAPH = (
    "Employees are entitled to twenty days of annual leave per calendar year, accrued monthly. Unused leave of up "
    "to ten days may be carried forward with the approval of the line manager. Requests must be submitted through "
    "the HR portal at least two weeks in advance, except in emergencies. Sick leave requires a medical certificate "
    "after three consecutive days. "
)


def timed(function, repeat: int = 3) -> tuple[float, float]:  # type: ignore[no-untyped-def]
    function()  # warm-up
    samples = []
    for _ in range(repeat):
        started = time.perf_counter()
        function()
        samples.append(time.perf_counter() - started)
    return statistics.median(samples), min(samples)


def main() -> None:
    process = psutil.Process()
    print(f"CPU: {os.cpu_count()} logical cores")
    base = process.memory_info().rss

    embedding_label = sys.argv[1] if len(sys.argv) > 1 else "embeddinggemma-300m-int8"
    spec = EMBEDDING_MODELS[embedding_label]
    started = time.perf_counter()
    embedder = EmbeddingModel(spec, resolve_model_dir(spec.source, CACHE, allow_download=False), threads=None)
    load = time.perf_counter() - started
    chunk = PARAGRAPH * 7
    _, tokens = embedder.embed([chunk], "document")
    batch = [f"{i}. {chunk}" for i in range(32)]
    median, best = timed(lambda: embedder.embed(batch, "document"))
    query, _ = timed(lambda: embedder.embed(["how many days of annual leave can I carry forward?"], "query"), 10)
    print(
        f"embedding {spec.label}: load {load:.1f}s | 32 x {tokens} tokens: median {median:.2f}s "
        f"({32 / median:.1f} chunks/s) | query {query * 1000:.0f} ms"
    )

    for label in RERANK_MODELS:
        rspec = RERANK_MODELS[label]
        try:
            directory = resolve_model_dir(rspec.source, CACHE, allow_download=False)
        except Exception:  # noqa: BLE001 - not downloaded
            continue
        reranker = RerankModel(rspec, directory, threads=None)
        median, _ = timed(lambda: reranker.score("how many days of annual leave can I carry forward?", batch))
        print(f"rerank {label}: 32 candidates: median {median:.2f}s")

    nspec = NER_MODELS["bert-base-NER"]
    ner = NerModel(nspec, resolve_model_dir(nspec.source, CACHE, allow_download=False), threads=None)
    turn = [PARAGRAPH * 3 + " Ayesha Raza approved it."] * 8  # ~8 retrieved passages + the question
    median, _ = timed(lambda: ner.analyse(turn))
    print(f"ner {nspec.label}: 8 texts x ~{len(turn[0])} chars: median {median * 1000:.0f} ms")

    print(f"resident memory for all models: +{(process.memory_info().rss - base) / 2**20:.0f} MB")


if __name__ == "__main__":
    main()
