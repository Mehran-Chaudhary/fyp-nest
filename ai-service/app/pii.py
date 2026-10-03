"""Named-entity detection for the backend's PII engine (contract §/v1/pii/analyze).

Two detectors, and the union of what they find:

- **Presidio** with a spaCy pipeline: names, places, organisations, groups
  and dates from spaCy's NER, plus Presidio's validated pattern recognizers
  for the identifier types the backend may ask for (medical licences,
  passports, driving licences, NHS numbers, ...), with context-word scoring.
- **A transformer NER model** (BERT fine-tuned on CoNLL-2003) for PERSON,
  LOCATION and ORGANIZATION. It catches names the statistical pipeline misses.
  For privacy a missed name is a leak and an extra mask is a nuisance, so the
  two are combined by union.

Overlaps of the same type are merged here; overlaps of different types are
returned as they are, because the backend resolves them by masking their
union (spans.ts, `mergeOverlapping`).

Offsets are Python string indices (code points), end-exclusive, as the
contract requires. Texts arrive already canonicalised by the backend and are
not normalised again here. They are never logged.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from importlib.metadata import version
from typing import Sequence

from . import errors
from .models.onnx import NerModel

log = logging.getLogger("daiap.pii")

PRESIDIO_VERSION = version("presidio-analyzer")
SUPPORTED_LANGUAGES = ("en",)

# spaCy labels → Presidio entity types.
_ENTITY_MAPPING = {
    "PERSON": "PERSON",
    "PER": "PERSON",
    "NORP": "NRP",
    "FAC": "LOCATION",
    "LOC": "LOCATION",
    "GPE": "LOCATION",
    "LOCATION": "LOCATION",
    "ORG": "ORGANIZATION",
    "ORGANIZATION": "ORGANIZATION",
    "DATE": "DATE_TIME",
    "TIME": "DATE_TIME",
}


@dataclass(slots=True)
class Span:
    entity_type: str
    start: int
    end: int
    score: float


class PiiEngine:
    def __init__(self, spacy_model: str, ner: NerModel | None) -> None:
        from presidio_analyzer import AnalyzerEngine, BatchAnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        provider = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": spacy_model}],
                "ner_model_configuration": {
                    "model_to_presidio_entity_mapping": _ENTITY_MAPPING,
                    # Organisation tags from spaCy are noisy; Presidio's default
                    # is to trust them less, which we keep.
                    "low_confidence_score_multiplier": 0.4,
                    "low_score_entity_names": ["ORG", "ORGANIZATION"],
                    "labels_to_ignore": [
                        "CARDINAL", "EVENT", "LANGUAGE", "LAW", "MONEY", "ORDINAL",
                        "PERCENT", "PRODUCT", "QUANTITY", "WORK_OF_ART",
                    ],
                },
            }
        )
        self._analyzer = AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])
        self._batch = BatchAnalyzerEngine(analyzer_engine=self._analyzer)
        self._presidio_entities = set(self._analyzer.get_supported_entities(language="en"))
        self._ner = ner
        self._ner_entities = set(ner.spec.entity_map.values()) if ner else set()
        model = spacy_model + (f"+{ner.spec.label}" if ner else "")
        self.detector = {"name": "presidio", "version": PRESIDIO_VERSION, "model": model[:64]}

    @property
    def detector_label(self) -> str:
        return f"{self.detector['name']}@{self.detector['version']}/{self.detector['model']}"

    @property
    def supported_entities(self) -> list[str]:
        return sorted(self._presidio_entities | self._ner_entities)

    def analyse(
        self, texts: Sequence[str], entities: Sequence[str], language: str, threshold: float
    ) -> list[list[Span]]:
        if language not in SUPPORTED_LANGUAGES:
            raise errors.ServiceError(
                422,
                "UNSUPPORTED_LANGUAGE",
                f"Name detection supports {', '.join(SUPPORTED_LANGUAGES)}; '{language}' is not available.",
            )
        wanted = set(entities)
        presidio_entities = sorted(wanted & self._presidio_entities)
        ner_entities = wanted & self._ner_entities

        results: list[list[Span]] = [[] for _ in texts]
        indices = [i for i, text in enumerate(texts) if text.strip()]
        subset = [texts[i] for i in indices]
        if not subset or not (presidio_entities or ner_entities):
            return results

        if presidio_entities:
            found = self._batch.analyze_iterator(
                texts=subset,
                language=language,
                entities=presidio_entities,
                score_threshold=threshold,
                batch_size=16,
                n_process=1,
            )
            for index, recognised in zip(indices, found):
                results[index].extend(Span(r.entity_type, r.start, r.end, float(r.score)) for r in recognised)

        if self._ner is not None and ner_entities:
            for index, spans in zip(indices, self._ner.analyse(subset)):
                results[index].extend(
                    Span(s.entity_type, s.start, s.end, s.score)
                    for s in spans
                    if s.entity_type in ner_entities and s.score >= threshold
                )

        cleaned = [[c for c in (_clean(span, texts[i]) for span in spans) if c] for i, spans in enumerate(results)]
        return [_merge_same_type(spans, len(texts[i])) for i, spans in enumerate(cleaned)]


# Form labels, acronyms and greetings that NER models mistake for names in
# HR and support text ("Email: ...", "CNIC: ...", "Dear Team").
_NOT_NAMES = frozenset(
    """email e-mail mail cnic nic ntn id phone mobile cell tel telephone fax name address subject re fw fwd
    dear regards thanks thank hi hello team sir madam iban swift pkr usd hr it ceo cfo cto coo vp ssn dob
    vpn api aws sql pdf url ip password username user admin salary ticket invoice order account customer
    client employee department date note notes""".split()
)
_EDGE = frozenset(" \t\n.,;:!?()[]{}\"'`*_|-–—")


def _clean(span: Span, text: str) -> Span | None:
    """Trims punctuation from a span's edges; drops PERSON spans that cannot be names."""
    start, end = span.start, span.end
    while start < end and text[start] in _EDGE:
        start += 1
    while end > start and text[end - 1] in _EDGE:
        end -= 1
    if start >= end:
        return None
    value = text[start:end]
    if span.entity_type == "PERSON":
        # Hashes, invoice numbers, ids and passwords carry digits; names do not.
        if any(c.isdigit() for c in value) or not any(c.isalpha() for c in value):
            return None
        if value.lower() in _NOT_NAMES:
            return None
    return Span(span.entity_type, start, end, span.score)


def _merge_same_type(spans: list[Span], length: int) -> list[Span]:
    """Unions overlapping spans of one type; keeps the best score. Drops bad offsets."""
    valid = [s for s in spans if 0 <= s.start < s.end <= length]
    valid.sort(key=lambda s: (s.entity_type, s.start, -s.end))
    merged: list[Span] = []
    for span in valid:
        last = merged[-1] if merged else None
        if last and last.entity_type == span.entity_type and span.start < last.end:
            last.end = max(last.end, span.end)
            last.score = max(last.score, span.score)
        else:
            merged.append(Span(span.entity_type, span.start, span.end, span.score))
    for span in merged:
        span.score = round(min(max(span.score, 0.0), 1.0), 3)
    merged.sort(key=lambda s: (s.start, s.end))
    return merged
