"""Fetches model files ahead of time: `python -m app.models.download`.

Run in the Docker build so a container starts from local files and never
downloads at runtime (fast cold starts, no dependency on the Hub being up).
Downloads only the exact files each model needs, at the pinned revision; the
spaCy pipeline wheel is checked against its pinned SHA-256.

    python -m app.models.download                      # the configured models
    python -m app.models.download --embedding nomic-embed-text --rerank none
    python -m app.models.download --spacy-wheel-dir wheels   # then: pip install wheels/*.whl
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
import urllib.request
from pathlib import Path

from .registry import EMBEDDING_MODELS, NER_MODELS, RERANK_MODELS, SPACY_MODELS, OnnxSource, SpacySpec

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


def fetch(source: OnnxSource, cache_dir: Path) -> Path:
    from huggingface_hub import snapshot_download

    started = time.monotonic()
    path = snapshot_download(
        repo_id=source.repo,
        revision=source.revision,
        allow_patterns=source.files,
        cache_dir=str(cache_dir),
    )
    print(f"  {source.repo}@{source.revision[:8]} ({time.monotonic() - started:.0f}s)", flush=True)
    return Path(path)


def fetch_spacy_wheel(spec: SpacySpec, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / spec.filename
    if not target.exists() or not _matches(target, spec):
        print(f"  downloading {spec.url}", flush=True)
        partial = target.with_suffix(".part")
        with urllib.request.urlopen(spec.url, timeout=60) as response, partial.open("wb") as out:  # noqa: S310
            while chunk := response.read(1 << 20):
                out.write(chunk)
        partial.replace(target)
    if not _matches(target, spec):
        target.unlink(missing_ok=True)
        raise SystemExit(f"{spec.filename}: SHA-256 does not match the pinned value; refusing to use it")
    print(f"  {target} ({'sha256 verified' if spec.sha256 else 'unpinned'})", flush=True)
    return target


def _matches(path: Path, spec: SpacySpec) -> bool:
    if spec.sha256 is None:
        return True
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest() == spec.sha256


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--embedding", default=os.environ.get("EMBEDDING_MODEL", "embeddinggemma-300m-int8"))
    parser.add_argument("--rerank", default=os.environ.get("RERANK_MODEL", "jina-reranker-v1-turbo-en"))
    parser.add_argument("--ner", default=os.environ.get("PII_TRANSFORMER_MODEL", "bert-base-NER"))
    parser.add_argument("--spacy", default=os.environ.get("PII_SPACY_MODEL", "en_core_web_md"))
    parser.add_argument("--spacy-wheel-dir", default="", help="download the spaCy pipeline wheel here")
    parser.add_argument("--cache-dir", default=os.environ.get("MODEL_CACHE_DIR", ".models"))
    args = parser.parse_args(argv)

    cache = Path(args.cache_dir).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    print(f"Model cache: {cache}", flush=True)

    def chosen(value: str) -> bool:
        return value.strip().lower() not in ("", "none", "off", "false")

    jobs: list[tuple[str, OnnxSource]] = []
    for kind, value, registry in (
        ("embedding", args.embedding, EMBEDDING_MODELS),
        ("rerank", args.rerank, RERANK_MODELS),
        ("ner", args.ner, NER_MODELS),
    ):
        if kind != "embedding" and not chosen(value):
            continue
        if value not in registry:
            print(f"Unknown {kind} model {value!r}; choose from {', '.join(registry)}")
            return 2
        jobs.append((kind, registry[value].source))  # type: ignore[attr-defined]

    for kind, source in jobs:
        print(f"Fetching {kind} model:", flush=True)
        fetch(source, cache)

    if chosen(args.spacy) and args.spacy_wheel_dir:
        if args.spacy not in SPACY_MODELS:
            print(f"Unknown spaCy model {args.spacy!r}; choose from {', '.join(SPACY_MODELS)}")
            return 2
        print("Fetching spaCy pipeline wheel:", flush=True)
        fetch_spacy_wheel(SPACY_MODELS[args.spacy], Path(args.spacy_wheel_dir))
    print("Done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
