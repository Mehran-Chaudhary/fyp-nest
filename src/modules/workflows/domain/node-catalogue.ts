import { CONDITION_OPERATORS, HANDLE, type NodeType } from './graph';

/**
 * What the canvas palette shows for each node type: its purpose, the handles
 * edges may leave from, what it produces, and its configuration fields. Served
 * by `GET …/workflows/node-types`, so the frontend's palette and the backend's
 * validation cannot drift apart.
 */
export interface NodeTypeDescriptor {
  type: NodeType;
  label: string;
  description: string;
  /** Handles edges may leave from. `rule:<id>` means one handle per condition rule. */
  outputs: string[];
  /** What `{{nodes.<id>.output}}` holds. */
  produces: 'json' | 'text' | 'passages' | 'none' | 'text-or-json';
  /** Whether more than one of this type may exist. */
  multiple: boolean;
  fields: Array<{
    name: string;
    type:
      | 'uuid'
      | 'string'
      | 'template'
      | 'integer'
      | 'boolean'
      | 'enum'
      | 'object'
      | 'array'
      | 'json-schema';
    required: boolean;
    description: string;
    options?: readonly string[];
  }>;
}

const timing = [
  {
    name: 'timeoutMs',
    type: 'integer' as const,
    required: false,
    description: 'Step timeout, up to WORKFLOW_STEP_TIMEOUT.',
  },
  {
    name: 'retry',
    type: 'object' as const,
    required: false,
    description:
      '{ maxAttempts, backoffMs }: transient failures are retried with jittered exponential backoff.',
  },
];

export const NODE_CATALOGUE: readonly NodeTypeDescriptor[] = [
  {
    type: 'trigger',
    label: 'Trigger',
    description: 'Where a run starts. Its output is the run input.',
    outputs: [HANDLE.OUT],
    produces: 'json',
    multiple: false,
    fields: [
      {
        name: 'inputSchema',
        type: 'json-schema',
        required: false,
        description: 'The run input’s shape. Default: { "input": string }.',
      },
    ],
  },
  {
    type: 'agent',
    label: 'Agent',
    description:
      'Runs an agent on a task: retrieval through its knowledge bases, its granted tools, masking at the model boundary — all as the person who started the run.',
    outputs: [HANDLE.OUT, HANDLE.ERROR],
    produces: 'text-or-json',
    multiple: true,
    fields: [
      { name: 'agentId', type: 'uuid', required: true, description: 'The agent.' },
      {
        name: 'prompt',
        type: 'template',
        required: false,
        description:
          'The task, e.g. "Summarise {{nodes.research.output}}". Default: the input it receives.',
      },
      {
        name: 'useTools',
        type: 'boolean',
        required: false,
        description: 'Offer the agent’s granted tools. Default true.',
      },
      {
        name: 'maxToolIterations',
        type: 'integer',
        required: false,
        description: 'Tool calls this step may make, up to the agent’s own limit.',
      },
      {
        name: 'output',
        type: 'object',
        required: false,
        description:
          '{ "format": "text" } or { "format": "json", "schema": {…} } for fields later nodes can branch on.',
      },
      ...timing,
    ],
  },
  {
    type: 'tool',
    label: 'Tool',
    description:
      'Calls a tool directly with templated arguments. Place it after an approval node for tools that require approval.',
    outputs: [HANDLE.OUT, HANDLE.ERROR],
    produces: 'json',
    multiple: true,
    fields: [
      { name: 'toolId', type: 'uuid', required: true, description: 'The tool.' },
      {
        name: 'arguments',
        type: 'object',
        required: true,
        description:
          'Literal JSON or templates; "{{nodes.a.output.count}}" keeps its type.',
      },
      ...timing,
    ],
  },
  {
    type: 'retrieval',
    label: 'Knowledge source',
    description:
      'Searches knowledge bases as the run’s initiator. Connect it to an agent, which reads the passages as reference material.',
    outputs: [HANDLE.OUT, HANDLE.ERROR],
    produces: 'passages',
    multiple: true,
    fields: [
      {
        name: 'query',
        type: 'template',
        required: true,
        description: 'What to search for.',
      },
      {
        name: 'knowledgeBaseIds',
        type: 'array',
        required: false,
        description: 'Narrow the search to these bases.',
      },
      { name: 'topK', type: 'integer', required: false, description: '1–20 passages.' },
    ],
  },
  {
    type: 'condition',
    label: 'Condition',
    description:
      'Branches on data: the first matching rule’s handle is taken, else "else". A rule’s edge may loop back to an earlier node, with a maximum number of iterations.',
    outputs: ['rule:<id>', HANDLE.ELSE],
    produces: 'json',
    multiple: true,
    fields: [
      {
        name: 'rules',
        type: 'array',
        required: true,
        description: '[{ id, value: template, operator, operand?, caseSensitive? }]',
      },
      {
        name: 'rules[].operator',
        type: 'enum',
        required: true,
        description: 'How to compare.',
        options: CONDITION_OPERATORS,
      },
    ],
  },
  {
    type: 'supervisor',
    label: 'Supervisor',
    description:
      'Coordinates a team of agents (its "worker" edges): each round it chooses who acts next and what they should do, until the goal is met or the rounds run out.',
    outputs: [HANDLE.WORKER, HANDLE.DONE, HANDLE.ERROR],
    produces: 'text',
    multiple: true,
    fields: [
      {
        name: 'strategy',
        type: 'enum',
        required: true,
        description: 'llm: a model decides. round_robin: each worker in turn.',
        options: ['llm', 'round_robin'],
      },
      {
        name: 'agentId',
        type: 'uuid',
        required: false,
        description: 'Persona for the supervisor’s decisions.',
      },
      {
        name: 'goal',
        type: 'template',
        required: false,
        description: 'The team’s goal. Default: the input it receives.',
      },
      {
        name: 'maxRounds',
        type: 'integer',
        required: true,
        description: 'Worker turns at most, up to WORKFLOW_MAX_SUPERVISOR_ROUNDS.',
      },
    ],
  },
  {
    type: 'approval',
    label: 'Approval',
    description:
      'Pauses the run until a member with workflow:approve (and clearance for the data) decides. Whoever started the run cannot approve it, unless allowed.',
    outputs: [HANDLE.APPROVED, HANDLE.REJECTED],
    produces: 'json',
    multiple: true,
    fields: [
      {
        name: 'message',
        type: 'template',
        required: false,
        description: 'What approvers are asked.',
      },
      {
        name: 'timeoutMs',
        type: 'integer',
        required: false,
        description: 'Default WORKFLOW_APPROVAL_TIMEOUT.',
      },
      {
        name: 'onTimeout',
        type: 'enum',
        required: false,
        description: 'Default reject.',
        options: ['reject', 'approve'],
      },
      {
        name: 'allowSelfApproval',
        type: 'boolean',
        required: false,
        description: 'Default false (separation of duties).',
      },
    ],
  },
  {
    type: 'output',
    label: 'Output',
    description: 'The run’s result. A run completes when an output node is reached.',
    outputs: [],
    produces: 'none',
    multiple: true,
    fields: [
      {
        name: 'value',
        type: 'template',
        required: false,
        description: 'Default: its predecessor’s output.',
      },
    ],
  },
];
