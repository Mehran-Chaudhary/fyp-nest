"""The parser-neutral document model every extractor produces.

Extractors turn bytes into an ordered list of `Block`s that keep the structure
retrieval cares about: which text is a heading (and at what level), which is a
table or a list, and which page it came from. The chunker never sees a file
format, only blocks.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Literal

BlockKind = Literal["heading", "paragraph", "list", "table", "code", "quote"]


@dataclass(slots=True)
class Block:
    kind: BlockKind
    text: str
    level: int = 0  # heading level, 1 = top
    page: int | None = None  # 1-based page where the block starts
    page_end: int | None = None  # 1-based page where it ends (multi-page paragraphs)

    @property
    def last_page(self) -> int | None:
        return self.page_end if self.page_end is not None else self.page


@dataclass(slots=True)
class ExtractedDocument:
    blocks: list[Block]
    page_count: int | None
    parser: str
    parser_version: str
    # Pages that had no text layer (scanned) and were not recovered by OCR.
    empty_pages: int = 0
    ocr_pages: int = 0
    metadata: dict[str, str] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return "\n\n".join(block.text for block in self.blocks)


# ── Text normalisation ───────────────────────────────────────────────────────

_LIGATURES = str.maketrans(
    {
        "ﬀ": "ff",
        "ﬁ": "fi",
        "ﬂ": "fl",
        "ﬃ": "ffi",
        "ﬄ": "ffl",
        "ﬅ": "st",
        "ﬆ": "st",
    }
)
# Invisible characters that only get in the way of search. ZWNJ/ZWJ (U+200C/D)
# are deliberately kept: Urdu and Persian spelling depends on them.
_INVISIBLE = dict.fromkeys(map(ord, "­​⁠﻿"), None)
_SPACES = re.compile(r"[ \t  -   　]+")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_BLANK_LINES = re.compile(r"\n{3,}")


def clean_text(text: str, *, keep_layout: bool = False) -> str:
    """NFC, ligatures expanded, invisible and control characters removed.

    `keep_layout` preserves runs of spaces and indentation (code, tables).
    """
    text = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = text.translate(_LIGATURES).translate(_INVISIBLE)
    text = _CONTROL.sub("", text)
    if not keep_layout:
        text = "\n".join(_SPACES.sub(" ", line).strip() for line in text.split("\n"))
    else:
        text = "\n".join(line.rstrip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", text).strip()


# Bullets, "1." / "(2)" and lower-case "a)" / "iv." markers. Upper-case "A." and
# "IV." are left alone: they open headings and initials ("A. Khan") as often
# as list items.
_BULLET = re.compile(r"^\s*(?:[-*+•▪◦●○■□–]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+")


def is_list_item(line: str) -> bool:
    return bool(_BULLET.match(line))
