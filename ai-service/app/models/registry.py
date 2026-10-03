"""Every model the service can run, pinned to an exact Hugging Face commit.

A label (the left-hand key) is what the backend's `EMBEDDING_MODEL` names and
what is stored on every vector. One label means one embedding space: the
int8 and fp32 builds of a model are separate labels, so they are never mixed
in one index.

Models run on ONNX Runtime directly (no PyTorch): int8-quantised builds by
default, which are 2-4x faster on CPU at a retrieval-quality cost well under
one percent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Pooling = Literal["sentence_embedding", "mean", "cls"]


@dataclass(frozen=True, slots=True)
class OnnxSource:
    repo: str
    revision: str
    onnx_file: str
    data_file: str | None = None  # external weights, for models over 2 GB of protobuf
    extra_files: tuple[str, ...] = ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json")

    @property
    def files(self) -> list[str]:
        return [self.onnx_file, *([self.data_file] if self.data_file else []), *self.extra_files]


@dataclass(frozen=True, slots=True)
class EmbeddingSpec:
    label: str
    source: OnnxSource
    dimensions: int
    max_tokens: int
    pooling: Pooling
    query_prompt: str
    document_prompt: str
    # Dimensions the model was trained to be truncated to (Matryoshka).
    matryoshka: tuple[int, ...] = field(default_factory=tuple)
    languages: str = "en"
    license: str = ""


@dataclass(frozen=True, slots=True)
class RerankSpec:
    label: str
    source: OnnxSource
    max_tokens: int
    license: str = ""
    # English-only cross-encoders score other scripts as noise and would undo
    # the multilingual embedding's correct order; the service then declines.
    multilingual: bool = False


@dataclass(frozen=True, slots=True)
class NerSpec:
    label: str
    source: OnnxSource
    max_tokens: int
    # Model label → Presidio entity type.
    entity_map: dict[str, str]
    license: str = ""


_GEMMA_REPO = "onnx-community/embeddinggemma-300m-ONNX"
_GEMMA_REV = "5090578d9565bb06545b4552f76e6bc2c93e4a66"

EMBEDDING_MODELS: dict[str, EmbeddingSpec] = {
    # Google EmbeddingGemma 300M (2025): the strongest open embedding model
    # under 500M parameters on MTEB (multilingual and English), 100+ languages
    # including Urdu, 2048-token context, Matryoshka 768/512/256/128.
    "embeddinggemma-300m-int8": EmbeddingSpec(
        label="embeddinggemma-300m-int8",
        source=OnnxSource(
            _GEMMA_REPO, _GEMMA_REV, "onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"
        ),
        dimensions=768,
        max_tokens=2048,
        pooling="sentence_embedding",
        query_prompt="task: search result | query: ",
        document_prompt="title: none | text: ",
        matryoshka=(768, 512, 256, 128),
        languages="multilingual (100+)",
        license="Gemma Terms of Use",
    ),
    "embeddinggemma-300m": EmbeddingSpec(
        label="embeddinggemma-300m",
        source=OnnxSource(_GEMMA_REPO, _GEMMA_REV, "onnx/model.onnx", "onnx/model.onnx_data"),
        dimensions=768,
        max_tokens=2048,
        pooling="sentence_embedding",
        query_prompt="task: search result | query: ",
        document_prompt="title: none | text: ",
        matryoshka=(768, 512, 256, 128),
        languages="multilingual (100+)",
        license="Gemma Terms of Use",
    ),
    # 4-bit weights (MatMulNBits): a third of the int8 size.
    "embeddinggemma-300m-q4": EmbeddingSpec(
        label="embeddinggemma-300m-q4",
        source=OnnxSource(_GEMMA_REPO, _GEMMA_REV, "onnx/model_q4.onnx", "onnx/model_q4.onnx_data"),
        dimensions=768,
        max_tokens=2048,
        pooling="sentence_embedding",
        query_prompt="task: search result | query: ",
        document_prompt="title: none | text: ",
        matryoshka=(768, 512, 256, 128),
        languages="multilingual (100+)",
        license="Gemma Terms of Use",
    ),
    # Microsoft multilingual-e5-small: ~100 languages including Urdu, a fifth
    # of EmbeddingGemma's compute per token. The fast multilingual choice.
    "multilingual-e5-small": EmbeddingSpec(
        label="multilingual-e5-small",
        source=OnnxSource(
            "Xenova/multilingual-e5-small", "761b726dd34fb83930e26aab4e9ac3899aa1fa78", "onnx/model_quantized.onnx"
        ),
        dimensions=384,
        max_tokens=512,
        pooling="mean",
        query_prompt="query: ",
        document_prompt="passage: ",
        languages="multilingual (~100)",
        license="MIT",
    ),
    # The backend's historical default label. English, 8192-token context.
    "nomic-embed-text": EmbeddingSpec(
        label="nomic-embed-text",
        source=OnnxSource(
            "nomic-ai/nomic-embed-text-v1.5",
            "e9b6763023c676ca8431644204f50c2b100d9aab",
            "onnx/model_quantized.onnx",
        ),
        dimensions=768,
        max_tokens=8192,
        pooling="mean",
        query_prompt="search_query: ",
        document_prompt="search_document: ",
        matryoshka=(768, 512, 256, 128, 64),
        languages="en",
        license="Apache-2.0",
    ),
    # Small and fast, for 512 MB hosts.
    "bge-small-en-v1.5": EmbeddingSpec(
        label="bge-small-en-v1.5",
        source=OnnxSource(
            "Xenova/bge-small-en-v1.5", "ea104dacec62c0de699686887e3f920caeb4f3e3", "onnx/model_quantized.onnx"
        ),
        dimensions=384,
        max_tokens=512,
        pooling="cls",
        query_prompt="Represent this sentence for searching relevant passages: ",
        document_prompt="",
        languages="en",
        license="MIT",
    ),
}

RERANK_MODELS: dict[str, RerankSpec] = {
    # BAAI bge-reranker-base: the strongest of these, MIT, but ~10x the CPU of
    # the turbo model (15 s for 32 passages on a 4-core laptop). For GPU hosts.
    "bge-reranker-base": RerankSpec(
        label="bge-reranker-base",
        source=OnnxSource(
            "Xenova/bge-reranker-base", "280bcc27a84e0b898c251e06fddb25171bd9b101", "onnx/model_quantized.onnx"
        ),
        max_tokens=512,
        license="MIT",
    ),
    # Jina reranker v1 turbo: 38 MB int8, 8K context, Apache-2.0. For small hosts.
    "jina-reranker-v1-turbo-en": RerankSpec(
        label="jina-reranker-v1-turbo-en",
        source=OnnxSource(
            "jinaai/jina-reranker-v1-turbo-en",
            "b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2",
            "onnx/model_quantized.onnx",
        ),
        max_tokens=1024,
        license="Apache-2.0",
    ),
    "ms-marco-MiniLM-L-6-v2": RerankSpec(
        label="ms-marco-MiniLM-L-6-v2",
        source=OnnxSource(
            "Xenova/ms-marco-MiniLM-L-6-v2",
            "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
            "onnx/model_quantized.onnx",
        ),
        max_tokens=512,
        license="Apache-2.0",
    ),
}

NER_MODELS: dict[str, NerSpec] = {
    # BERT-base fine-tuned on CoNLL-2003 (PER/ORG/LOC/MISC), F1 ≈ 91: a
    # transformer that catches names a statistical pipeline misses. Runs
    # beside spaCy; Presidio merges the two.
    "bert-base-NER": NerSpec(
        label="bert-base-NER",
        source=OnnxSource(
            "Xenova/bert-base-NER", "8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa", "onnx/model_quantized.onnx"
        ),
        max_tokens=512,
        entity_map={"PER": "PERSON", "ORG": "ORGANIZATION", "LOC": "LOCATION"},
        license="MIT",
    ),
    # DistilBERT (6 layers) fine-tuned on CoNLL-2003: about half the compute
    # of bert-base-NER for a similar F1. The fast choice for CPU hosts.
    "distilbert-NER": NerSpec(
        label="distilbert-NER",
        source=OnnxSource(
            "onnx-community/distilbert-NER-ONNX",
            "3a19fe9404a4469d91aa3d551558a97f68872f67",
            "onnx/model_quantized.onnx",
        ),
        max_tokens=512,
        entity_map={"PER": "PERSON", "ORG": "ORGANIZATION", "LOC": "LOCATION"},
        license="Apache-2.0",
    ),
}

@dataclass(frozen=True, slots=True)
class SpacySpec:
    name: str
    version: str
    sha256: str | None  # None: not pinned (the version is still checked)

    @property
    def url(self) -> str:
        return (
            "https://github.com/explosion/spacy-models/releases/download/"
            f"{self.name}-{self.version}/{self.name}-{self.version}-py3-none-any.whl"
        )

    @property
    def filename(self) -> str:
        return f"{self.name}-{self.version}-py3-none-any.whl"


# spaCy 3.8 pipelines (the Hugging Face mirrors still carry 3.7, which spaCy
# 3.8 refuses). NER accuracy is within a point across sm/md/lg; md is the
# default: 33 MB instead of lg's 400, at no measurable cost in names found.
SPACY_MODELS: dict[str, SpacySpec] = {
    "en_core_web_sm": SpacySpec("en_core_web_sm", "3.8.0", "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"),
    "en_core_web_md": SpacySpec("en_core_web_md", "3.8.0", "5e6329fe3fecedb1d1a02c3ea2172ee0fede6cea6e4aefb6a02d832dba78a310"),
    "en_core_web_lg": SpacySpec("en_core_web_lg", "3.8.0", None),
}
