"""Builds small, real PDFs for tests with PDFium itself (no extra dependency)."""

from __future__ import annotations

import ctypes
import io
from dataclasses import dataclass

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c


@dataclass
class TextRun:
    text: str
    x: float
    y: float  # from the bottom of the page, as PDF coordinates are
    size: float = 11.0
    bold: bool = False


def build_pdf(pages: list[list[TextRun]], width: float = 595, height: float = 842) -> bytes:
    pdf = pdfium.PdfDocument.new()
    regular = pdfium_c.FPDFText_LoadStandardFont(pdf.raw, b"Helvetica")
    bold = pdfium_c.FPDFText_LoadStandardFont(pdf.raw, b"Helvetica-Bold")
    for runs in pages:
        page = pdf.new_page(width, height)
        for run in runs:
            obj = pdfium_c.FPDFPageObj_CreateTextObj(pdf.raw, bold if run.bold else regular, ctypes.c_float(run.size))
            encoded = (run.text + "\x00").encode("utf-16-le")
            buffer = ctypes.create_string_buffer(encoded, len(encoded))
            pdfium_c.FPDFText_SetText(obj, ctypes.cast(buffer, ctypes.POINTER(pdfium_c.FPDF_WCHAR)))
            pdfium_c.FPDFPageObj_Transform(obj, 1, 0, 0, 1, run.x, run.y)
            pdfium_c.FPDFPage_InsertObject(page.raw, obj)
        pdfium_c.FPDFPage_GenerateContent(page.raw)
        page.close()
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    return out.getvalue()


def flow(lines: list[tuple[str, float, bool]], *, top: float = 800, left: float = 56, leading: float = 1.35,
         paragraph_gap: float = 10) -> list[TextRun]:
    """Lays out (text, size, bold) lines top to bottom. An empty text adds paragraph spacing."""
    runs: list[TextRun] = []
    y = top
    for text, size, bold in lines:
        if not text:
            y -= paragraph_gap
            continue
        runs.append(TextRun(text, left, y, size, bold))
        y -= size * leading
    return runs
