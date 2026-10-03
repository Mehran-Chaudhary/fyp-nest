"""PDF extraction on PDFium (pypdfium2): fast, exact, permissively licensed.

PDFium gives the text layer character by character, with each character's
font box. From that this module rebuilds what retrieval needs and a plain
text dump loses:

- **headings**, from type size (the loose font box, which survives PDFs that
  scale a size-1 font by a matrix), weight and capitalisation;
- **paragraphs**, from vertical gaps, indentation and short closing lines,
  joined across line breaks and page breaks, with end-of-line hyphenation
  undone;
- **lists**, from bullet and numbering markers and hanging indents;
- **running headers, footers and page numbers**, removed when they repeat on
  most pages, so they do not pollute every chunk.

Pages without a text layer (scans) are counted and, when an OCR engine is
installed, recognised (see `ocr.py`).
"""

from __future__ import annotations

import ctypes
import logging
import re
from collections import Counter
from dataclasses import dataclass
from importlib.metadata import version

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .. import errors
from .blocks import Block, ExtractedDocument, clean_text, is_list_item
from .ocr import OcrEngine

log = logging.getLogger("daiap.parse.pdf")

PARSER_NAME = "pdfium"
_VERSION = version("pypdfium2")


@dataclass(slots=True)
class Line:
    text: str
    height: float  # loose font-box height: a proxy for type size
    bold: bool
    left: float
    right: float
    top: float
    bottom: float
    page: int


def extract_pdf(data: bytes, *, ocr: OcrEngine | None = None, max_ocr_pages: int = 0) -> ExtractedDocument:
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as error:
        if _is_password_error(error):
            raise errors.encrypted() from None
        raise errors.unparseable() from None

    pages: list[list[Line]] = []
    heights: list[float] = []
    empty_pages = 0
    ocr_pages = 0
    try:
        page_count = len(pdf)
        for index in range(page_count):
            page = pdf[index]
            try:
                heights.append(page.get_height())
                lines = _page_lines(page, index + 1)
                if _is_effectively_empty(lines):
                    if ocr is not None and ocr_pages < max_ocr_pages:
                        lines = ocr.recognise_page(page, index + 1)
                        ocr_pages += 1
                    if _is_effectively_empty(lines):
                        empty_pages += 1
                        lines = []
                pages.append(lines)
            finally:
                page.close()
    except pdfium.PdfiumError:
        raise errors.unparseable() from None
    finally:
        pdf.close()

    pages = _strip_running_lines(pages, heights)
    blocks = _assemble(pages)
    return ExtractedDocument(
        blocks=blocks,
        page_count=page_count,
        parser=PARSER_NAME,
        parser_version=_VERSION,
        empty_pages=empty_pages,
        ocr_pages=ocr_pages,
    )


def _is_password_error(error: pdfium.PdfiumError) -> bool:
    code = getattr(error, "err_code", None)
    return code == pdfium_c.FPDF_ERR_PASSWORD or "password" in str(error).lower()


def _is_effectively_empty(lines: list[Line]) -> bool:
    """No letters or digits at all: a scan, or a page of pure graphics. A page
    with even one short title line ("Annual Report") is real content."""
    return not any(char.isalnum() for line in lines for char in line.text)


# ── Character walk ───────────────────────────────────────────────────────────


def _page_lines(page: pdfium.PdfPage, page_number: int) -> list[Line]:
    textpage = page.get_textpage()
    try:
        raw = textpage.raw
        count = pdfium_c.FPDFText_CountChars(raw)
        if count <= 0:
            return []

        left = ctypes.c_double()
        right = ctypes.c_double()
        bottom = ctypes.c_double()
        top = ctypes.c_double()
        rect = pdfium_c.FS_RECTF()

        def loose_box(index: int) -> tuple[float, float, float, float]:
            if pdfium_c.FPDFText_GetLooseCharBox(raw, index, rect):
                return rect.left, rect.right, rect.bottom, rect.top
            pdfium_c.FPDFText_GetCharBox(raw, index, left, right, bottom, top)
            return left.value, right.value, bottom.value, top.value

        lines: list[Line] = []
        buffer: list[str] = []
        first = last = -1

        def flush() -> None:
            nonlocal buffer, first, last
            text = "".join(buffer).strip()
            if text and first >= 0:
                l0, _, b0, t0 = loose_box(first)
                _, r1, _, _ = loose_box(last)
                weight = pdfium_c.FPDFText_GetFontWeight(raw, first)
                lines.append(
                    Line(
                        text=text,
                        height=round(abs(t0 - b0), 1),
                        bold=weight >= 600,
                        left=l0,
                        right=r1,
                        top=t0,
                        bottom=b0,
                        page=page_number,
                    )
                )
            buffer = []
            first = last = -1

        index = 0
        while index < count:
            code = pdfium_c.FPDFText_GetUnicode(raw, index)
            if code == 0x0A:
                flush()
                index += 1
                continue
            if code in (0x0D, 0x00, 0xFFFE, 0xFFFF):
                index += 1
                continue
            if 0xD800 <= code < 0xDC00 and index + 1 < count:
                low = pdfium_c.FPDFText_GetUnicode(raw, index + 1)
                char = chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)) if 0xDC00 <= low < 0xE000 else ""
                step = 2
            else:
                # PDFium reports a hyphen it decided ends a line as U+0002.
                char = "-" if code == 0x02 else chr(code)
                step = 1
            if char and not char.isspace():
                if first < 0:
                    first = index
                last = index
            buffer.append(char)
            index += step
        flush()
        return lines
    finally:
        textpage.close()


# ── Running headers and footers ──────────────────────────────────────────────

_PAGE_NUMBER = re.compile(r"^(?:page\s*)?#(?:\s*(?:of|/)\s*#)?$|^[-–—]\s*#\s*[-–—]$", re.IGNORECASE)


def _signature(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower()).strip()


def _edge_lines(lines: list[Line], height: float) -> list[Line]:
    """Lines that could be running headers or footers: the first and last one
    or two on the page, and only if they sit in the top or bottom margin band."""
    if not lines:
        return []
    k = 2 if len(lines) >= 6 else 1
    top_band, bottom_band = height * 0.85, height * 0.15
    # Running headers and footers are short; a full line of prose is body text.
    head = [line for line in lines[:k] if line.top >= top_band and len(line.text) <= 100]
    foot = [line for line in lines[-k:] if line.bottom <= bottom_band and len(line.text) <= 100]
    return head + [line for line in foot if line not in head]


def _strip_running_lines(pages: list[list[Line]], heights: list[float]) -> list[list[Line]]:
    """Drops lines repeated in the top or bottom margin of most pages, and page numbers."""
    edges = [_edge_lines(lines, height) for lines, height in zip(pages, heights)]
    counts = Counter(signature for edge in edges for signature in {_signature(line.text) for line in edge})
    real_pages = sum(1 for lines in pages if lines)
    # On most pages; on both pages of a two-page document. Only margin lines
    # are candidates (see _edge_lines), which keeps this safe at two.
    threshold = 2 if real_pages == 2 else max(3, (real_pages + 1) // 2)
    running = {sig for sig, n in counts.items() if n >= threshold} if real_pages >= 2 else set()

    cleaned: list[list[Line]] = []
    for lines, edge in zip(pages, edges):
        drop = {
            id(line)
            for line in edge
            if _signature(line.text) in running or _PAGE_NUMBER.match(_signature(line.text))
        }
        cleaned.append([line for line in lines if id(line) not in drop])
    return cleaned


# ── Lines → blocks ───────────────────────────────────────────────────────────

_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")
_TERMINAL = (".", ",", ";", "!", "?")
_SENTENCE_END = (".", "!", "?", ":", '"', "”", "۔", "؟")


def _body_height(pages: list[list[Line]]) -> float:
    weights: Counter[float] = Counter()
    for lines in pages:
        for line in lines:
            weights[line.height] += len(line.text)
    return weights.most_common(1)[0][0] if weights else 10.0


def _heading_levels(pages: list[list[Line]], body: float) -> dict[float, int]:
    sizes = sorted(
        {line.height for lines in pages for line in lines if line.height >= body * 1.15 and _short(line.text)},
        reverse=True,
    )
    return {size: min(position + 1, 3) for position, size in enumerate(sizes)}


def _short(text: str) -> bool:
    return len(text) <= 120 and len(text.split()) <= 16


def _looks_like_heading(line: Line, body: float, levels: dict[float, int]) -> int:
    """The heading level, or 0 for body text."""
    text = line.text
    if not _short(text) or text.endswith(_TERMINAL):
        return 0
    if is_list_item(text) and not _NUMBERED.match(text):
        return 0
    letters = sum(c.isalpha() for c in text)
    if letters < 2:
        return 0
    if line.height in levels:
        return levels[line.height]
    deeper = len(set(levels.values())) + 1
    if line.bold and line.height >= body * 0.95:
        numbered = _NUMBERED.match(text)
        return min(numbered.group(1).count(".") + deeper if numbered else deeper, 6)
    if text.isupper() and letters >= 4 and len(text.split()) <= 10:
        return min(deeper, 6)
    return 0


def _assemble(pages: list[list[Line]]) -> list[Block]:
    body = _body_height(pages)
    levels = _heading_levels(pages, body)
    widest = max((line.right for lines in pages for line in lines), default=0.0)

    blocks: list[Block] = []
    paragraph: list[Line] = []
    list_items: list[list[Line]] = []

    def close_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            blocks.append(
                Block("paragraph", clean_text(_join(paragraph)), page=paragraph[0].page, page_end=paragraph[-1].page)
            )
            paragraph = []

    def close_list() -> None:
        nonlocal list_items
        if list_items:
            text = "\n".join(clean_text(_join(item)) for item in list_items)
            blocks.append(Block("list", text, page=list_items[0][0].page, page_end=list_items[-1][-1].page))
            list_items = []

    previous: Line | None = None
    for lines in pages:
        for line in lines:
            level = _looks_like_heading(line, body, levels)
            if level:
                close_paragraph()
                close_list()
                # A heading wrapped over two lines arrives as two heading lines.
                if (
                    blocks
                    and blocks[-1].kind == "heading"
                    and blocks[-1].level == level
                    and previous is not None
                    and previous.page == line.page
                    and _gap(previous, line) < previous.height * 0.8
                ):
                    blocks[-1].text = clean_text(blocks[-1].text + " " + line.text)
                else:
                    blocks.append(Block("heading", clean_text(line.text), level=level, page=line.page))
                previous = line
                continue

            if is_list_item(line.text):
                close_paragraph()
                list_items.append([line])
                previous = line
                continue

            if list_items and previous is not None and _continues_list_item(list_items[-1], line, previous):
                list_items[-1].append(line)
                previous = line
                continue
            close_list()

            if paragraph and previous is not None and _breaks_paragraph(previous, line, widest):
                close_paragraph()
            paragraph.append(line)
            previous = line

    close_paragraph()
    close_list()
    return [block for block in blocks if block.text]


def _gap(previous: Line, line: Line) -> float:
    """Vertical white space between two lines on the same page (PDF y grows upwards)."""
    return previous.bottom - line.top


def _breaks_paragraph(previous: Line, line: Line, widest: float) -> bool:
    if line.page != previous.page or line.top > previous.top + previous.height:
        # A new page or a new column: the paragraph continues only mid-sentence.
        return previous.text.endswith(_SENTENCE_END)
    if _gap(previous, line) > max(previous.height, line.height) * 0.9:
        return True
    ended = previous.text.endswith(_SENTENCE_END)
    if ended and line.left > previous.left + line.height * 1.5:
        return True  # first-line indent
    if ended and widest and previous.right < widest * 0.7 and line.text[:1].isupper():
        return True  # a short closing line
    return False


def _continues_list_item(item: list[Line], line: Line, previous: Line) -> bool:
    first = item[0]
    return (
        line.page == previous.page
        and _gap(previous, line) < previous.height * 0.9
        and line.left > first.left + first.height * 0.4
    )


def _join(lines: list[Line]) -> str:
    text = lines[0].text
    for line in lines[1:]:
        if text.endswith("-") and len(text) > 1 and text[-2].isalpha() and line.text[:1].islower():
            text = text[:-1] + line.text  # undo end-of-line hyphenation
        else:
            text = text + " " + line.text
    return text
