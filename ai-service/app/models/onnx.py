"""Thin, fast ONNX Runtime wrappers for the three kinds of model the service runs.

Shared techniques:

- **Length-sorted, token-budgeted batches.** Inputs are sorted by token count
  and grouped so that (rows × padded length) stays under a budget. Padding a
  20-token query to a 2,000-token neighbour wastes 99% of the work; sorting
  removes almost all of it and bounds peak memory.
- **No busy-waiting.** ONNX Runtime threads spin between calls by default,
  which burns CPU on an idle service (and money, on per-CPU-second hosts).
- **Exact offsets.** Hugging Face tokenizers report character offsets into the
  original Python string, i.e. code points, which is what the contract wants
  for PII spans.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Encoding, Tokenizer

from .registry import EmbeddingSpec, NerSpec, OnnxSource, RerankSpec

log = logging.getLogger("daiap.models")

# rows × padded tokens per ONNX call. ~16k keeps a base-size model under
# ~1 GB of activations and each call well under a second on two cores.
DEFAULT_BATCH_TOKENS = 16_384


def resolve_model_dir(source: OnnxSource, cache_dir: Path, *, allow_download: bool) -> Path:
    """The local snapshot of a pinned model, downloading it if allowed."""
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        repo_id=source.repo,
        revision=source.revision,
        allow_patterns=source.files,
        cache_dir=str(cache_dir),
        local_files_only=not allow_download,
    )
    return Path(path)


def make_session(model_path: Path, threads: int | None) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = threads or 0
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])


def load_tokenizer(model_dir: Path, max_tokens: int, *, pair_truncation: str = "longest_first") -> tuple[Tokenizer, int]:
    tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    tokenizer.no_padding()
    tokenizer.enable_truncation(max_length=max_tokens, strategy=pair_truncation)
    return tokenizer, _pad_id(tokenizer, model_dir)


def _pad_id(tokenizer: Tokenizer, model_dir: Path) -> int:
    candidates: list[str] = []
    for name in ("tokenizer_config.json", "special_tokens_map.json"):
        path = model_dir / name
        if path.exists():
            pad = json.loads(path.read_text(encoding="utf-8")).get("pad_token")
            if isinstance(pad, dict):
                pad = pad.get("content")
            if isinstance(pad, str):
                candidates.append(pad)
    for token in [*candidates, "<pad>", "[PAD]"]:
        token_id = tokenizer.token_to_id(token)
        if token_id is not None:
            return token_id
    return 0


@dataclass(slots=True)
class _Batch:
    rows: list[int]  # positions in the caller's input order
    encodings: list[Encoding]


def _batches(encodings: Sequence[Encoding], budget: int) -> list[_Batch]:
    order = sorted(range(len(encodings)), key=lambda i: len(encodings[i].ids))
    batches: list[_Batch] = []
    current: list[int] = []
    for index in order:
        longest = len(encodings[index].ids)  # ascending, so the newcomer is the longest
        if current and longest * (len(current) + 1) > budget:
            batches.append(_Batch(current, [encodings[i] for i in current]))
            current = []
        current.append(index)
    if current:
        batches.append(_Batch(current, [encodings[i] for i in current]))
    return batches


def _feeds(session_inputs: set[str], encodings: Sequence[Encoding], pad_id: int) -> dict[str, np.ndarray]:
    width = max(len(e.ids) for e in encodings)
    ids = np.full((len(encodings), width), pad_id, dtype=np.int64)
    mask = np.zeros((len(encodings), width), dtype=np.int64)
    types = np.zeros((len(encodings), width), dtype=np.int64)
    for row, encoding in enumerate(encodings):
        length = len(encoding.ids)
        ids[row, :length] = encoding.ids
        mask[row, :length] = 1
        types[row, :length] = encoding.type_ids
    feeds = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in session_inputs:
        feeds["token_type_ids"] = types
    return feeds


def _normalise(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, 1e-12)


# ── Embeddings ───────────────────────────────────────────────────────────────


class EmbeddingModel:
    def __init__(
        self,
        spec: EmbeddingSpec,
        model_dir: Path,
        *,
        threads: int | None,
        dimensions: int = 0,
        batch_tokens: int = DEFAULT_BATCH_TOKENS,
    ) -> None:
        if dimensions and dimensions != spec.dimensions and dimensions not in spec.matryoshka:
            raise ValueError(
                f"{spec.label} produces {spec.dimensions} dimensions"
                + (f" (or {', '.join(map(str, spec.matryoshka))} truncated)" if spec.matryoshka else "")
                + f"; {dimensions} is not supported"
            )
        self.spec = spec
        self.dimensions = dimensions or spec.dimensions
        self.session = make_session(model_dir / spec.source.onnx_file, threads)
        self.tokenizer, self.pad_id = load_tokenizer(model_dir, spec.max_tokens)
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.output_names = [o.name for o in self.session.get_outputs()]
        self.batch_tokens = batch_tokens
        # A separate, untruncated tokenizer for counting and chunking.
        self.counting_tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.counting_tokenizer.no_padding()
        self.counting_tokenizer.no_truncation()

    def embed(self, texts: Sequence[str], kind: Literal["query", "document"]) -> tuple[np.ndarray, int]:
        """Unit-length vectors, one per text, and the number of tokens processed."""
        prompt = self.spec.query_prompt if kind == "query" else self.spec.document_prompt
        encodings = self.tokenizer.encode_batch([prompt + text for text in texts])
        out = np.zeros((len(texts), self.dimensions), dtype=np.float32)
        for batch in _batches(encodings, self.batch_tokens):
            feeds = _feeds(self.inputs, batch.encodings, self.pad_id)
            vectors = self._pool(self.session.run(None, feeds), feeds["attention_mask"])
            out[batch.rows] = self._shape(vectors)
        return out, sum(len(e.ids) for e in encodings)

    def _pool(self, outputs: list[np.ndarray], mask: np.ndarray) -> np.ndarray:
        if self.spec.pooling == "sentence_embedding":
            return outputs[self.output_names.index("sentence_embedding")]
        hidden = outputs[0]
        if self.spec.pooling == "cls":
            return hidden[:, 0]
        weights = mask[..., None].astype(hidden.dtype)
        return (hidden * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1e-9)

    def _shape(self, vectors: np.ndarray) -> np.ndarray:
        vectors = vectors.astype(np.float32, copy=False)
        if self.dimensions < vectors.shape[1]:
            vectors = vectors[:, : self.dimensions]  # Matryoshka truncation, then re-normalise
        return _normalise(vectors)


# ── Reranking ────────────────────────────────────────────────────────────────


class RerankModel:
    def __init__(
        self, spec: RerankSpec, model_dir: Path, *, threads: int | None, batch_tokens: int = DEFAULT_BATCH_TOKENS
    ) -> None:
        self.spec = spec
        self.session = make_session(model_dir / spec.source.onnx_file, threads)
        # Truncate the passage, never the query.
        self.tokenizer, self.pad_id = load_tokenizer(model_dir, spec.max_tokens, pair_truncation="only_second")
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.batch_tokens = batch_tokens

    def score(self, query: str, documents: Sequence[str]) -> np.ndarray:
        """Relevance in [0, 1] (sigmoid of the cross-encoder logit), one per document."""
        encodings = self.tokenizer.encode_batch([(query, document) for document in documents])
        scores = np.zeros(len(documents), dtype=np.float64)
        for batch in _batches(encodings, self.batch_tokens):
            feeds = _feeds(self.inputs, batch.encodings, self.pad_id)
            logits = self.session.run(None, feeds)[0]
            logits = logits[:, 0] if logits.ndim == 2 else logits
            scores[batch.rows] = 1.0 / (1.0 + np.exp(-logits.astype(np.float64)))
        return scores


# ── Token classification (NER) ───────────────────────────────────────────────


@dataclass(slots=True)
class NerSpan:
    entity_type: str
    start: int
    end: int
    score: float


class NerModel:
    """BIO token classification with word-level aggregation and sliding windows."""

    def __init__(
        self, spec: NerSpec, model_dir: Path, *, threads: int | None, batch_tokens: int = DEFAULT_BATCH_TOKENS
    ) -> None:
        self.spec = spec
        self.session = make_session(model_dir / spec.source.onnx_file, threads)
        config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
        self.labels = {int(k): v for k, v in config["id2label"].items()}
        self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tokenizer.no_padding()
        self.tokenizer.no_truncation()
        self.pad_id = _pad_id(self.tokenizer, model_dir)
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.window = spec.max_tokens - 2  # room for [CLS] and [SEP]
        self.stride = 64
        self.batch_tokens = batch_tokens
        self._cls = self.tokenizer.token_to_id("[CLS]")
        self._sep = self.tokenizer.token_to_id("[SEP]")

    def analyse(self, texts: Sequence[str]) -> list[list[NerSpan]]:
        """Entity spans per text, as code-point offsets into that text."""
        windows: list[tuple[int, int, int, Encoding]] = []  # (text, first token, last token, encoding)
        base = self.tokenizer.encode_batch(list(texts), add_special_tokens=False)
        for index, encoding in enumerate(base):
            count = len(encoding.ids)
            start = 0
            while start < count:
                end = min(start + self.window, count)
                windows.append((index, start, end, encoding))
                if end == count:
                    break
                start = end - self.stride

        # Probabilities per text and token; where windows overlap, the window in
        # which the token sits furthest from an edge wins.
        probabilities = [np.zeros((len(e.ids), len(self.labels)), dtype=np.float32) for e in base]
        centrality = [np.full(len(e.ids), -1.0, dtype=np.float32) for e in base]
        window_encodings = [self._window_encoding(enc, s, e) for _, s, e, enc in windows]
        for batch in _batches(window_encodings, self.batch_tokens):
            feeds = _feeds(self.inputs, batch.encodings, self.pad_id)
            logits = self.session.run(None, feeds)[0]
            for row, position in enumerate(batch.rows):
                text_index, first, last, _ = windows[position]
                length = last - first
                window_logits = logits[row, 1 : 1 + length]  # skip [CLS]
                window_probs = _softmax(window_logits)
                offsets = np.arange(length, dtype=np.float32)
                score = np.minimum(offsets, length - 1 - offsets)
                target = slice(first, last)
                better = score > centrality[text_index][target]
                probabilities[text_index][target][better] = window_probs[better]
                centrality[text_index][target][better] = score[better]

        return [self._spans(text, base[i], probabilities[i]) for i, text in enumerate(texts)]

    def _window_encoding(self, encoding: Encoding, first: int, last: int) -> Encoding:
        ids = [self._cls, *encoding.ids[first:last], self._sep]
        return _SimpleEncoding(ids)  # type: ignore[return-value]

    def _spans(self, text: str, encoding: Encoding, probs: np.ndarray) -> list[NerSpan]:
        """Word-level BIO decoding: each word takes its first sub-token's label
        ("first" aggregation); B- opens an entity, I- of the same type extends it,
        anything else closes it. An entity's score is its words' mean confidence."""
        if len(encoding.ids) == 0:
            return []
        best = probs.argmax(axis=1)
        spans: list[NerSpan] = []
        current: list = []  # [entity, start, end, confidences]
        previous_word: int | None = None

        def close() -> None:
            if current:
                spans.append(NerSpan(current[0], current[1], current[2], round(float(np.mean(current[3])), 4)))
                current.clear()

        for token, word in enumerate(encoding.word_ids):
            start, end = encoding.offsets[token]
            if word is None:
                continue
            if word == previous_word:
                if current:
                    current[2] = end  # a sub-word of the word already in the entity
                continue
            previous_word = word
            label = self.labels[int(best[token])]
            prefix, _, kind = label.partition("-")
            entity = self.spec.entity_map.get(kind) if prefix in ("B", "I") else None
            confidence = float(probs[token, best[token]])
            if entity is None:
                close()
            elif prefix == "I" and current and current[0] == entity:
                current[2] = end
                current[3].append(confidence)
            else:
                close()
                current.extend([entity, start, end, [confidence]])
        close()
        return [span for span in spans if text[span.start : span.end].strip()]


class _SimpleEncoding:
    """The fields `_feeds` reads, for a hand-built window."""

    __slots__ = ("ids", "type_ids")

    def __init__(self, ids: list[int]) -> None:
        self.ids = ids
        self.type_ids = [0] * len(ids)


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)
