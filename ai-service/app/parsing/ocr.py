"""Optional OCR for scanned pages, on RapidOCR (PaddleOCR models on ONNX Runtime).

Installed with the `ocr` extra. Without it, pages that have no text layer are
counted, and a fully scanned PDF yields no chunks, which the backend reports
to the user as DOCUMENT_EMPTY ("scanned documents need OCR").
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import pypdfium2 as pdfium

    from .pdf import Line

log = logging.getLogger("daiap.parse.ocr")

# Render scale: 2.0 ≈ 144 dpi, enough for body text without blowing up memory.
RENDER_SCALE = 2.0


class OcrEngine(Protocol):
    name: str

    def recognise_page(self, page: "pdfium.PdfPage", page_number: int) -> list["Line"]: ...


class RapidOcrEngine:
    name = "rapidocr"

    def __init__(self) -> None:
        from rapidocr import RapidOCR  # imported lazily: optional dependency

        self._engine: Any = RapidOCR()

    def recognise_page(self, page: "pdfium.PdfPage", page_number: int) -> list["Line"]:
        from .pdf import Line

        image = page.render(scale=RENDER_SCALE).to_numpy()
        height_pt = page.get_height()
        result = self._engine(image)
        boxes = getattr(result, "boxes", None)
        texts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None)
        if boxes is None or texts is None:
            return []

        lines: list[Line] = []
        for box, text, score in zip(boxes, texts, scores or [1.0] * len(texts)):
            if not text or not text.strip() or float(score) < 0.5:
                continue
            xs = [float(point[0]) / RENDER_SCALE for point in box]
            ys = [float(point[1]) / RENDER_SCALE for point in box]
            # Image y grows downwards; PDF y grows upwards.
            top, bottom = height_pt - min(ys), height_pt - max(ys)
            lines.append(
                Line(
                    text=text.strip(),
                    height=round(top - bottom, 1),
                    bold=False,
                    left=min(xs),
                    right=max(xs),
                    top=top,
                    bottom=bottom,
                    page=page_number,
                )
            )
        # Reading order: top to bottom, then left to right within a row.
        lines.sort(key=lambda line: (-round(line.top / max(line.height, 1.0)), line.left))
        return lines


def load_ocr_engine(enabled: bool) -> OcrEngine | None:
    if not enabled:
        return None
    try:
        engine = RapidOcrEngine()
    except ImportError:
        log.info("OCR not installed; scanned pages will be reported as empty")
        return None
    except Exception:  # noqa: BLE001 - a broken optional engine must not stop the service
        log.exception("OCR engine failed to load; continuing without OCR")
        return None
    log.info("OCR engine ready", extra={"engine": engine.name})
    return engine
