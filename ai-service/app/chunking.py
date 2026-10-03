"""Structure-aware, token-exact chunking (contract: chunk_size / chunk_overlap
are in tokens of the embedding model).

Design, in the order decisions are made:

1. **Sections.** Headings open sections; every piece of content knows its
   section path ("Leave policy > Annual leave").
2. **Units.** Each block becomes one unit when it fits a chunk, so paragraphs,
   lists, tables and code fences stay whole. A block that cannot fit is split
   at the most natural seam available: sentences for prose, items for lists,
   row groups (each repeating the header row) for tables, lines for code, and
   word-aligned token windows only as a last resort.
3. **Packing.** Units fill a chunk in order. A chunk closes when the next unit
   would overflow it, or at a section boundary, except that small sibling
   sections under the same parent share a chunk (each keeps its heading
   inline) rather than producing a run of tiny fragments.
4. **Overlap.** When a chunk closes for size inside a section, the next one
   opens with the closing sentences of the last, up to `overlap` tokens,
   never half a word. No overlap is carried across a section boundary.
5. **Context header.** Each chunk starts with its section path, so a chunk
   that reads "Twenty days, accrued monthly" is still found by a search for
   annual leave, by both the dense and the lexical (BM25) index.

Every chunk is verified against the real tokenizer at the end: no chunk
exceeds `chunk_size` tokens.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol, Sequence

from .parsing.blocks import Block, is_list_item

HEADER_SEPARATOR = " > "


class TokenCounter(Protocol):
    def counts(self, texts: Sequence[str]) -> list[int]: ...

    def windows(self, text: str, max_tokens: int) -> list[str]: ...

    def tail(self, text: str, max_tokens: int) -> str: ...


@dataclass(slots=True)
class Chunk:
    text: str
    token_count: int
    page_start: int | None
    page_end: int | None


@dataclass(slots=True)
class _Unit:
    text: str
    tokens: int
    section: tuple[str, ...]
    page_start: int | None
    page_end: int | None
    # How the unit attaches to the one before it inside a chunk.
    joiner: str
    overlap: bool = False


@dataclass
class _Segment:
    section: tuple[str, ...]
    units: list[_Unit] = field(default_factory=list)


# ── Sentences ────────────────────────────────────────────────────────────────

_ABBREVIATIONS = frozenset(
    "mr mrs ms dr prof sr jr st vs etc e.g i.e eg ie no nos fig figs inc ltd co corp dept est "
    "approx govt jan feb mar apr jun jul aug sep sept oct nov dec mt rs pvt al".split()
)
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?۔؟])[\"'”’)\]]*\s+(?=[\"'“‘(\[]?[A-Z0-9؀-ۿ])")


def split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    start = 0
    for match in _SENTENCE_BOUNDARY.finditer(text):
        before = text[start : match.start()].rstrip()
        last_word = before.rsplit(None, 1)[-1].rstrip(".").lower() if before.split() else ""
        # "Dr. Raza", "e.g. leave", and initials ("A. Khan") are not ends.
        if last_word in _ABBREVIATIONS or (len(last_word) == 1 and last_word.isalpha()):
            continue
        sentences.append(text[start : match.start()].strip())
        start = match.end()
    sentences.append(text[start:].strip())
    return [sentence for sentence in sentences if sentence]


# ── The chunker ──────────────────────────────────────────────────────────────


class Chunker:
    def __init__(
        self,
        counter: TokenCounter,
        chunk_size: int,
        overlap: int,
        *,
        context_headers: bool = True,
        max_characters: int = 20_000,
    ) -> None:
        if chunk_size < 16:
            raise ValueError("chunk_size must be at least 16 tokens")
        self.counter = counter
        self.size = chunk_size
        self.overlap = max(0, min(overlap, chunk_size // 2))
        self.context_headers = context_headers
        self.max_characters = max_characters
        self._header_tokens: dict[tuple[str, ...], int] = {}

    # ── public ──────────────────────────────────────────────────────────────

    def chunk(self, blocks: Sequence[Block]) -> list[Chunk]:
        units = self._units(blocks)
        segments_per_chunk = self._pack(units)
        chunks: list[Chunk] = []
        for segments in segments_per_chunk:
            chunks.extend(self._render(segments))
        return chunks

    # ── 1-2: sections and units ─────────────────────────────────────────────

    def _units(self, blocks: Sequence[Block]) -> list[_Unit]:
        stack: list[tuple[int, str]] = []
        pending: list[tuple[Block, tuple[str, ...]]] = []
        headings_only: list[Block] = []

        for block in blocks:
            if block.kind == "heading":
                headings_only.append(block)
                while stack and stack[-1][0] >= block.level:
                    stack.pop()
                stack.append((block.level, block.text))
                if not self.context_headers:
                    pending.append((Block("paragraph", block.text, page=block.page), tuple()))
                continue
            section = tuple(text for _, text in stack) if self.context_headers else tuple()
            pending.append((block, section))

        if not any(block.kind != "heading" for block, _ in pending) and headings_only:
            # A document of nothing but headings: keep them as content.
            pending = [(Block("paragraph", h.text, page=h.page), tuple()) for h in headings_only]

        units: list[_Unit] = []
        for block, section in pending:
            units.extend(self._block_units(block, section))
        return units

    def _budget(self, section: tuple[str, ...]) -> int:
        return self.size - self._header_cost(section)

    def _header_cost(self, section: tuple[str, ...]) -> int:
        if not section:
            return 0
        if section not in self._header_tokens:
            header = self._header_text(section)
            self._header_tokens[section] = self.counter.counts([header + "\n\n"])[0] if header else 0
        return self._header_tokens[section]

    def _header_text(self, section: tuple[str, ...]) -> str:
        """The section path, trimmed from the left to at most a quarter of a chunk."""
        if not section:
            return ""
        parts = list(section)
        limit = max(self.size // 4, 8)
        while parts:
            text = HEADER_SEPARATOR.join(parts)
            if len(parts) == 1 or self.counter.counts([text])[0] <= limit:
                if self.counter.counts([text])[0] > limit:
                    windows = self.counter.windows(text, limit)
                    return windows[0] if windows else ""
                return text
            parts = parts[1:]
        return ""

    def _block_units(self, block: Block, section: tuple[str, ...]) -> list[_Unit]:
        budget = max(self._budget(section), 8)
        first_page, last_page = block.page, block.last_page

        def unit(text: str, tokens: int, joiner: str) -> _Unit:
            return _Unit(text, tokens, section, first_page, last_page, joiner)

        [whole] = self.counter.counts([block.text])
        if whole <= budget:
            return [unit(block.text, whole, "\n\n")]

        if block.kind in ("paragraph", "quote"):
            pieces = self._fit(split_sentences(block.text), budget)
            return [unit(text, tokens, "\n\n" if i == 0 else " ") for i, (text, tokens) in enumerate(pieces)]

        if block.kind == "table":
            return [unit(text, tokens, "\n\n") for text, tokens in self._table_pieces(block.text, budget)]

        # Lists and code: by line (list items keep their continuation lines).
        lines = _list_items(block.text) if block.kind == "list" else block.text.split("\n")
        groups = self._group(lines, budget, "\n")
        return [unit(text, tokens, "\n\n" if i == 0 else "\n") for i, (text, tokens) in enumerate(groups)]

    def _fit(self, pieces: list[str], budget: int) -> list[tuple[str, int]]:
        """Each piece as a unit, with over-long pieces cut into token windows."""
        out: list[tuple[str, int]] = []
        for text, tokens in zip(pieces, self.counter.counts(pieces)):
            if tokens <= budget:
                out.append((text, tokens))
                continue
            windows = self.counter.windows(text, budget)
            out.extend(zip(windows, self.counter.counts(windows)))
        return out

    def _group(self, lines: list[str], budget: int, joiner: str) -> list[tuple[str, int]]:
        """Greedily packs lines into groups that fit the budget."""
        lines = [line for line in lines if line.strip()]
        fitted = self._fit(lines, budget)
        groups: list[tuple[str, int]] = []
        current: list[str] = []
        current_tokens = 0
        for text, tokens in fitted:
            cost = tokens + (1 if current else 0)
            if current and current_tokens + cost > budget:
                groups.append((joiner.join(current), current_tokens))
                current, current_tokens = [], 0
                cost = tokens
            current.append(text)
            current_tokens += cost
        if current:
            groups.append((joiner.join(current), current_tokens))
        # Re-count exactly: joins can tokenize differently from their parts.
        return self._exact(groups, budget, joiner)

    def _exact(self, groups: list[tuple[str, int]], budget: int, joiner: str) -> list[tuple[str, int]]:
        texts = [text for text, _ in groups]
        exact: list[tuple[str, int]] = []
        for text, tokens in zip(texts, self.counter.counts(texts)):
            if tokens <= budget:
                exact.append((text, tokens))
            else:  # rare: split the group in half and retry
                parts = text.split(joiner)
                if len(parts) == 1:
                    windows = self.counter.windows(text, budget)
                    exact.extend(zip(windows, self.counter.counts(windows)))
                else:
                    middle = len(parts) // 2
                    halves = [joiner.join(parts[:middle]), joiner.join(parts[middle:])]
                    exact.extend(self._exact(list(zip(halves, [0, 0])), budget, joiner))
        return exact

    def _table_pieces(self, table: str, budget: int) -> list[tuple[str, int]]:
        rows = table.split("\n")
        header: list[str] = []
        if len(rows) >= 2 and re.fullmatch(r"\|?(\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*\|?", rows[1].strip()):
            header, rows = rows[:2], rows[2:]
        header_text = "\n".join(header)
        header_tokens = self.counter.counts([header_text])[0] + 1 if header else 0
        if header_tokens > budget // 2:  # a monstrous header: give up on repeating it
            header, header_text, header_tokens = [], "", 0
        groups = self._group(rows, budget - header_tokens, "\n")
        pieces = [(header_text + "\n" + text) if header else text for text, _ in groups]
        return self._exact([(piece, 0) for piece in pieces], budget, "\n")

    # ── 3-4: packing with overlap ───────────────────────────────────────────

    def _pack(self, units: list[_Unit]) -> list[list[_Segment]]:
        chunks: list[list[_Segment]] = []
        segments: list[_Segment] = []
        used = 0  # estimated tokens of the content in `segments`, header excluded

        def header_cost() -> int:
            return self._header_cost(_common_prefix([s.section for s in segments]))

        def inline_cost(section: tuple[str, ...], prefix: tuple[str, ...]) -> int:
            rest = section[len(prefix) :]
            return self.counter.counts([HEADER_SEPARATOR.join(rest)])[0] + 1 if rest else 0

        def estimate_with(unit: _Unit) -> int:
            sections = [s.section for s in segments] + [unit.section]
            prefix = _common_prefix(sections)
            inline = sum(inline_cost(section, prefix) for section in dict.fromkeys(sections)) if len(
                set(sections)
            ) > 1 else 0
            joiner = 1 if segments else 0
            return self._header_cost(prefix) + inline + used + joiner + unit.tokens

        def close(carry: bool) -> list[_Unit]:
            nonlocal segments, used
            if not segments:
                return []
            chunks.append(segments)
            tail = self._overlap_units(segments[-1]) if carry and self.overlap else []
            segments, used = [], 0
            return tail

        for unit in units:
            same_section = bool(segments) and segments[-1].section == unit.section
            if segments and not same_section:
                mergeable = (
                    self.context_headers
                    and _common_prefix([segments[0].section, unit.section])
                    and used + header_cost() < self.size // 2
                    and estimate_with(unit) <= self.size
                )
                if not mergeable:
                    close(carry=False)

            if segments and estimate_with(unit) > self.size:
                tail = close(carry=True)
                # Overlap may not crowd out the unit it introduces.
                while tail and self._header_cost(unit.section) + sum(u.tokens + 1 for u in tail) + unit.tokens > self.size:
                    tail = tail[1:]
                if tail:
                    segments = [_Segment(unit.section, list(tail))]
                    used = sum(u.tokens + 1 for u in tail)

            if not segments or segments[-1].section != unit.section:
                segments.append(_Segment(unit.section))
            segments[-1].units.append(unit)
            used += unit.tokens + (1 if used else 0)

        close(carry=False)
        return chunks

    def _overlap_units(self, segment: _Segment) -> list[_Unit]:
        """The closing sentences of a segment, up to `overlap` tokens."""
        budget = self.overlap
        picked: list[_Unit] = []
        for unit in reversed(segment.units):
            if unit.text.lstrip().startswith(("|", "```", "~~~")):
                break  # prose only: repeating table rows or code helps no search
            if unit.tokens + 1 <= budget:
                picked.insert(0, _carry(unit, unit.text, unit.tokens))
                budget -= unit.tokens + 1
                continue
            sentences = split_sentences(unit.text) if "\n" not in unit.text else unit.text.split("\n")
            counts = self.counter.counts(sentences) if sentences else []
            taken: list[str] = []
            taken_tokens = 0
            for sentence, tokens in zip(reversed(sentences), reversed(counts)):
                if taken_tokens + tokens + 1 > budget:
                    break
                taken.insert(0, sentence)
                taken_tokens += tokens + 1
            if taken:
                text = " ".join(taken)
                picked.insert(0, _carry(unit, text, self.counter.counts([text])[0]))
            elif not picked and budget >= 16:
                text = self.counter.tail(unit.text, budget - 1)
                if text:
                    picked.insert(0, _carry(unit, text, self.counter.counts([text])[0]))
            break
        return picked

    # ── 5: rendering and verification ───────────────────────────────────────

    def _render(self, segments: list[_Segment]) -> list[Chunk]:
        prefix = _common_prefix([s.section for s in segments])
        header = self._header_text(prefix) if self.context_headers else ""
        parts: list[str] = []
        units: list[_Unit] = []
        for segment in segments:
            rest = segment.section[len(prefix) :]
            if rest and len(segments) > 1:
                parts.append(("\n\n" if parts else "") + HEADER_SEPARATOR.join(rest))
            for unit in segment.units:
                joiner = unit.joiner if parts else ""
                if unit.overlap and parts:
                    joiner = "\n\n"
                parts.append(joiner + unit.text)
                units.append(unit)
        body = "".join(parts).strip()
        if not body:
            return []
        text = f"{header}\n\n{body}" if header else body
        [tokens] = self.counter.counts([text])

        if tokens > self.size or len(text) > self.max_characters:
            # Estimation drifted (rare): fall back to exact token windows.
            budget = self.size - (self._header_cost(prefix) if header else 0)
            windows = self.counter.windows(body, max(budget, 8))
            out: list[Chunk] = []
            for window in windows:
                window_text = f"{header}\n\n{window}" if header else window
                [count] = self.counter.counts([window_text])
                out.append(Chunk(window_text[: self.max_characters], count, *_pages(units)))
            return out
        return [Chunk(text, tokens, *_pages(units))]


def _carry(unit: _Unit, text: str, tokens: int) -> _Unit:
    return _Unit(text, tokens, unit.section, unit.page_end, unit.page_end, "\n\n", overlap=True)


def _common_prefix(sections: Sequence[tuple[str, ...]]) -> tuple[str, ...]:
    if not sections:
        return tuple()
    prefix = sections[0]
    for section in sections[1:]:
        length = 0
        for a, b in zip(prefix, section):
            if a != b:
                break
            length += 1
        prefix = prefix[:length]
    return prefix


def _pages(units: Sequence[_Unit]) -> tuple[int | None, int | None]:
    starts = [u.page_start for u in units if u.page_start is not None]
    ends = [u.page_end for u in units if u.page_end is not None]
    return (min(starts) if starts else None, max(ends) if ends else None)


def _list_items(text: str) -> list[str]:
    items: list[str] = []
    for line in text.split("\n"):
        if items and not is_list_item(line.lstrip()) and line.startswith((" ", "\t")):
            items[-1] += "\n" + line
        else:
            items.append(line)
    return items
