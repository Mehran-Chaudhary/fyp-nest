import type { ChatMessage } from './generation';

/**
 * Token estimation for context-window budgeting.
 *
 * The gateway has to decide what fits *before* sending — how much history, how
 * many retrieved passages — and the model's own tokenizer lives on the GPU
 * host, not here. So tokens are estimated from the text's shape, the way
 * byte-pair tokenizers (Llama 3, Mistral, Qwen) actually split it:
 *
 *  - a Latin word is usually one token, and one more per ~6 further letters;
 *  - numbers split into groups of up to three digits;
 *  - CJK characters are about a token each; other scripts (Urdu, Hindi) about
 *    one per two characters;
 *  - punctuation and symbols are a token each; a line break is one.
 *
 * Estimates are then **calibrated per model** against what the model reports
 * afterwards (`prompt_eval_count`). The correction factor is a moving average,
 * clamped so that one odd response cannot skew it, and it starts slightly
 * pessimistic: overestimating wastes a little context; underestimating
 * overflows it, and Ollama silently drops the *start* of an overflowing
 * prompt — the system instructions.
 */

const PIECES =
  /(\p{Script=Latin}+|\p{N}+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|\p{L}+|\s+|[^\p{L}\p{N}\s])/gu;

/** Chat-template tokens around each message (role markers, separators). */
export const PER_MESSAGE_OVERHEAD = 6;

/** Initial correction: estimate 10% high until the model tells us otherwise. */
const INITIAL_FACTOR = 1.1;
const MIN_FACTOR = 0.6;
const MAX_FACTOR = 1.8;
const LEARNING_RATE = 0.2;

/** A shape-based estimate with no calibration applied. */
export function rawTokenEstimate(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(PIECES)) {
    const piece = match[0];
    const first = piece.codePointAt(0) ?? 0;

    if (/^\s/u.test(piece)) {
      if (piece.includes('\n')) tokens += 1;
    } else if (/^\p{N}/u.test(piece)) {
      tokens += Math.ceil(piece.length / 3);
    } else if (/^\p{Script=Latin}/u.test(piece)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else if (/^\p{L}/u.test(piece)) {
      // One CJK character matches alone; other scripts match as a run.
      tokens += piece.length === 1 && first > 0x2e80 ? 1 : Math.ceil(piece.length / 2);
    } else {
      tokens += 1;
    }
  }
  return tokens;
}

export class TokenEstimator {
  private readonly factors = new Map<string, number>();

  factorFor(model: string): number {
    return this.factors.get(model) ?? INITIAL_FACTOR;
  }

  estimate(model: string, text: string): number {
    return Math.ceil(rawTokenEstimate(text) * this.factorFor(model));
  }

  estimateMessages(model: string, messages: readonly ChatMessage[]): number {
    const raw = messages.reduce(
      (total, message) => total + rawTokenEstimate(message.content) + PER_MESSAGE_OVERHEAD,
      0,
    );
    return Math.ceil(raw * this.factorFor(model));
  }

  /**
   * Feeds back a model-reported count for a prompt whose raw (uncalibrated)
   * estimate was `rawEstimate`.
   */
  observe(model: string, rawEstimate: number, actual: number): void {
    if (rawEstimate < 32 || actual <= 0) return; // too small to learn from
    const ratio = Math.min(Math.max(actual / rawEstimate, MIN_FACTOR), MAX_FACTOR);
    const current = this.factors.get(model) ?? INITIAL_FACTOR;
    const next = current + LEARNING_RATE * (ratio - current);
    this.factors.set(model, Math.min(Math.max(next, MIN_FACTOR), MAX_FACTOR));
  }

  /** Raw estimate for a message list, for calibration bookkeeping. */
  static rawMessages(messages: readonly ChatMessage[]): number {
    return messages.reduce(
      (total, message) => total + rawTokenEstimate(message.content) + PER_MESSAGE_OVERHEAD,
      0,
    );
  }
}
