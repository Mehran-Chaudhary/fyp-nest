"""Token counting and word-aligned token windows, on the embedding model's own tokenizer."""

from __future__ import annotations

from typing import Sequence

from tokenizers import Tokenizer


class HfTokenCounter:
    def __init__(self, tokenizer: Tokenizer) -> None:
        self._tokenizer = tokenizer

    def counts(self, texts: Sequence[str]) -> list[int]:
        if not texts:
            return []
        return [len(e.ids) for e in self._tokenizer.encode_batch(list(texts), add_special_tokens=False)]

    def windows(self, text: str, max_tokens: int) -> list[str]:
        """Consecutive pieces of at most `max_tokens` tokens, cut between words."""
        encoding = self._tokenizer.encode(text, add_special_tokens=False)
        offsets = encoding.offsets
        total = len(offsets)
        if total == 0:
            return [text.strip()] if text.strip() else []
        pieces: list[str] = []
        start = 0
        while start < total:
            end = min(start + max_tokens, total)
            if end < total:
                # Step back to a word boundary, but never below half a window.
                cut = end
                while cut > start + max_tokens // 2 and not self._starts_word(text, offsets, cut):
                    cut -= 1
                if cut > start + max_tokens // 2:
                    end = cut
            char_start = offsets[start][0]
            char_end = offsets[end][0] if end < total else len(text)
            piece = text[char_start:char_end].strip()
            if piece:
                pieces.append(piece)
            start = end
        # Re-tokenised in isolation, a piece can come out a token or two
        # longer than its slice of the whole; split any that do.
        checked: list[str] = []
        for piece, count in zip(pieces, self.counts(pieces)):
            if count <= max_tokens or max_tokens < 4:
                checked.append(piece)
            else:
                checked.extend(self.windows(piece, max_tokens - max(1, count - max_tokens)))
        return checked

    def tail(self, text: str, max_tokens: int) -> str:
        """The end of `text`, at most `max_tokens` tokens, starting at a word."""
        encoding = self._tokenizer.encode(text, add_special_tokens=False)
        offsets = encoding.offsets
        if len(offsets) <= max_tokens:
            return text.strip()
        start = len(offsets) - max_tokens
        while start < len(offsets) and not self._starts_word(text, offsets, start):
            start += 1
        if start >= len(offsets):
            return ""
        return text[offsets[start][0] :].strip()

    @staticmethod
    def _starts_word(text: str, offsets: list[tuple[int, int]], index: int) -> bool:
        position = offsets[index][0]
        return position == 0 or text[position - 1].isspace() or text[position].isspace()
