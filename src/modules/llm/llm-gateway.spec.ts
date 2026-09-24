import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { sleep } from '../../common/utils/retry.util';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../config/llm.config';
import type { AuditService } from '../audit/audit.service';
import type { AuditEntryInput } from '../audit/audit.service';
import { Classification } from '../knowledge/domain/classification';
import { MaskingSession, prepareText } from '../privacy/domain/masking-session';
import { BUILT_IN_RECOGNIZERS } from '../privacy/domain/recognizers';
import type { ChatMessage } from './domain/generation';
import { GenerationInterruptedError } from './llm-errors';
import {
  LlmGatewayService,
  type GatewayChatRequest,
  type PrivacyGuard,
} from './llm-gateway.service';
import {
  LlmProviderError,
  type LlmProvider,
  type ProviderChatRequest,
  type ProviderEvent,
  type ProviderStream,
} from './providers/provider.types';

/**
 * The gateway's guarantees, against a scripted provider: nothing sensitive
 * leaves, a saturated or failing endpoint is refused cleanly, retries never
 * follow the first token, deadlines end silent generations, and the user sees
 * unmasked text as it streams.
 */

type Step = ProviderEvent | { wait: number } | { fail: LlmProviderError };
type Script = (
  request: ProviderChatRequest,
  signal: AbortSignal,
) => Promise<ProviderStream>;

class ScriptedProvider implements LlmProvider {
  readonly kind = 'ollama' as const;
  readonly listsEveryServedModel = true;
  readonly requests: ProviderChatRequest[] = [];
  readonly scripts: Script[] = [];
  cancelled = 0;

  normalizeModelName(name: string): string {
    return name;
  }
  listModels() {
    return Promise.resolve([]);
  }
  describeModel() {
    return Promise.resolve({ contextLength: null });
  }
  ping() {
    return Promise.resolve(true);
  }
  open(request: ProviderChatRequest, signal: AbortSignal): Promise<ProviderStream> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) return Promise.reject(new Error('unscripted call'));
    return script(request, signal);
  }

  /** A stream playing `steps`; waits honour the gateway's abort signal like a real socket. */
  stream(...steps: Step[]): Script {
    return (_request, signal) => {
      const onCancel = () => {
        this.cancelled += 1;
      };
      async function* events(): AsyncGenerator<ProviderEvent> {
        for (const step of steps) {
          if ('wait' in step) await sleep(step.wait, signal);
          else if ('fail' in step) throw step.fail;
          else yield step;
        }
      }
      return Promise.resolve({ events: events(), cancel: onCancel });
    };
  }

  refuse(error: LlmProviderError): Script {
    return () => Promise.reject(error);
  }
}

const delta = (text: string): ProviderEvent => ({ type: 'delta', text });
const done = (
  promptTokens: number | null = null,
  completionTokens: number | null = null,
): ProviderEvent => ({
  type: 'done',
  finishReason: 'stop',
  promptTokens,
  completionTokens,
});

const BASE_CONFIG: LlmConfig = {
  configured: true,
  provider: 'ollama',
  baseUrl: 'https://llm.test',
  defaultModel: 'm',
  allowedModels: [],
  defaultContextWindow: 8_192,
  maxContextWindow: 32_768,
  defaultMaxOutputTokens: 256,
  maxOutputTokens: 1_024,
  defaultTemperature: 0.3,
  firstTokenTimeoutMs: 150,
  idleTimeoutMs: 150,
  maxDurationMs: 2_000,
  maxConcurrency: 2,
  queueTimeoutMs: 50,
  maxRetries: 1,
  maxResponseBytes: 1024 * 1024,
  circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
  keepAlive: '5m',
  maxClassification: Classification.RESTRICTED,
  modelCacheTtlMs: 60_000,
};

function setup(overrides: Partial<LlmConfig> = {}) {
  const provider = new ScriptedProvider();
  const audits: AuditEntryInput[] = [];
  const audit = {
    recordSafe: (entry: AuditEntryInput) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  const config = {
    getOrThrow: (key: string) => {
      if (key !== LLM_CONFIG_KEY) throw new Error(`unexpected config key ${key}`);
      return { ...BASE_CONFIG, ...overrides };
    },
  } as unknown as ConfigService;
  return { provider, audits, gateway: new LlmGatewayService(provider, audit, config) };
}

const OFF: PrivacyGuard = { mode: 'disabled', reason: 'workspace-policy' };

function request(
  messages: ChatMessage[],
  privacy: PrivacyGuard = OFF,
  signal?: AbortSignal,
): GatewayChatRequest {
  return {
    organizationId: 'org-1',
    model: 'm',
    messages,
    parameters: { temperature: 0.2, maxOutputTokens: 256 },
    contextWindow: 8_192,
    privacy,
    signal,
  };
}

const ASK: ChatMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Say hello.' },
];

/** A session that has masked one person and one card, the way redaction would. */
function maskedPrompt(): { session: MaskingSession; messages: ChatMessage[] } {
  const session = new MaskingSession({
    enabledTypes: new Set(['PERSON', 'CREDIT_CARD']),
    scoreThreshold: 0.5,
    allowList: [],
    recognizers: BUILT_IN_RECOGNIZERS,
  });
  const text = prepareText('Ayesha Raza pays with 4111 1111 1111 1111.');
  const [masked] = session.mask(
    [{ id: 'q', text }],
    [
      [
        {
          entityType: 'PERSON',
          start: 0,
          end: 11,
          score: 0.9,
          source: 'ner',
          recognizer: 'test',
        },
        {
          entityType: 'CREDIT_CARD',
          start: 22,
          end: 41,
          score: 1,
          source: 'pattern',
          recognizer: 'test',
        },
      ],
    ],
  );
  return { session, messages: [{ role: 'user', content: masked.text }] };
}

async function rejection(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('LLM gateway', () => {
  // Blocked prompts are logged as errors by design; keep the test output clean.
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('streams an answer and reports usage the endpoint measured', async () => {
    const { gateway, provider } = setup();
    provider.scripts.push(provider.stream(delta('Hel'), delta('lo!'), done(40, 3)));
    const deltas: string[] = [];
    let admitted = 0;

    const result = await gateway.chat(request(ASK), {
      onAdmitted: () => {
        admitted += 1;
      },
      onDelta: (text) => deltas.push(text),
    });

    expect(result.text).toBe('Hello!');
    expect(deltas.join('')).toBe('Hello!');
    expect(admitted).toBe(1);
    expect(result.usage).toEqual({
      promptTokens: 40,
      completionTokens: 3,
      estimated: false,
    });
    expect(result.finishReason).toBe('stop');
    expect(provider.requests[0].contextWindow).toBe(8_192);
  });

  it('estimates usage when the endpoint does not report it', async () => {
    const { gateway, provider } = setup();
    provider.scripts.push(provider.stream(delta('Hello there.'), done()));
    const result = await gateway.chat(request(ASK));
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('calibrates the token estimator from reported counts', async () => {
    const { gateway, provider } = setup();
    const long: ChatMessage[] = [{ role: 'user', content: 'word '.repeat(200) }];
    provider.scripts.push(provider.stream(delta('ok'), done(400, 1)));
    await gateway.chat(request(long));
    expect(gateway.tokens.factorFor('m')).not.toBe(1.1);
  });

  it('refuses when no model endpoint is configured', async () => {
    const { gateway } = setup({ configured: false, baseUrl: '' });
    const error = await rejection(gateway.chat(request(ASK)));
    expect(error.code).toBe(ErrorCode.LLM_NOT_CONFIGURED);
    expect(error.getStatus()).toBe(503);
  });

  describe('privacy boundary', () => {
    it('unmasks placeholders for the user, even when split across tokens', async () => {
      const { gateway, provider } = setup();
      const { session, messages } = maskedPrompt();
      provider.scripts.push(
        provider.stream(
          delta('[PER'),
          delta('SON_1] uses card ['),
          delta('CREDIT_CARD_1].'),
          done(),
        ),
      );
      const deltas: string[] = [];

      const result = await gateway.chat(request(messages, { mode: 'masked', session }), {
        onDelta: (text) => deltas.push(text),
      });

      expect(provider.requests[0].messages[0].content).not.toContain('Ayesha');
      expect(result.maskedText).toBe('[PERSON_1] uses card [CREDIT_CARD_1].');
      expect(result.text).toBe('Ayesha Raza uses card 4111 1111 1111 1111.');
      expect(deltas.join('')).toBe(result.text);
      expect(deltas.some((text) => /\[[A-Z_]*$/.test(text))).toBe(false);
      expect(result.placeholders).toEqual({ resolved: 2, unresolved: 0 });
    });

    it('blocks a prompt in which a masked value survived, before anything is sent', async () => {
      const { gateway, provider, audits } = setup();
      const { session, messages } = maskedPrompt();
      const leaky: ChatMessage[] = [
        ...messages,
        { role: 'user', content: 'Also, Ayesha Raza asked.' },
      ];

      const error = await rejection(
        gateway.chat(request(leaky, { mode: 'masked', session })),
      );

      expect(error.code).toBe(ErrorCode.PII_EGRESS_BLOCKED);
      expect(error.details).toEqual({ entityTypes: ['PERSON'] });
      expect(provider.requests).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe(AuditAction.PII_EGRESS_BLOCKED);
      expect(JSON.stringify(audits[0])).not.toContain('Ayesha');
    });

    it('blocks sensitive data no stage ever detected, by re-scanning with the recognizers', async () => {
      const { gateway, provider } = setup();
      const { session } = maskedPrompt();
      const error = await rejection(
        gateway.chat(
          request([{ role: 'user', content: 'Charge 5500 0000 0000 0004 please.' }], {
            mode: 'masked',
            session,
          }),
        ),
      );
      expect(error.code).toBe(ErrorCode.PII_EGRESS_BLOCKED);
      expect(error.details).toEqual({ entityTypes: ['CREDIT_CARD'] });
      expect(provider.requests).toHaveLength(0);
    });

    it('removes a reasoning block before the user sees anything', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(
        provider.stream(
          delta('<think>The user wants'),
          delta(' a greeting.</think>\n\n'),
          delta('Hello!'),
          done(),
        ),
      );
      let thinking = 0;
      const result = await gateway.chat(request(ASK), {
        onThinking: () => (thinking += 1),
      });
      expect(result.text).toBe('Hello!');
      expect(result.reasoningRemoved).toBe(true);
      expect(thinking).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('retries a transient connection failure before the first token', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(
        provider.refuse(new LlmProviderError('SERVER_ERROR', 'HTTP 503', true, 503, 0)),
        provider.stream(delta('ok'), done()),
      );
      const result = await gateway.chat(request(ASK));
      expect(result.text).toBe('ok');
      expect(provider.requests).toHaveLength(2);
    });

    it('never retries once text has streamed, and keeps what was produced', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(
        provider.stream(delta('Half an ans'), {
          fail: new LlmProviderError('SERVER_ERROR', 'boom', true),
        }),
        provider.stream(delta('A different answer'), done()),
      );
      const error = await rejection(gateway.chat(request(ASK)));
      expect(error).toBeInstanceOf(GenerationInterruptedError);
      expect(error.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect((error as GenerationInterruptedError).partial.text).toBe('Half an ans');
      expect(provider.requests).toHaveLength(1);
    });

    it('maps a missing model to its own error without tripping the breaker', async () => {
      const { gateway, provider } = setup();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        provider.scripts.push(
          provider.refuse(new LlmProviderError('MODEL_NOT_FOUND', 'nope', false, 404)),
        );
        expect((await rejection(gateway.chat(request(ASK)))).code).toBe(
          ErrorCode.LLM_MODEL_NOT_FOUND,
        );
      }
      expect(gateway.circuit.state).toBe('CLOSED');
    });

    it('opens the circuit after repeated endpoint failures and then fails fast', async () => {
      const { gateway, provider } = setup({ maxRetries: 0 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        provider.scripts.push(
          provider.refuse(new LlmProviderError('UNREACHABLE', 'refused', true)),
        );
        expect((await rejection(gateway.chat(request(ASK)))).code).toBe(
          ErrorCode.LLM_UNAVAILABLE,
        );
      }
      const error = await rejection(gateway.chat(request(ASK)));
      expect(error.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect(error.details).toEqual({ reason: 'CIRCUIT_OPEN' });
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
      expect(provider.requests).toHaveLength(2);
    });

    it('ends a generation that produces nothing before the first-token deadline', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(provider.stream({ wait: 5_000 }, delta('too late'), done()));
      const error = await rejection(gateway.chat(request(ASK)));
      expect(error.code).toBe(ErrorCode.LLM_TIMEOUT);
      expect(error.getStatus()).toBe(504);
    });

    it('ends a generation that goes silent, keeping the partial answer', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(
        provider.stream(delta('Start of an answer'), { wait: 5_000 }, done()),
      );
      const error = await rejection(gateway.chat(request(ASK)));
      expect(error).toBeInstanceOf(GenerationInterruptedError);
      expect(error.code).toBe(ErrorCode.LLM_TIMEOUT);
      expect((error as GenerationInterruptedError).partial.text).toBe('Start of an answer');
    });

    it('stops generating when the client leaves, without blaming the endpoint', async () => {
      const { gateway, provider } = setup({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });
      const client = new AbortController();
      provider.scripts.push(provider.stream(delta('Partial'), { wait: 1_000 }, done()));

      const pending = gateway.chat(request(ASK, OFF, client.signal), {
        onDelta: () => client.abort(new Error('client left')),
      });
      const error = await rejection(pending);

      expect(error).toBeInstanceOf(GenerationInterruptedError);
      expect((error as GenerationInterruptedError).cancelled).toBe(true);
      expect((error as GenerationInterruptedError).partial.text).toBe('Partial');
      expect(gateway.circuit.state).toBe('CLOSED');
    });

    it('treats a stream that ends without completing as a failure', async () => {
      const { gateway, provider } = setup();
      provider.scripts.push(provider.stream(delta('Cut sho')));
      const error = await rejection(gateway.chat(request(ASK)));
      expect(error).toBeInstanceOf(GenerationInterruptedError);
      expect((error as GenerationInterruptedError).partial.text).toBe('Cut sho');
    });

    it('cuts off runaway output at the size ceiling instead of failing', async () => {
      const { gateway, provider } = setup();
      const small = { ...request(ASK), parameters: { temperature: 0, maxOutputTokens: 2 } };
      provider.scripts.push(
        provider.stream(...Array.from({ length: 20 }, () => delta('abcdefgh')), done()),
      );
      const result = await gateway.chat(small);
      expect(result.finishReason).toBe('length');
      expect(result.text.length).toBeLessThanOrEqual(2 * 16 + 8);
    });

    it('propagates a failing handler as itself, cancelling the stream', async () => {
      const { gateway, provider } = setup({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });
      provider.scripts.push(provider.stream(delta('x'), done()));
      const mine = new Error('socket closed');
      await expect(
        gateway.chat(request(ASK), {
          onAdmitted: () => {
            throw mine;
          },
        }),
      ).rejects.toBe(mine);
      expect(provider.cancelled).toBe(1);
      expect(gateway.circuit.state).toBe('CLOSED');
    });
  });

  describe('bulkhead', () => {
    it('admits up to its capacity and refuses the overflow as busy', async () => {
      const { gateway, provider } = setup({ maxConcurrency: 1, queueTimeoutMs: 30 });
      provider.scripts.push(provider.stream(delta('slow'), { wait: 100 }, done()));

      const first = gateway.chat(request(ASK));
      await sleep(10);
      expect(gateway.load).toEqual({ inUse: 1, waiting: 0, capacity: 1 });

      const second = await rejection(gateway.chat(request(ASK)));
      expect(second.code).toBe(ErrorCode.LLM_BUSY);
      expect(second.retryAfterSeconds).toBe(5);

      expect((await first).text).toBe('slow');
      expect(gateway.load.inUse).toBe(0);
    });

    it('lets a waiter through when a slot frees within the queue timeout', async () => {
      const { gateway, provider } = setup({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
      provider.scripts.push(
        provider.stream(delta('one'), { wait: 30 }, done()),
        provider.stream(delta('two'), done()),
      );
      const results = await Promise.all([
        gateway.chat(request(ASK)),
        gateway.chat(request(ASK)),
      ]);
      expect(results.map((result) => result.text)).toEqual(['one', 'two']);
    });

    it('does not take a slot for a prompt the egress check blocks', async () => {
      const { gateway } = setup({ maxConcurrency: 1 });
      const { session } = maskedPrompt();
      await rejection(
        gateway.chat(
          request([{ role: 'user', content: 'Ayesha Raza' }], { mode: 'masked', session }),
        ),
      );
      expect(gateway.load.inUse).toBe(0);
    });
  });
});
