"""Plain text and Markdown extraction.

Markdown is parsed with a CommonMark parser (markdown-it-py, tables enabled),
and each block keeps its original source, so a table stays a table and a code
fence stays a code fence in the chunk the model reads. Plain text is split on
blank lines, with conservative heading detection for the short title lines
policies and notes are written with.
"""

from __future__ import annotations

import codecs
import re

from markdown_it import MarkdownIt

from .. import errors
from .blocks import Block, ExtractedDocument, clean_text, is_list_item

_MARKDOWN = MarkdownIt("commonmark", {"html": True}).enable("table")
_FRONT_MATTER = re.compile(r"\A---\s*\n.*?\n---\s*\n", re.DOTALL)
_HTML_TAG = re.compile(r"<[^>]+>")
_TERMINAL = (".", ",", ";", "!", "?", "۔", "؟")


def decode_text(data: bytes) -> str:
    if data.startswith(codecs.BOM_UTF8):
        return data[len(codecs.BOM_UTF8) :].decode("utf-8", "replace")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    sample = data[:4096]
    if sample and sample.count(b"\x00") > len(sample) // 4:
        # UTF-16 without a byte-order mark: every other byte of ASCII is NUL.
        little = sample[1::2].count(b"\x00") > sample[0::2].count(b"\x00")
        return data.decode("utf-16-le" if little else "utf-16-be", "replace")
    # A statistical guess needs enough text to be right; on a short sample it
    # turns Western text into Cyrillic. Windows-1252 is the safe default for
    # short legacy files; longer ones (e.g. Urdu in Windows-1256) get detected.
    if len(data) >= 512:
        try:
            from charset_normalizer import from_bytes

            best = from_bytes(data).best()
            if best is not None:
                return str(best)
        except ImportError:
            pass
    return data.decode("cp1252", "replace")


def _check_is_text(text: str) -> None:
    if not text:
        return
    sample = text[:20_000]
    suspicious = sum(1 for c in sample if c == "�" or (ord(c) < 32 and c not in "\n\r\t\f"))
    if suspicious > len(sample) * 0.05:
        raise errors.unparseable("The file does not look like readable text.")


def extract_text(data: bytes) -> ExtractedDocument:
    text = decode_text(data)
    _check_is_text(text)
    blocks: list[Block] = []
    for raw in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n")):
        lines = [line for line in (clean_text(line) for line in raw.split("\n")) if line]
        if not lines:
            continue
        if len(lines) == 2 and set(lines[1]) <= set("=-") and len(lines[1]) >= 3:
            blocks.append(Block("heading", lines[0], level=1 if lines[1][0] == "=" else 2))
            continue
        if len(lines) == 1 and _plain_heading(lines[0]):
            blocks.append(Block("heading", lines[0], level=2))
            continue
        if all(is_list_item(line) for line in lines):
            blocks.append(Block("list", "\n".join(lines)))
            continue
        blocks.append(Block("paragraph", "\n".join(lines)))
    return ExtractedDocument(blocks=blocks, page_count=None, parser="text", parser_version="1")


def _plain_heading(line: str) -> bool:
    if len(line) > 80 or line.endswith(_TERMINAL) or is_list_item(line):
        return False
    words = [w for w in re.findall(r"[^\W\d_]+", line)]
    if not words:
        return False
    if line.isupper() and sum(len(w) for w in words) >= 4:
        return True
    capitalised = sum(1 for w in words if w[0].isupper())
    return len(words) <= 8 and capitalised / len(words) >= 0.6


def extract_markdown(data: bytes) -> ExtractedDocument:
    text = decode_text(data).replace("\r\n", "\n").replace("\r", "\n")
    _check_is_text(text)
    text = _FRONT_MATTER.sub("", text, count=1)
    source = text.split("\n")
    tokens = _MARKDOWN.parse(text)

    def lines_of(token) -> str:  # type: ignore[no-untyped-def]
        start, end = token.map
        return "\n".join(source[start:end])

    blocks: list[Block] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if token.level != 0 or token.map is None:
            continue
        kind = token.type
        if kind == "heading_open":
            inline = tokens[index].content if index < len(tokens) else ""
            heading = clean_text(inline)
            if heading:
                blocks.append(Block("heading", heading, level=int(token.tag[1])))
        elif kind == "paragraph_open":
            paragraph = clean_text(lines_of(token))
            if paragraph:
                blocks.append(Block("paragraph", paragraph))
        elif kind in ("bullet_list_open", "ordered_list_open"):
            blocks.append(Block("list", clean_text(lines_of(token), keep_layout=True)))
        elif kind in ("fence", "code_block"):
            blocks.append(Block("code", clean_text(lines_of(token), keep_layout=True)))
        elif kind == "table_open":
            blocks.append(Block("table", clean_text(lines_of(token), keep_layout=True)))
        elif kind == "blockquote_open":
            blocks.append(Block("quote", clean_text(lines_of(token))))
        elif kind == "html_block":
            stripped = clean_text(_HTML_TAG.sub(" ", lines_of(token)))
            if stripped:
                blocks.append(Block("paragraph", stripped))
    blocks = [block for block in blocks if block.text]
    return ExtractedDocument(blocks=blocks, page_count=None, parser="markdown-it", parser_version="1")
