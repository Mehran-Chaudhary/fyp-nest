import { PARAMETER_BOUNDS, resolveParameters, type ParameterLimits } from './generation';
import { ThinkFilter } from './think-filter';
import { PER_MESSAGE_OVERHEAD, rawTokenEstimate, TokenEstimator } from './token-estimator';

/**
 * Provider-neutral pieces of the LLM gateway: parameter resolution, token
 * estimation for context budgeting, and removal of reasoning blocks.
 */

const LIMITS: ParameterLimits = {
  defaultTemperature: 0.3,
  defaultMaxOutputTokens: 1_024,
  maxOutputTokens: 2_048,
};

describe('generation parameters', () => {
  it('falls back to the platform defaults', () => {
    expect(resolveParameters(LIMITS)).toEqual({ temperature: 0.3, maxOutputTokens: 1_024 });
  });

  it('lets later layers override earlier ones, ignoring undefined and null', () => {
    const resolved = resolveParameters(LIMITS, { temperature: 0.7, topP: 0.9 }, undefined, {
      temperature: undefined,
      topP: null as unknown as number,
      maxOutputTokens: 256,
    });
    expect(resolved).toEqual({ temperature: 0.7, topP: 0.9, maxOutputTokens: 256 });
  });

  it('clamps to the ceilings instead of failing a request made under older limits', () => {
    const resolved = resolveParameters(LIMITS, {
      temperature: 9,
      topP: 0,
      topK: 10_000.4,
      repeatPenalty: 0.1,
      maxOutputTokens: 1_000_000,
    });
    expect(resolved.temperature).toBe(PARAMETER_BOUNDS.temperature.max);
    expect(resolved.topP).toBe(PARAMETER_BOUNDS.topP.min);
    expect(resolved.topK).toBe(PARAMETER_BOUNDS.topK.max);
    expect(resolved.repeatPenalty).toBe(PARAMETER_BOUNDS.repeatPenalty.min);
    expect(resolved.maxOutputTokens).toBe(2_048);
    expect(resolveParameters(LIMITS, { maxOutputTokens: 0 }).maxOutputTokens).toBe(1);
  });

  it('bounds stop sequences and drops a fractional seed', () => {
    const resolved = resolveParameters(LIMITS, {
      stop: ['', 'a', 'b', 'c', 'd', 'e', 'x'.repeat(100)],
      seed: 1.5,
    });
    expect(resolved.stop).toEqual(['a', 'b', 'c', 'd']);
    expect(resolved.seed).toBeUndefined();
    expect(resolveParameters(LIMITS, { stop: ['y'.repeat(100)], seed: 42 })).toMatchObject({
      stop: ['y'.repeat(PARAMETER_BOUNDS.stopLength)],
      seed: 42,
    });
  });
});

describe('token estimation', () => {
  it('counts a short English word as one token', () => {
    expect(rawTokenEstimate('hello world')).toBe(2);
    expect(rawTokenEstimate('')).toBe(0);
  });

  it('splits long words, numbers and punctuation the way BPE tokenizers do', () => {
    expect(rawTokenEstimate('internationalisation')).toBe(1 + Math.floor(19 / 6));
    expect(rawTokenEstimate('1234567')).toBe(3);
    expect(rawTokenEstimate('a, b!')).toBe(4);
    expect(rawTokenEstimate('line\nline')).toBe(3);
  });

  it('counts CJK characters individually and other scripts by pairs', () => {
    expect(rawTokenEstimate('你好世界')).toBe(4);
    expect(rawTokenEstimate('سلام')).toBe(2); // Urdu/Arabic script
  });

  it('starts pessimistic and adds per-message overhead', () => {
    const estimator = new TokenEstimator();
    expect(estimator.estimate('m', 'hello world')).toBe(Math.ceil(2 * 1.1));
    const messages = [
      { role: 'system' as const, content: 'hello world' },
      { role: 'user' as const, content: 'hi' },
    ];
    expect(TokenEstimator.rawMessages(messages)).toBe(3 + 2 * PER_MESSAGE_OVERHEAD);
    expect(estimator.estimateMessages('m', messages)).toBe(
      Math.ceil((3 + 2 * PER_MESSAGE_OVERHEAD) * 1.1),
    );
  });

  it('calibrates per model towards what the model reports, within bounds', () => {
    const estimator = new TokenEstimator();
    for (let round = 0; round < 50; round += 1) estimator.observe('llama', 1_000, 1_300);
    expect(estimator.factorFor('llama')).toBeCloseTo(1.3, 2);
    expect(estimator.factorFor('qwen')).toBe(1.1); // other models unaffected

    for (let round = 0; round < 50; round += 1) estimator.observe('odd', 1_000, 100_000);
    expect(estimator.factorFor('odd')).toBeLessThanOrEqual(1.8);
  });

  it('ignores observations too small or broken to learn from', () => {
    const estimator = new TokenEstimator();
    estimator.observe('m', 10, 1_000);
    estimator.observe('m', 1_000, 0);
    expect(estimator.factorFor('m')).toBe(1.1);
  });
});

describe('reasoning block removal', () => {
  const run = (chunks: string[]): { text: string; thought: boolean } => {
    const filter = new ThinkFilter();
    let text = '';
    for (const chunk of chunks) text += filter.push(chunk);
    text += filter.flush();
    return { text, thought: filter.thought };
  };

  it('removes a leading reasoning block and the whitespace after it', () => {
    expect(run(['<think>Let me see.</think>\n\nThe answer is 4.'])).toEqual({
      text: 'The answer is 4.',
      thought: true,
    });
  });

  it('handles tags split across chunks at every position', () => {
    const answer = '  <think>step one\nstep two</think>  Paris.';
    for (let cut = 1; cut < answer.length; cut += 1) {
      expect(run([answer.slice(0, cut), answer.slice(cut)]).text).toBe('Paris.');
    }
    expect(run(answer.split('')).text).toBe('Paris.');
  });

  it('leaves an answer without reasoning untouched, whitespace included', () => {
    expect(run(['  Hello', ' there'])).toEqual({ text: '  Hello there', thought: false });
  });

  it('keeps a <think> tag that is not at the start', () => {
    expect(run(['Use the <think> tag like this: <think>x</think>']).text).toBe(
      'Use the <think> tag like this: <think>x</think>',
    );
  });

  it('releases a lone "<thi" at the end of the stream as text', () => {
    expect(run(['<thi'])).toEqual({ text: '<thi', thought: false });
    expect(run(['<'])).toEqual({ text: '<', thought: false });
  });

  it('reports thinking while inside the block and yields nothing for an unclosed one', () => {
    const filter = new ThinkFilter();
    expect(filter.push('<think>pondering')).toBe('');
    expect(filter.isThinking).toBe(true);
    expect(filter.push(' still')).toBe('');
    expect(filter.flush()).toBe('');
  });
});
