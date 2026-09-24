/**
 * Removes a leading `<think>…</think>` block from a streamed answer.
 *
 * Reasoning models (DeepSeek-R1, Qwen3 and their distillations) emit their
 * chain of thought before the answer, wrapped in `<think>` tags. It is not
 * part of the answer, it is often long, and it restates the prompt — so it is
 * dropped before the user sees anything.
 *
 * Only a block at the very start is removed (after optional whitespace). A
 * model explaining HTML that happens to write "<think>" mid-answer keeps it.
 * Tags split across chunks are handled by holding back a possible partial tag.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

type State = 'start' | 'thinking' | 'after-thinking' | 'answer';

export class ThinkFilter {
  private state: State = 'start';
  private buffer = '';
  private sawThinking = false;

  /** True once a reasoning block was detected. */
  get thought(): boolean {
    return this.sawThinking;
  }

  get isThinking(): boolean {
    return this.state === 'thinking';
  }

  push(chunk: string): string {
    if (this.state === 'answer') return chunk;
    if (this.state === 'after-thinking') return this.trimLeading(chunk);
    this.buffer += chunk;

    if (this.state === 'start') {
      const trimmed = this.buffer.trimStart();
      if (trimmed.length === 0) return '';

      if (trimmed.startsWith(OPEN)) {
        this.state = 'thinking';
        this.sawThinking = true;
        this.buffer = trimmed.slice(OPEN.length);
      } else if (OPEN.startsWith(trimmed)) {
        return ''; // could still be "<think>"
      } else {
        this.state = 'answer';
        const released = this.buffer;
        this.buffer = '';
        return released;
      }
    }

    // Thinking: discard until the closing tag.
    const end = this.buffer.indexOf(CLOSE);
    if (end === -1) {
      // Keep only what could be the start of "</think>".
      this.buffer = this.buffer.slice(-(CLOSE.length - 1));
      return '';
    }

    const rest = this.buffer.slice(end + CLOSE.length);
    this.buffer = '';
    this.state = 'after-thinking';
    return this.trimLeading(rest);
  }

  /** The whitespace between the reasoning block and the answer is not part of the answer. */
  private trimLeading(chunk: string): string {
    const trimmed = chunk.replace(/^\s+/, '');
    if (trimmed.length > 0) this.state = 'answer';
    return trimmed;
  }

  /** End of stream: an unfinished opening tag was just text after all. */
  flush(): string {
    const pending = this.state === 'start' ? this.buffer : '';
    this.buffer = '';
    return pending;
  }
}
