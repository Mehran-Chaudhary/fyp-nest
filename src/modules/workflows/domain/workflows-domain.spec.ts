import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { StepFailure } from '../engine/engine-types';
import { classifyFailure } from '../engine/workflow-engine.service';
import { PrincipalRevokedError } from '../run-principal.service';
import { evaluateRule, ruleValue } from './conditions';
import { buildDeadLetterRecord } from './dead-letter';
import { validateGraph, type CompiledGraph, type GraphLimits } from './graph-validation';
import { jobMacKey, signStepJob, stepJobId, verifyStepJob } from './job-auth';
import { FailureClass, StepStatus } from './run-state';
import { schedule, visibleStep, type StepSnapshot } from './scheduler';
import {
  parseRef,
  renderTemplate,
  renderValue,
  TemplateError,
  type TemplateScope,
} from './templates';
import { reconstructTrace, type AuditLike } from './trace';

/**
 * The workflow engine's pure core (proposal modules 6.9 and 6.13): validating
 * a React Flow graph, deciding what runs next, templates and conditions,
 * authenticating queued jobs, and the two metadata-only artefacts a run leaves
 * behind — its dead letters and its audit trace.
 */

const LIMITS: GraphLimits = {
  maxNodes: 50,
  maxEdges: 150,
  maxLoopIterations: 10,
  maxSupervisorRounds: 12,
  maxSteps: 100,
  maxToolIterations: 8,
  maxStepTimeoutMs: 600_000,
  maxStepAttempts: 10,
};

const AGENT = '11111111-1111-4111-8111-111111111111';
const TOOL = '22222222-2222-4222-8222-222222222222';

type RawNode = { id: string; type: string; data?: Record<string, unknown> };
type RawEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
  data?: Record<string, unknown>;
};

function graph(nodes: RawNode[], edges: RawEdge[]) {
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => ({ data: {}, ...node })),
    edges: edges.map((edge, index) => ({ id: `e${index + 1}`, ...edge })),
  };
}

const agent = (id: string, data: Record<string, unknown> = {}): RawNode => ({
  id,
  type: 'agent',
  data: { agentId: AGENT, ...data },
});
const JSON_REVIEW = {
  format: 'json',
  schema: {
    type: 'object',
    properties: { approved: { type: 'boolean' }, notes: { type: 'string' } },
    required: ['approved'],
    additionalProperties: false,
  },
};

function compile(nodes: RawNode[], edges: RawEdge[]): CompiledGraph {
  const report = validateGraph(graph(nodes, edges), LIMITS);
  if (!report.compiled) throw new Error(JSON.stringify(report.errors));
  return report.compiled;
}

const codes = (nodes: RawNode[], edges: RawEdge[]) =>
  validateGraph(graph(nodes, edges), LIMITS).errors.map((error) => error.code);

describe('workflow graph validation', () => {
  const linear = (): [RawNode[], RawEdge[]] => [
    [{ id: 'start', type: 'trigger' }, agent('draft'), { id: 'out', type: 'output' }],
    [
      { source: 'start', target: 'draft' },
      { source: 'draft', target: 'out' },
    ],
  ];

  it('compiles a valid graph: order, step bound, references to check against the workspace', () => {
    const report = validateGraph(graph(...linear()), LIMITS);
    expect(report.valid).toBe(true);
    expect(report.compiled?.order).toEqual(['start', 'draft', 'out']);
    expect(report.compiled?.stepBound).toBe(3);
    expect(report.compiled?.references.agentIds).toEqual([AGENT]);
  });

  it('drops properties it does not know: what is stored is what is understood', () => {
    const [nodes, edges] = linear();
    nodes[1].data = { ...nodes[1].data, evil: '{{constructor}}', prompt: 'Hi' };
    const report = validateGraph(graph(nodes, edges), LIMITS);
    const stored = report.normalized?.nodes.find((node) => node.id === 'draft');
    expect(stored?.data).toEqual({ agentId: AGENT, prompt: 'Hi' });
  });

  it('requires one trigger and an output, and every node reachable', () => {
    expect(
      codes([agent('a'), { id: 'out', type: 'output' }], [{ source: 'a', target: 'out' }]),
    ).toContain('TRIGGER_MISSING');
    expect(
      codes(
        [{ id: 'start', type: 'trigger' }, agent('a')],
        [{ source: 'start', target: 'a' }],
      ),
    ).toContain('OUTPUT_MISSING');
    const [nodes, edges] = linear();
    expect(codes([...nodes, agent('island')], edges)).toContain('UNREACHABLE');
  });

  it('rejects a cycle that is not an explicit, bounded loop', () => {
    expect(
      codes(
        [
          { id: 'start', type: 'trigger' },
          agent('a'),
          agent('b'),
          { id: 'out', type: 'output' },
        ],
        [
          { source: 'start', target: 'a' },
          { source: 'a', target: 'b' },
          { source: 'b', target: 'a' },
          { source: 'b', target: 'out' },
        ],
      ),
    ).toContain('CYCLE');
  });

  const loopGraph = (maxIterations: number): [RawNode[], RawEdge[]] => [
    [
      { id: 'start', type: 'trigger' },
      agent('write', { prompt: 'Draft. Feedback: {{nodes.review.output.notes?}}' }),
      agent('review', { output: JSON_REVIEW, prompt: '{{nodes.write.output}}' }),
      {
        id: 'check',
        type: 'condition',
        data: {
          rules: [
            {
              id: 'rework',
              value: '{{nodes.review.output.approved}}',
              operator: 'is_false',
            },
          ],
        },
      },
      { id: 'out', type: 'output' },
    ],
    [
      { source: 'start', target: 'write' },
      { source: 'write', target: 'review' },
      { source: 'review', target: 'check' },
      {
        source: 'check',
        sourceHandle: 'rework',
        target: 'write',
        data: { loop: { maxIterations } },
      },
      { source: 'check', sourceHandle: 'else', target: 'out' },
    ],
  ];

  it('accepts a condition-controlled, bounded loop and bounds its steps', () => {
    const compiled = compile(...loopGraph(3));
    expect(compiled.loops).toEqual([
      expect.objectContaining({
        head: 'write',
        tail: 'check',
        ruleId: 'rework',
        maxIterations: 3,
      }),
    ]);
    // Three body nodes, each at most four times; the trigger and output once.
    expect(compiled.stepBound).toBe(3 * 4 + 2);
  });

  it('refuses a loop beyond the platform’s iteration ceiling', () => {
    expect(
      validateGraph(graph(...loopGraph(LIMITS.maxLoopIterations + 1)), LIMITS).valid,
    ).toBe(false);
  });

  it('checks every template reference: it must exist, come first, and have the field', () => {
    const [nodes, edges] = linear();
    nodes[1].data = { agentId: AGENT, prompt: 'Use {{nodes.out.output}}' };
    expect(codes(nodes, edges)).toContain('REFERENCE_NOT_ANCESTOR');
    nodes[1].data = { agentId: AGENT, prompt: 'Use {{nodes.ghost.output}}' };
    expect(codes(nodes, edges)).toContain('REFERENCE_UNKNOWN');

    const typed = (value: string) =>
      codes(
        [
          { id: 'start', type: 'trigger' },
          agent('review', { output: JSON_REVIEW }),
          agent('prose'),
          { id: 'out', type: 'output', data: { value } },
        ],
        [
          { source: 'start', target: 'review' },
          { source: 'review', target: 'prose' },
          { source: 'prose', target: 'out' },
        ],
      );
    expect(typed('{{nodes.review.output.approved}}')).toEqual([]);
    expect(typed('{{nodes.review.output.aproved}}')).toContain('TYPE_MISMATCH');
    expect(typed('{{nodes.review.output.approved.deeper}}')).toContain('TYPE_MISMATCH');
    expect(typed('{{nodes.prose.output.field}}')).toContain('TYPE_MISMATCH');
  });

  it('keeps passages for agents: a retrieval node cannot feed a tool', () => {
    expect(
      codes(
        [
          { id: 'start', type: 'trigger' },
          { id: 'find', type: 'retrieval', data: { query: '{{input.input}}' } },
          { id: 'act', type: 'tool', data: { toolId: TOOL, arguments: {} } },
          { id: 'out', type: 'output' },
        ],
        [
          { source: 'start', target: 'find' },
          { source: 'find', target: 'act' },
          { source: 'act', target: 'out' },
        ],
      ),
    ).toContain('TYPE_MISMATCH');
  });

  it('lets rules take any name except a condition’s own handles', () => {
    const withRule = (id: string) =>
      codes(
        [
          { id: 'start', type: 'trigger' },
          {
            id: 'gate',
            type: 'condition',
            data: { rules: [{ id, value: '{{input.input}}', operator: 'is_not_empty' }] },
          },
          { id: 'yes', type: 'output' },
          { id: 'no', type: 'output' },
        ],
        [
          { source: 'start', target: 'gate' },
          { source: 'gate', sourceHandle: id, target: 'yes' },
          { source: 'gate', sourceHandle: 'else', target: 'no' },
        ],
      );
    expect(withRule('approved')).toEqual([]);
    expect(withRule('else')).toContain('NODE_DATA_INVALID');
  });

  it('enforces size limits', () => {
    const many = Array.from({ length: LIMITS.maxNodes + 1 }, (_, index) =>
      agent(`a${index}`),
    );
    expect(codes(many, [])).toContain('LIMIT_EXCEEDED');
  });

  it('warns — without failing — when the worst case exceeds the step ceiling', () => {
    const report = validateGraph(graph(...loopGraph(10)), { ...LIMITS, maxSteps: 20 });
    expect(report.valid).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).toContain('STEP_BOUND');
  });
});

describe('scheduler', () => {
  const done = (
    nodeId: string,
    handles: string[] = ['out'],
    iteration = 0,
  ): StepSnapshot => ({
    nodeId,
    iteration,
    status: StepStatus.SUCCEEDED,
    handles,
  });

  it('runs a chain step by step, and settles when an output succeeds', () => {
    const compiled = compile(
      [{ id: 'start', type: 'trigger' }, agent('draft'), { id: 'out', type: 'output' }],
      [
        { source: 'start', target: 'draft' },
        { source: 'draft', target: 'out' },
      ],
    );
    const first = schedule(compiled, [done('start')]);
    expect(first.create).toEqual([
      {
        nodeId: 'draft',
        iteration: 0,
        status: StepStatus.QUEUED,
        predecessors: [{ nodeId: 'start', iteration: 0 }],
      },
    ]);
    expect(first.settled).toBe(false);
    // Recomputed from the whole state: calling again schedules nothing twice.
    const again = schedule(compiled, [
      done('start'),
      { ...done('draft'), status: StepStatus.QUEUED, handles: [] },
    ]);
    expect(again.create).toEqual([]);

    const end = schedule(compiled, [done('start'), done('draft'), done('out')]);
    expect(end).toEqual({ create: [], settled: true, succeeded: true });
  });

  it('eliminates dead paths below a branch not taken', () => {
    const compiled = compile(
      [
        { id: 'start', type: 'trigger' },
        {
          id: 'gate',
          type: 'condition',
          data: {
            rules: [{ id: 'big', value: '{{input.input}}', operator: 'is_not_empty' }],
          },
        },
        agent('handle'),
        { id: 'handled', type: 'output' },
        { id: 'ignored', type: 'output' },
      ],
      [
        { source: 'start', target: 'gate' },
        { source: 'gate', sourceHandle: 'big', target: 'handle' },
        { source: 'handle', target: 'handled' },
        { source: 'gate', sourceHandle: 'else', target: 'ignored' },
      ],
    );
    const outcome = schedule(compiled, [done('start'), done('gate', ['else'])]);
    const byNode = Object.fromEntries(
      outcome.create.map((step) => [step.nodeId, step.status]),
    );
    expect(byNode).toEqual({
      handle: StepStatus.SKIPPED,
      handled: StepStatus.SKIPPED,
      ignored: StepStatus.QUEUED,
    });
  });

  it('joins: a node with two inputs waits for both, and runs if either is live', () => {
    const compiled = compile(
      [
        { id: 'start', type: 'trigger' },
        agent('left'),
        agent('right'),
        agent('merge', {
          prompt: '{{nodes.left.output}} {{nodes.right.output}}',
        }),
        { id: 'out', type: 'output' },
      ],
      [
        { source: 'start', target: 'left' },
        { source: 'start', target: 'right' },
        { source: 'left', target: 'merge' },
        { source: 'right', target: 'merge' },
        { source: 'merge', target: 'out' },
      ],
    );
    expect(
      schedule(compiled, [done('start'), done('left')]).create.map((step) => step.nodeId),
    ).toEqual(['right']);
    const merged = schedule(compiled, [done('start'), done('left'), done('right')]);
    expect(merged.create[0]).toEqual(
      expect.objectContaining({ nodeId: 'merge', status: StepStatus.QUEUED }),
    );
    expect(merged.create[0].predecessors).toHaveLength(2);
  });

  it('follows an error edge instead of the normal one', () => {
    const compiled = compile(
      [
        { id: 'start', type: 'trigger' },
        agent('risky'),
        { id: 'ok', type: 'output' },
        { id: 'recover', type: 'output', data: { value: 'fallback' } },
      ],
      [
        { source: 'start', target: 'risky' },
        { source: 'risky', target: 'ok' },
        { source: 'risky', sourceHandle: 'error', target: 'recover' },
      ],
    );
    const outcome = schedule(compiled, [
      done('start'),
      { nodeId: 'risky', iteration: 0, status: StepStatus.FAILED, handles: ['error'] },
    ]);
    expect(Object.fromEntries(outcome.create.map((s) => [s.nodeId, s.status]))).toEqual({
      ok: StepStatus.SKIPPED,
      recover: StepStatus.QUEUED,
    });
  });

  describe('loops', () => {
    const compiled = compile(
      [
        { id: 'start', type: 'trigger' },
        agent('write'),
        {
          id: 'check',
          type: 'condition',
          data: {
            rules: [
              {
                id: 'again',
                value: '{{nodes.write.output}}',
                operator: 'contains',
                operand: 'TODO',
              },
            ],
          },
        },
        { id: 'out', type: 'output' },
      ],
      [
        { source: 'start', target: 'write' },
        { source: 'write', target: 'check' },
        {
          source: 'check',
          sourceHandle: 'again',
          target: 'write',
          data: { loop: { maxIterations: 2 } },
        },
        { source: 'check', sourceHandle: 'else', target: 'out' },
      ],
    );

    it('goes round again with the next iteration, while the exit waits', () => {
      const outcome = schedule(compiled, [
        done('start'),
        done('write'),
        done('check', ['again']),
      ]);
      expect(outcome.create).toEqual([
        {
          nodeId: 'write',
          iteration: 1,
          status: StepStatus.QUEUED,
          predecessors: [{ nodeId: 'check', iteration: 0 }],
        },
      ]);
    });

    it('stops at the loop’s own limit, and exits when the condition says so', () => {
      const round = (i: number) => [done('write', ['out'], i), done('check', ['again'], i)];
      const capped = schedule(compiled, [
        done('start'),
        ...round(0),
        ...round(1),
        ...round(2),
      ]);
      expect(capped.create.map((step) => `${step.nodeId}#${step.iteration}`)).not.toContain(
        'write#3',
      );

      const exit = schedule(compiled, [
        done('start'),
        ...round(0),
        done('write', ['out'], 1),
        done('check', ['else'], 1),
      ]);
      expect(exit.create).toEqual([
        expect.objectContaining({ nodeId: 'out', iteration: 0, status: StepStatus.QUEUED }),
      ]);
    });

    it('lets a step in the loop read this iteration’s value, or the previous one', () => {
      const steps = [done('start'), done('write', ['out'], 0), done('check', ['again'], 0)];
      expect(
        visibleStep(compiled, steps, { nodeId: 'check', iteration: 1 }, 'write')?.iteration,
      ).toBe(0);
      steps.push(done('write', ['out'], 1));
      expect(
        visibleStep(compiled, steps, { nodeId: 'check', iteration: 1 }, 'write')?.iteration,
      ).toBe(1);
    });
  });

  it('hands supervisor rounds to workers and leaves through "done"', () => {
    const compiled = compile(
      [
        { id: 'start', type: 'trigger' },
        { id: 'lead', type: 'supervisor', data: { strategy: 'round_robin', maxRounds: 3 } },
        agent('w1'),
        agent('w2'),
        { id: 'out', type: 'output' },
      ],
      [
        { source: 'start', target: 'lead' },
        { source: 'lead', sourceHandle: 'worker', target: 'w1' },
        { source: 'lead', sourceHandle: 'worker', target: 'w2' },
        { source: 'lead', sourceHandle: 'done', target: 'out' },
      ],
    );
    expect(compiled.stepBound).toBe(1 + 4 + 3 + 3 + 1);
    const assign = schedule(compiled, [done('start'), done('lead', ['worker:w1'])]);
    expect(assign.create).toEqual([
      expect.objectContaining({ nodeId: 'w1', iteration: 0, status: StepStatus.QUEUED }),
    ]);
    const next = schedule(compiled, [
      done('start'),
      done('lead', ['worker:w1']),
      done('w1'),
    ]);
    expect(next.create).toEqual([
      expect.objectContaining({
        nodeId: 'lead',
        iteration: 1,
        predecessors: [{ nodeId: 'w1', iteration: 0 }],
      }),
    ]);
    const finish = schedule(compiled, [
      done('start'),
      done('lead', ['worker:w1']),
      done('w1'),
      done('lead', ['done'], 1),
    ]);
    expect(finish.create).toEqual([
      expect.objectContaining({ nodeId: 'out', status: StepStatus.QUEUED }),
    ]);
  });
});

describe('templates and conditions', () => {
  const scope: TemplateScope = {
    input: { input: 'hello', count: 3, nested: { list: [{ name: 'first' }] } },
    nodes: { review: { output: { approved: true, score: '1,250.5' } } },
  };

  it('references data and nothing else', () => {
    expect(parseRef('nodes.review.output.approved')).toEqual({
      root: 'nodes',
      nodeId: 'review',
      path: ['approved'],
      optional: false,
    });
    expect(() => parseRef('process.env.SECRET')).toThrow(TemplateError);
    expect(() => parseRef('nodes.review.input')).toThrow(TemplateError);
    expect(() => renderTemplate('{{input.input', scope)).toThrow(TemplateError);
  });

  it('renders text and keeps types for a lone reference', () => {
    expect(renderTemplate('Say {{input.input}} x{{input.count}}', scope)).toEqual({
      text: 'Say hello x3',
      nodes: [],
      usedInput: true,
    });
    expect(renderTemplate('{{input.nested.list[0].name}}', scope).text).toBe('first');
    expect(renderValue({ n: '{{input.count}}', s: 'n={{input.count}}' }, scope)).toEqual({
      n: 3,
      s: 'n=3',
    });
  });

  it('fails on a missing value unless the reference is optional', () => {
    expect(() => renderTemplate('{{nodes.later.output}}', scope)).toThrow(TemplateError);
    expect(renderTemplate('[{{nodes.later.output?}}]', scope).text).toBe('[]');
  });

  it('reads own data only, never what an object inherits', () => {
    expect(() => renderTemplate('{{input.constructor}}', scope)).toThrow(TemplateError);
    expect(() => renderTemplate('{{nodes.review.output.toString}}', scope)).toThrow(
      TemplateError,
    );
  });

  it('evaluates rules deterministically', () => {
    const rule = (operator: string, value: string, operand?: string | number | boolean) => {
      const condition = { id: 'r', operator, value, operand } as Parameters<
        typeof evaluateRule
      >[0];
      return evaluateRule(condition, ruleValue(condition, scope));
    };
    expect(rule('is_true', '{{nodes.review.output.approved}}')).toBe(true);
    expect(rule('gt', '{{nodes.review.output.score}}', 1000)).toBe(true);
    expect(rule('equals', '{{input.count}}', 3)).toBe(true);
    expect(rule('contains', 'Hello World', 'world')).toBe(true);
    expect(rule('gt', '{{input.input}}', 1)).toBe(false);
    expect(rule('is_empty', '{{nodes.missing.output?}}')).toBe(true);
  });
});

describe('queued job authentication', () => {
  const runKey = Buffer.alloc(32, 9);
  const data = {
    organizationId: '33333333-3333-4333-8333-333333333333',
    runId: '44444444-4444-4444-8444-444444444444',
    stepId: '55555555-5555-4555-8555-555555555555',
    dispatch: 2,
    issuedAt: 1_700_000_000_000,
  };

  it('verifies a job signed with its run’s key', () => {
    const job = signStepJob(jobMacKey(runKey), data);
    expect(verifyStepJob(jobMacKey(runKey), job)).toBe(true);
    expect(stepJobId(data.stepId, 2)).toBe(`wfs_${data.stepId}_2`);
  });

  it('rejects a job that was redirected, replayed as another dispatch, or signed elsewhere', () => {
    const job = signStepJob(jobMacKey(runKey), data);
    for (const tampered of [
      { ...job, organizationId: '66666666-6666-4666-8666-666666666666' },
      { ...job, stepId: '77777777-7777-4777-8777-777777777777' },
      { ...job, dispatch: 3 },
      { ...job, issuedAt: job.issuedAt + 1 },
      { ...job, mac: 'AAAA' },
      { ...job, v: 2 as unknown as 1 },
    ]) {
      expect(verifyStepJob(jobMacKey(runKey), tampered)).toBe(false);
    }
    expect(verifyStepJob(jobMacKey(Buffer.alloc(32, 8)), job)).toBe(false);
  });
});

describe('dead-letter records', () => {
  const base = {
    sourceQueue: 'workflow-steps',
    jobId: 'wfs_55555555-5555-4555-8555-555555555555_1',
    organizationId: '33333333-3333-4333-8333-333333333333',
    workflowId: '88888888-8888-4888-8888-888888888888',
    workflowVersion: 4,
    runId: '44444444-4444-4444-8444-444444444444',
    stepId: '55555555-5555-4555-8555-555555555555',
    nodeId: 'research',
    nodeType: 'agent',
    iteration: 0,
    attempts: 3,
    failureCode: 'LLM_UNAVAILABLE',
    failureClass: FailureClass.TRANSIENT,
    retryable: true,
    firstAttemptAt: new Date('2026-01-01T00:00:00Z'),
    lastDurationMs: 1200,
    inputFingerprint: 'a'.repeat(64),
    inputBytes: 512,
  };

  it('keeps the metadata an operator needs', () => {
    const record = buildDeadLetterRecord(base);
    expect(record).toEqual(
      expect.objectContaining({
        kind: 'workflow-step',
        runId: base.runId,
        nodeId: 'research',
        failureCode: 'LLM_UNAVAILABLE',
        attempts: 3,
        firstAttemptAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  });

  it('has nowhere for content to hide: free text is replaced, never passed through', () => {
    const record = buildDeadLetterRecord({
      ...base,
      failureCode: 'Model said: Ayesha Raza earns 950,000',
      nodeId: 'Ayesha Raza',
      nodeType: 'agent; DROP TABLE',
      runId: 'not-a-uuid',
      inputFingerprint: 'Ayesha Raza',
      failureClass: 'Ayesha' as FailureClass,
    });
    expect(JSON.stringify(record)).not.toMatch(/Ayesha|950|DROP/);
    expect(record.failureCode).toBe('UNKNOWN');
    expect(record.failureClass).toBe(FailureClass.PERMANENT);
    expect(Object.keys(record).sort()).toEqual(
      [
        'kind',
        'sourceQueue',
        'jobId',
        'organizationId',
        'workflowId',
        'workflowVersion',
        'runId',
        'stepId',
        'nodeId',
        'nodeType',
        'iteration',
        'attempts',
        'failureCode',
        'failureClass',
        'retryable',
        'firstAttemptAt',
        'deadLetteredAt',
        'lastDurationMs',
        'inputFingerprint',
        'inputBytes',
        'agentId',
        'agentVersion',
        'toolId',
        'toolVersion',
      ].sort(),
    );
  });
});

describe('trace reconstruction from the audit log', () => {
  const RUN = 'run-1';
  let sequence = 0;
  const record = (
    action: string,
    metadata: Record<string, unknown>,
    actorId: string | null = null,
  ): AuditLike => ({
    sequence: (sequence += 1),
    action,
    status: 'SUCCESS',
    actorId,
    resourceId: null,
    metadata: { runId: RUN, ...metadata },
  });
  const step = (stepId: string, nodeId: string, extra: Record<string, unknown> = {}) =>
    record('workflow.step.completed', {
      stepId,
      nodeId,
      nodeType: nodeId === 'start' ? 'trigger' : 'agent',
      iteration: 0,
      attempt: 1,
      status: 'SUCCEEDED',
      final: true,
      handles: ['out'],
      ...extra,
    });

  const complete = (): AuditLike[] => {
    sequence = 0;
    return [
      record(
        'workflow.execution.started',
        { workflowId: 'wf', workflowVersion: 2, definitionDigest: 'abc' },
        'user-1',
      ),
      step('s0', 'start'),
      record('tool.executed', { stepId: 's1', executionId: 'x1', toolName: 'calculator' }),
      step('s1', 'research', {
        predecessors: ['start#0'],
        agentId: 'agent-1',
        tokens: 120,
      }),
      step('s2', 'out', { predecessors: ['research#0'] }),
      record('workflow.execution.completed', {
        status: 'COMPLETED',
        steps: 3,
        skipped: [],
      }),
    ];
  };

  it('rebuilds a complete run: who started it, every step, its edges and tool calls', () => {
    const trace = reconstructTrace(RUN, complete());
    expect(trace.complete).toBe(true);
    expect(trace.startedBy).toBe('user-1');
    expect(trace.finalStatus).toBe('COMPLETED');
    expect(trace.edges).toEqual([
      { from: 'start#0', to: 'research#0' },
      { from: 'research#0', to: 'out#0' },
    ]);
    expect(trace.steps.find((s) => s.nodeId === 'research')?.toolCalls).toEqual([
      { executionId: 'x1', tool: 'calculator', outcome: 'executed' },
    ]);
  });

  it('notices a gap: a missing step record makes the trace incomplete', () => {
    const records = complete().filter(
      (entry) =>
        !(entry.action === 'workflow.step.completed' && entry.metadata.stepId === 's1'),
    );
    const trace = reconstructTrace(RUN, records);
    expect(trace.complete).toBe(false);
    expect(trace.problems.join(' ')).toMatch(/research#0|settled step records/);
  });

  it('does not count a retry that never settled, and counts resumptions', () => {
    const records = complete();
    records.splice(
      4,
      0,
      record('workflow.step.failed', {
        stepId: 's9',
        nodeId: 'side',
        nodeType: 'agent',
        iteration: 0,
        attempt: 1,
        final: false,
        predecessors: ['start#0'],
      }),
      record('workflow.execution.resumed', { previousStatus: 'FAILED' }),
    );
    const trace = reconstructTrace(RUN, records);
    expect(trace.complete).toBe(true);
    expect(trace.resumptions).toBe(1);
    expect(trace.steps.find((s) => s.nodeId === 'side')?.status).toBe('RETRYING');
  });

  it('ignores other runs’ records', () => {
    const records = complete();
    records.push({ ...records[1], metadata: { ...records[1].metadata, runId: 'run-2' } });
    expect(reconstructTrace(RUN, records).complete).toBe(true);
  });
});

describe('failure classification', () => {
  const app = (code: ErrorCode, status: HttpStatus) => new AppException(code, status);

  it('retries what may succeed later, and nothing else', () => {
    expect(
      classifyFailure(app(ErrorCode.LLM_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE)),
    ).toEqual({
      code: ErrorCode.LLM_UNAVAILABLE,
      failureClass: FailureClass.TRANSIENT,
    });
    expect(
      classifyFailure(app(ErrorCode.LLM_TIMEOUT, HttpStatus.GATEWAY_TIMEOUT)).failureClass,
    ).toBe(FailureClass.TIMEOUT);
    expect(
      classifyFailure(app(ErrorCode.PII_EGRESS_BLOCKED, HttpStatus.UNPROCESSABLE_ENTITY))
        .failureClass,
    ).toBe(FailureClass.POLICY);
    expect(
      classifyFailure(app(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST))
        .failureClass,
    ).toBe(FailureClass.PERMANENT);
    expect(
      classifyFailure(app(ErrorCode.VALIDATION_FAILED, HttpStatus.TOO_MANY_REQUESTS))
        .failureClass,
    ).toBe(FailureClass.TRANSIENT);
  });

  it('keeps the engine’s own verdicts, and treats the unexpected as transient', () => {
    expect(
      classifyFailure(
        new StepFailure(ErrorCode.WORKFLOW_TEMPLATE_ERROR, FailureClass.PERMANENT, 'x'),
      ),
    ).toEqual({
      code: ErrorCode.WORKFLOW_TEMPLATE_ERROR,
      failureClass: FailureClass.PERMANENT,
    });
    expect(classifyFailure(new PrincipalRevokedError('gone')).failureClass).toBe(
      FailureClass.POLICY,
    );
    expect(classifyFailure(new Error('connection reset'))).toEqual({
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      failureClass: FailureClass.TRANSIENT,
    });
  });
});
