"""Speed and agreement of embedding builds on this machine.

    python scripts/compare_embeddings.py embeddinggemma-300m-int8 embeddinggemma-300m-q4 ...

Speed: chunks of ~470 tokens (CHUNK_SIZE_DEFAULT 512), batch of 8, median of 3.
Agreement: mean cosine between each model's vectors and the first model's, on
the same 40 texts (only meaningful between builds of one model).
Retrieval: top-1 accuracy on a small paraphrase set (English and Urdu).
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.models.onnx import EmbeddingModel, resolve_model_dir  # noqa: E402
from app.models.registry import EMBEDDING_MODELS  # noqa: E402

PARAGRAPH = (
    "Employees are entitled to twenty days of annual leave per calendar year, accrued monthly. Unused leave of up "
    "to ten days may be carried forward with the approval of the line manager. "
)
CORPUS = [
    ("Employees are entitled to twenty days of annual leave per calendar year.", "how many vacation days do I get?"),
    ("Travel expenses are reimbursed within thirty days of submitting receipts.", "when will my travel costs be paid back"),
    ("Remote logins to the office network require multi-factor authentication.", "do I need 2FA to log in from home"),
    ("Salaries are paid on the last working day of each month by bank transfer.", "payday"),
    ("Sick leave longer than three days requires a medical certificate.", "do I need a doctor's note if I am ill"),
    ("The cafeteria is open from 8 am to 4 pm on weekdays.", "what time can I get lunch"),
    ("Laptops must be returned to IT on the employee's last day.", "what happens to my computer when I leave the company"),
    ("Overtime is paid at one and a half times the hourly rate.", "extra pay for working late"),
    ("ملازمین کو ہر سال بیس دن کی سالانہ چھٹی ملتی ہے۔", "سالانہ چھٹیاں کتنی ہیں؟"),
    ("دفتر صبح نو بجے کھلتا ہے۔", "دفتر کب کھلتا ہے"),
]


def main(labels: list[str]) -> None:
    texts = [f"{i}. " + PARAGRAPH * 5 for i in range(8)]
    sample = [f"{i} {PARAGRAPH * (1 + i % 4)}" for i in range(40)]
    reference: np.ndarray | None = None
    for label in labels:
        spec = EMBEDDING_MODELS[label]
        try:
            directory = resolve_model_dir(spec.source, ROOT / ".models", allow_download=False)
        except Exception:  # noqa: BLE001
            print(f"{label}: not downloaded")
            continue
        model = EmbeddingModel(spec, directory, threads=None)
        _, tokens = model.embed(texts[:1], "document")
        times = []
        for _ in range(3):
            started = time.perf_counter()
            model.embed(texts, "document")
            times.append(time.perf_counter() - started)
        median = statistics.median(times)
        vectors, _ = model.embed(sample, "document")
        agreement = ""
        if reference is not None and reference.shape == vectors.shape:
            agreement = f" agreement-with-first={float(np.mean(np.sum(reference * vectors, axis=1))):.4f}"
        if reference is None:
            reference = vectors
        docs, _ = model.embed([d for d, _ in CORPUS], "document")
        queries, _ = model.embed([q for _, q in CORPUS], "query")
        top1 = float(np.mean((queries @ docs.T).argmax(axis=1) == np.arange(len(CORPUS))))
        print(
            f"{label:28s} {8 * tokens / median:7.0f} tokens/s  ({8 / median:5.2f} chunks/s of {tokens} tokens)"
            f"  top1={top1:.2f}{agreement}"
        )


if __name__ == "__main__":
    main(sys.argv[1:] or list(EMBEDDING_MODELS))
