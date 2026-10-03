"""Chunker rules, on a deterministic one-token-per-word counter."""

from __future__ import annotations

import re
from typing import Sequence

from app.chunking import Chunker, split_sentences
from app.parsing.blocks import Block


class WordCounter:
    """One token per whitespace-separated word."""

    def counts(self, texts: Sequence[str]) -> list[int]:
        return [len(text.split()) for text in texts]

    def windows(self, text: str, max_tokens: int) -> list[str]:
        words = text.split()
        return [" ".join(words[i : i + max_tokens]) for i in range(0, len(words), max_tokens)]

    def tail(self, text: str, max_tokens: int) -> str:
        return " ".join(text.split()[-max_tokens:])


def words(n: int, start: int = 0, prefix: str = "w") -> str:
    return " ".join(f"{prefix}{i}" for i in range(start, start + n))


def sentences(n: int, length: int = 9, prefix: str = "S") -> str:
    return " ".join(f"{prefix}{i} " + words(length - 2, prefix=f"s{i}x") + "." for i in range(n))


def chunker(size: int = 50, overlap: int = 10, **kwargs: object) -> Chunker:
    return Chunker(WordCounter(), size, overlap, **kwargs)  # type: ignore[arg-type]


def test_no_chunk_exceeds_the_size() -> None:
    blocks = [Block("heading", "Policy", level=1), Block("paragraph", sentences(40))]
    chunks = chunker(50, 10).chunk(blocks)
    assert len(chunks) > 3
    assert all(c.token_count <= 50 for c in chunks)
    assert all(c.token_count == len(c.text.split()) for c in chunks)


def test_every_chunk_starts_with_its_section_path() -> None:
    blocks = [
        Block("heading", "Leave policy", level=1),
        Block("heading", "Annual leave", level=2),
        Block("paragraph", sentences(30)),
    ]
    for chunk in chunker(60, 0).chunk(blocks):
        assert chunk.text.startswith("Leave policy > Annual leave\n\n")


def test_paragraphs_that_fit_stay_whole() -> None:
    paragraphs = [sentences(3, prefix=f"P{i}S") for i in range(6)]  # 27 words each
    blocks = [Block("paragraph", p) for p in paragraphs]
    chunks = chunker(60, 0, context_headers=False).chunk(blocks)
    for p in paragraphs:
        assert sum(p in c.text for c in chunks) == 1, "a paragraph that fits was split"


def test_overlap_repeats_whole_closing_sentences_only() -> None:
    text = sentences(30)  # 9-word sentences
    chunks = chunker(50, 20, context_headers=False).chunk([Block("paragraph", text)])
    assert len(chunks) >= 3
    for previous, current in zip(chunks, chunks[1:]):
        first_sentence = split_sentences(current.text)[0]
        assert first_sentence in previous.text, "the opening sentence was not carried over"
        assert first_sentence.endswith(".")


def test_no_overlap_across_sections() -> None:
    blocks = [
        Block("heading", "A", level=1),
        Block("paragraph", sentences(8, prefix="A")),
        Block("heading", "B", level=1),
        Block("paragraph", sentences(8, prefix="B")),
    ]
    chunks = chunker(80, 30).chunk(blocks)
    b_chunks = [c for c in chunks if c.text.startswith("B\n\n")]
    assert b_chunks and "A0 " not in b_chunks[0].text and not re.search(r"\bA\d+ ", b_chunks[0].text)


def test_small_sibling_sections_share_a_chunk() -> None:
    blocks = [Block("heading", "FAQ", level=1)]
    for i in range(6):
        blocks += [Block("heading", f"Question {i}", level=2), Block("paragraph", sentences(1, prefix=f"Q{i}A"))]
    chunks = chunker(100, 0).chunk(blocks)
    assert len(chunks) < 6
    first = chunks[0].text
    assert first.startswith("FAQ\n\n")
    assert "Question 0" in first and "Question 1" in first  # sub-headings kept inline


def test_tables_stay_whole_when_they_fit_and_repeat_the_header_when_split() -> None:
    header = "| Name | Days |\n|---|---|"
    small = header + "\n" + "\n".join(f"| r{i} | {i} |" for i in range(3))
    chunks = chunker(60, 0, context_headers=False).chunk([Block("table", small)])
    assert len(chunks) == 1 and chunks[0].text == small

    big = header + "\n" + "\n".join(f"| row{i} alpha beta | {i} |" for i in range(40))
    pieces = chunker(60, 0, context_headers=False).chunk([Block("table", big)])
    assert len(pieces) > 2
    assert all(p.text.startswith(header) for p in pieces)
    assert all(p.token_count <= 60 for p in pieces)


def test_pages_are_tracked() -> None:
    blocks = [Block("paragraph", sentences(5, prefix="X"), page=1), Block("paragraph", sentences(5, prefix="Y"), page=2, page_end=3)]
    chunks = chunker(60, 0, context_headers=False).chunk(blocks)
    assert chunks[0].page_start == 1
    assert chunks[-1].page_end == 3
    assert all(c.page_start is not None and c.page_start <= c.page_end for c in chunks)


def test_a_sentence_longer_than_a_chunk_is_windowed() -> None:
    giant = words(300) + "."
    chunks = chunker(50, 0, context_headers=False).chunk([Block("paragraph", giant)])
    assert all(c.token_count <= 50 for c in chunks)
    assert " ".join(c.text for c in chunks).split() == giant.split()


def test_lists_split_between_items() -> None:
    items = "\n".join(f"- item {i} " + words(6) for i in range(30))
    chunks = chunker(40, 0, context_headers=False).chunk([Block("list", items)])
    for chunk in chunks:
        for line in chunk.text.split("\n"):
            assert line.startswith("- item "), "a list item was cut in the middle"


def test_headings_only_document_still_yields_content() -> None:
    chunks = chunker().chunk([Block("heading", "Title", level=1), Block("heading", "Subtitle", level=2)])
    assert chunks and "Title" in chunks[0].text


def test_empty_document_yields_nothing() -> None:
    assert chunker().chunk([]) == []


def test_long_section_paths_are_trimmed_from_the_left() -> None:
    path = [Block("heading", f"Level{i} " + words(5), level=i + 1) for i in range(5)]
    chunks = chunker(40, 0).chunk(path + [Block("paragraph", sentences(3))])
    header = chunks[0].text.split("\n\n", 1)[0]
    assert len(header.split()) <= 10  # a quarter of the chunk
    assert header.startswith("Level4") or "Level4" in header


def test_sentence_splitter_respects_abbreviations_and_initials() -> None:
    text = "Dr. A. Khan met Mr. Raza at 3 p.m. on Monday. They agreed. Next steps e.g. leave forms follow."
    assert split_sentences(text) == [
        "Dr. A. Khan met Mr. Raza at 3 p.m. on Monday.",
        "They agreed.",
        "Next steps e.g. leave forms follow.",
    ]


def test_sentence_splitter_handles_urdu_full_stop() -> None:
    assert len(split_sentences("یہ پہلا جملہ ہے۔ یہ دوسرا جملہ ہے۔")) == 2


def test_sections_of_reasonable_size_are_not_blended() -> None:
    blocks = [Block("heading", "Handbook", level=1)]
    for name in ("Leave", "Travel", "Security"):
        blocks += [Block("heading", name, level=2), Block("paragraph", sentences(8, prefix=name[0]))]  # 72 words each
    chunks = chunker(200, 0).chunk(blocks)  # merge only below max(64, 200 // 4) = 64: each section stands alone
    assert [c.text.split("\n\n", 1)[0] for c in chunks] == ["Handbook > Leave", "Handbook > Travel", "Handbook > Security"]
