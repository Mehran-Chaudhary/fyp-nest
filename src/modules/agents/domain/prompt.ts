import type { ChatMessage } from '../../llm/domain/generation';

/**
 * Prompt assembly: turning masked segments into the messages sent to the model.
 *
 * Retrieved passages are wrapped in explicit delimiters so the model can tell
 * reference material from the user's question — and so that it can be told to
 * treat everything inside them as data. The delimiters only work if a passage
 * cannot close them itself, so untrusted text is escaped *before* masking: a
 * document containing `</context>` or `<source …>` cannot break out, and one
 * containing a fake citation tag cannot impersonate a source.
 */

/** Neutralises delimiter-like and citation-like text inside untrusted content. */
export function escapeUntrusted(text: string): string {
  return text
    .replace(/<(\/?)(context|source)\b/gi, '&lt;$1$2')
    .replace(/\[(S\d{1,3})\]/g, '($1)');
}

/** Attribute-safe title: no quotes, no line breaks, bounded length. */
export function escapeTitle(title: string): string {
  return escapeUntrusted(title)
    .replace(/["\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function sourceTag(index: number): string {
  return `S${index + 1}`;
}

export interface MaskedSource {
  tag: string;
  title: string;
  text: string;
}

export function contextBlock(sources: readonly MaskedSource[]): string {
  const body = sources
    .map(
      (source) =>
        `<source tag="${source.tag}" title="${source.title}">\n${source.text}\n</source>`,
    )
    .join('\n');
  return `<context>\n${body}\n</context>`;
}

/** The final user turn: the reference material, then the question. */
export function userTurn(question: string, sources: readonly MaskedSource[]): string {
  return sources.length === 0
    ? question
    : `${contextBlock(sources)}\n\nQuestion: ${question}`;
}

export function assembleMessages(
  system: string,
  history: readonly ChatMessage[],
  finalUserTurn: string,
): ChatMessage[] {
  return [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: finalUserTurn },
  ];
}

/**
 * Which sources the answer cites, by tag, in order of first use. Tags that do
 * not correspond to a provided source (the model inventing `[S9]`) are ignored.
 */
export function citedTags(answer: string, available: readonly string[]): string[] {
  const known = new Set(available);
  const cited: string[] = [];
  for (const match of answer.matchAll(/\[(S\d{1,3})\]/g)) {
    const tag = match[1];
    if (known.has(tag) && !cited.includes(tag)) cited.push(tag);
  }
  return cited;
}
