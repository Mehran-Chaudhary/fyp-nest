import { MAX_PLACEHOLDER_LENGTH, PLACEHOLDER_PREFIX } from './placeholders';

/**
 * Unmasks a token stream as it arrives.
 *
 * The model emits a placeholder a few characters at a time — `[`, `PER`,
 * `SON_`, `1]` — so a chunk cannot simply be unmasked on its own: the user
 * would see `[PER` and then, a moment later, the rest of a placeholder they
 * were never meant to see. The unmasker holds back only the shortest possible
 * suffix: from the last `[` that has no `]` after it, and only while that
 * suffix could still become a placeholder. Everything before it is unmasked
 * and released immediately, so streaming stays smooth.
 *
 * Correctness does not depend on how the stream is chunked: the concatenation
 * of every `push()` plus `flush()` equals unmasking the whole text at once.
 * The cut is always at an unclosed `[`, and a complete placeholder has no
 * unclosed `[` inside it, so no placeholder is ever split across two unmask
 * calls. The test suite checks this over randomised chunkings.
 */
export class StreamingUnmasker {
  private pending = '';

  constructor(private readonly unmask: (text: string) => string) {}

  /** Accepts the next chunk; returns the text now safe to show. */
  push(chunk: string): string {
    if (chunk.length === 0) return '';
    this.pending += chunk;

    const open = this.pending.lastIndexOf('[');
    let releaseUpTo = this.pending.length;

    if (open !== -1 && this.pending.indexOf(']', open) === -1) {
      const tail = this.pending.slice(open);
      if (tail.length <= MAX_PLACEHOLDER_LENGTH && PLACEHOLDER_PREFIX.test(tail)) {
        releaseUpTo = open;
      }
    }

    const ready = this.pending.slice(0, releaseUpTo);
    this.pending = this.pending.slice(releaseUpTo);
    return ready.length > 0 ? this.unmask(ready) : '';
  }

  /** Releases whatever is held back; call once at the end of the stream. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest.length > 0 ? this.unmask(rest) : '';
  }

  /** Characters currently held back. */
  get buffered(): number {
    return this.pending.length;
  }
}
