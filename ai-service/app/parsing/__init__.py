"""Bytes → `ExtractedDocument`, by declared file type.

The backend has already verified the type from the file's bytes; the cheap
signature checks here are defence in depth, so a mislabelled file fails with
a clear 422 instead of a parser stack trace.
"""

from __future__ import annotations

from .. import errors
from .blocks import Block, ExtractedDocument
from .docx import OLE_SIGNATURE, extract_docx
from .ocr import OcrEngine
from .pdf import extract_pdf
from .text import extract_markdown, extract_text

SUPPORTED_TYPES = ("pdf", "docx", "txt", "md")

__all__ = ["Block", "ExtractedDocument", "SUPPORTED_TYPES", "extract"]


def extract(
    data: bytes,
    file_type: str,
    *,
    ocr: OcrEngine | None = None,
    max_ocr_pages: int = 0,
) -> ExtractedDocument:
    if file_type not in SUPPORTED_TYPES:
        raise errors.unsupported_file_type(file_type)
    if not data:
        return ExtractedDocument(blocks=[], page_count=0, parser="none", parser_version="")

    if file_type == "pdf":
        if b"%PDF-" not in data[:1024]:
            raise errors.unparseable("The file is not a valid PDF.")
        return extract_pdf(data, ocr=ocr, max_ocr_pages=max_ocr_pages)
    if file_type == "docx":
        if not (data.startswith(b"PK\x03\x04") or data.startswith(OLE_SIGNATURE)):
            raise errors.unparseable("The file is not a valid Word document.")
        return extract_docx(data)
    if file_type == "md":
        return extract_markdown(data)
    return extract_text(data)
