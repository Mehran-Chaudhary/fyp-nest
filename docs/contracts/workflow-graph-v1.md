# Workflow graph contract, v1

The JSON a workflow is made of. The Interactive Workflow Canvas (proposal
module 6.13, React Flow) produces it; the backend validates, stores,
versions and executes it. This document is the specification; the TypeScript
side lives in `src/modules/workflows/domain/` (`graph.ts`,
`graph-validation.ts`, `templates.ts`, `scheduler.ts`). Design rationale:
[ADR 0004](../adr/0004-orchestration-tools-realtime.md).

Conventions:

- The shape is React Flow's own, so the canvas can save and load its state
  directly: nodes carry `id`, `type`, `position` and `data`; edges carry
  `source`, `target` and optional `sourceHandle`.
- The server **drops properties it does not know**. What is stored — and
  returned from `GET …/workflows/{id}` — is what was understood; the canvas
  should reload from it after saving.
- `POST /v1/organizations/{org}/workflows/validate` returns the full report
  (`valid`, `errors`, `warnings`, `stepBound`) without saving; the canvas can
  call it as the user edits.
- `GET /v1/organizations/{org}/workflows/node-types` returns the node
  catalogue: each type's fields, handles and defaults, for building the
  palette and the property panels.

---

## The document

```json
{
  "schemaVersion": 1,
  "nodes": [ /* Node */ ],
  "edges": [ /* Edge */ ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

`viewport` and every node's `position` and `label` are canvas state: stored,
never interpreted. Limits: `WORKFLOW_MAX_NODES` nodes (default 50) and
`WORKFLOW_MAX_EDGES` edges (default 150).

### Node

```json
{ "id": "research", "type": "agent", "label": "Research", "position": { "x": 240, "y": 80 }, "data": { … } }
```

`id`: 1–64 characters of letters, digits, `-` and `_`, unique in the graph.
Templates refer to nodes by id, so keep ids readable.

### Edge

```json
{ "id": "e1", "source": "research", "target": "review", "sourceHandle": "out" }
```

- `sourceHandle` says **which outcome** of the source the edge follows (below).
  Absent or empty means `out`. `targetHandle` is accepted and ignored.
- `data.loop` makes the edge a loop back edge (see *Loops*).
- Duplicate edges (same source, handle and target) are rejected.

---

## Node types

Each type lists its `data` fields and the source handles it can take. A field
marked *template* may contain references (see *Templates*).

### `trigger` — how a run starts (exactly one)

| Field | Type | |
|---|---|---|
| `inputSchema` | JSON Schema (object) | What a run's input must look like. Default `{ "input": string }` (1–32,000 characters). See *Tool schemas* for the dialect; `default`s are applied. |

Handles: `out`. Nothing may connect into a trigger. Its output is the run's
input object.

### `agent` — one task for an agent

| Field | Type | |
|---|---|---|
| `agentId` | UUID, required | An agent of this workspace the editor can use. |
| `prompt` | template, ≤ 8,000 | The task. Default: the run input's `input` field for an agent fed by the trigger, otherwise the text of its predecessors' outputs. |
| `useTools` | boolean | Offer the agent's granted tools. Default `true`. |
| `maxToolIterations` | 1–`TOOL_MAX_ITERATIONS` | Lower than the agent's own limit only. |
| `output` | `{ "format": "text" }` or `{ "format": "json", "schema": JSON Schema }` | Structured output: the answer must validate against the schema (one repair attempt), and later nodes can read its fields. |
| `timeoutMs` | 1,000–`WORKFLOW_STEP_TIMEOUT` | |
| `retry` | `{ "maxAttempts": 1–10, "backoffMs": 0–3,600,000 }` | Transient failures only. |

Handles: `out`, `error`. Retrieval predecessors contribute their passages as
reference material, labelled and masked like any retrieved text.

### `tool` — one tool call, arguments from templates

| Field | Type | |
|---|---|---|
| `toolId` | UUID, required | A built-in or workspace tool. |
| `arguments` | object, ≤ 16,000 bytes of JSON | Literal values or templates. A string that is **exactly one** reference keeps the referenced value's type: `"{{input.count}}"` passes a number. |
| `timeoutMs`, `retry` | as for `agent` | |

Handles: `out`, `error`. A tool that requires approval runs only after an
`approval` node that was approved.

### `retrieval` — search knowledge bases as the run's initiator

| Field | Type | |
|---|---|---|
| `query` | template, ≤ 2,000, required | |
| `knowledgeBaseIds` | UUID[], ≤ 20 | Narrow the search; the initiator must be able to read each. |
| `topK` | 1–20 | Default 8. |

Handles: `out`, `error`. Its output may flow only into agents (as passages) and
templates; a retrieval → tool edge is rejected.

### `condition` — deterministic branching

| Field | Type | |
|---|---|---|
| `rules` | 1–20 of `{ id, value, operator, operand?, caseSensitive? }` | Evaluated in order; the first match wins; none matching takes `else`. |

- `id`: a letter then letters, digits, `-`, `_` (≤ 32). Not `else`, `error` or
  `out`. It is also the **handle** of the edge taken when the rule matches.
- `value`: a template — what is tested.
- `operand`: a string, number or boolean. `gt`, `gte`, `lt` and `lte` require a
  **number** (`100`, not `"100"`); the unary operators take none. A rule that
  breaks this is dropped, so its handle is then reported invalid too.
- `operator`: `equals`, `not_equals`, `contains`, `not_contains`,
  `starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `is_true`, `is_false`,
  `is_empty`, `is_not_empty`.
- Text comparisons are case-insensitive unless `caseSensitive`. Numeric
  comparisons accept `1,250.5`. `is_true` also matches `yes`, `y`, `1`.
  `is_empty` matches missing values, `""`, `[]`, `{}`.

Handles: each rule's `id`, and `else`.

### `supervisor` — a team of agents (Supervisor pattern)

| Field | Type | |
|---|---|---|
| `strategy` | `llm` or `round_robin` | `llm`: a model decides who acts next, or that the goal is met. |
| `agentId` | UUID | Persona for the decisions (`llm`); default a neutral router. |
| `goal` | template, ≤ 8,000 | Default: the supervisor's inputs. |
| `maxRounds` | 1–`WORKFLOW_MAX_SUPERVISOR_ROUNDS` | Default 3. |

Handles: `worker` (one edge to each worker agent), `error`, and `done` (leaving the
team). Each round is a step; the chosen worker's task is the supervisor's
instruction (plus the worker node's own `prompt`, if any).

Rules: workers are `agent` nodes connected **only** by that one `worker` edge
— no other incoming or outgoing edges; their result goes back to the
supervisor. An agent works for one supervisor.

### `approval` — a person decides

| Field | Type | |
|---|---|---|
| `message` | template, ≤ 4,000 | What approvers are asked. Shown to approvers cleared for its label. |
| `timeoutMs` | 60,000–2,592,000,000 | Default `WORKFLOW_APPROVAL_TIMEOUT`. |
| `onTimeout` | `reject` (default) or `approve` | |
| `allowSelfApproval` | boolean | Default `false`: whoever started the run cannot approve it. |

Handles: `approved`, `rejected`. Decided with
`POST …/workflow-runs/{run}/steps/{step}/approval` (`workflow:approve`).

### `output` — the run's result (at least one)

| Field | Type | |
|---|---|---|
| `value` | template, ≤ 8,000 | Default: the predecessor's output (several predecessors: an object keyed by node id). |

The run's output is the value of its output node; with several output nodes,
an object keyed by the ids of those that ran.

---

## Handles at a glance

| Node | Source handles |
|---|---|
| trigger | `out` |
| agent, tool | `out`, `error` |
| retrieval | `out`, `error` |
| condition | each rule `id`, `else` |
| supervisor | `worker` (to each worker), `done`, `error` |
| approval | `approved`, `rejected` |
| output | none |

---

## Templates

A template references data and does nothing else — no expressions, no
function calls:

| Reference | Resolves to |
|---|---|
| `{{input}}`, `{{input.a.b}}` | the run input, or a field of it |
| `{{nodes.<id>.output}}` | that node's output (table below) |
| `{{nodes.<id>.output.a.b}}`, `{{nodes.<id>.output.items[0]}}` | a field or element of it |
| `{{…?}}` (trailing `?`) | optional: renders as empty when there is no value yet — for a loop's first iteration |

- A reference must name an **ancestor**: a node that always runs before this
  one. Referring to a later node in the same loop requires `?`.
- A path into an agent's JSON output must exist in its output schema
  (an error when the schema forbids it, a warning when it merely does not
  declare it). A path into a plain-text output is an error.
- Paths read the data's own fields only (`constructor` and the like never
  resolve), at most 8 segments.
- A missing value fails the step with `WORKFLOW_TEMPLATE_ERROR` (permanent)
  unless the reference is optional.
- Inside text, non-string values render as JSON.

What each node's output is:

| Node | `{{nodes.<id>.output}}` |
|---|---|
| trigger | the run input object |
| agent | its answer: a string, or the JSON value its output schema describes |
| tool | the tool's structured result, or its text when it has none. Built-ins: `calculator` → a number; `current_datetime` → `{ iso, timeZone, formatted }`; `knowledge_search` → `{ passages: [{ documentTitle, text, classification, score, … }] }`; `send_email` → `{ delivered }`. HTTP tools → the parsed JSON response (at the tool's `responsePath`), or its text |
| retrieval | `[{ title, text, classification, documentId, knowledgeBaseId, score }]` |
| condition | `{ handle, matchedRule }` |
| supervisor | when it finishes: the last worker's output |
| approval | `{ decision: "approved" \| "rejected", decidedBy: "person" \| "timeout" }` |
| output | its value |

Every value read carries its information-flow label into the step that reads
it: a template that reads a CONFIDENTIAL passage makes that step's output
CONFIDENTIAL.

---

## Loops

A cycle is allowed only as an explicit **back edge**:

```json
{ "id": "again", "source": "check", "sourceHandle": "rework", "target": "draft",
  "data": { "loop": { "maxIterations": 3, "onExhausted": "fall_through" } } }
```

- It leaves a `condition` node's rule handle, and the rule decides each time
  whether to go round again.
- `maxIterations` ≤ `WORKFLOW_MAX_LOOP_ITERATIONS` (default 10): the body runs
  at most `maxIterations + 1` times.
- `onExhausted`: `fall_through` (default) evaluates the condition as if that
  rule did not exist, so the run leaves the loop; `fail` fails the run with
  `WORKFLOW_LOOP_EXHAUSTED`.
- The loop's body (from the back edge's target to the condition) must be a
  single-entry, single-exit region: nothing enters it except through its head,
  and edges leave it only from the condition.
- Everything that is not a loop back edge must be acyclic (`CYCLE`).

Independently of all loop limits, a run stops at its **step ceiling**
(`WORKFLOW_MAX_STEPS`, or the workflow's lower `settings.maxSteps`) and its
**token budget** (`settings.maxTokens`): `WORKFLOW_STEP_LIMIT_EXCEEDED`,
`WORKFLOW_TOKEN_BUDGET_EXCEEDED`, audited as `agent.circuit_broken`.

---

## How a run executes

- A node runs once **all** its incoming edges are resolved (their sources
  finished) and **at least one** is live — its source took that handle.
- All resolved and none live: the node is **skipped**, and so is everything
  below it (dead-path elimination). A run completes when nothing is left and
  at least one output node succeeded (`WORKFLOW_NO_OUTPUT` otherwise).
- A step that fails **transiently** (model busy or down, a dependency
  unavailable, a timeout) is retried with jittered exponential backoff up to
  `retry.maxAttempts` (default `WORKFLOW_STEP_MAX_ATTEMPTS`); a **policy** or
  **permanent** failure is not retried. A step that fails for good follows its
  `error` edge if it has one; otherwise the run fails. Either way a
  metadata-only record goes to the dead-letter queue.
- Every step acts as the run's initiator, re-checked before it starts.
- Statuses — run: `RUNNING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`,
  `CANCELLED`, `TIMED_OUT`; step: `QUEUED`, `RUNNING`, `WAITING_APPROVAL`,
  `SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELLED`.

### Settings

`PUT …/workflows/{id}/definition` (and `POST …/workflows`) accept
`settings`, which can only lower the platform's ceilings:

| Setting | Range |
|---|---|
| `maxSteps` | 2 – `WORKFLOW_MAX_STEPS` |
| `maxTokens` | 1,000 – `WORKFLOW_MAX_TOKENS_PER_RUN` |
| `runTimeoutMs` | 1,000 – `WORKFLOW_RUN_TIMEOUT` |

---

## Validation errors

Returned as `{ code, message, nodeId?, edgeId? }`. Errors make a definition
invalid (it can be saved as a draft, never published or run); warnings do not.

| Code | Meaning |
|---|---|
| `GRAPH_INVALID`, `GRAPH_VERSION` | Not a graph document, or an unsupported `schemaVersion`. |
| `LIMIT_EXCEEDED` | Too many nodes or edges. |
| `NODE_INVALID`, `NODE_ID_INVALID`, `NODE_DUPLICATE`, `NODE_TYPE_UNKNOWN`, `NODE_DATA_INVALID` | A node's shape, id, type or `data`. |
| `EDGE_INVALID`, `EDGE_DANGLING`, `EDGE_DUPLICATE`, `HANDLE_INVALID` | An edge's shape, endpoints, or a handle its source does not have. |
| `TRIGGER_MISSING`, `TRIGGER_MULTIPLE`, `OUTPUT_MISSING` | Exactly one trigger, at least one output. |
| `SUPERVISOR_INVALID` | Workers missing, not agents, shared, or connected to anything but their supervisor. |
| `LOOP_INVALID`, `CYCLE` | A back edge breaking the loop rules; a cycle that is not a loop. |
| `UNREACHABLE` | Nothing leads to this node from the trigger. |
| `TEMPLATE_INVALID`, `REFERENCE_UNKNOWN`, `REFERENCE_NOT_ANCESTOR` | A template that does not parse, names no node, or names one that does not run first. |
| `TYPE_MISMATCH` | Passages into a tool; a field read from plain text; a field an output schema rules out. |
| `REFERENCE_UNKNOWN` | An agent, tool or knowledge base the graph names does not exist in this workspace, or you cannot use it (checked against the editor's own access). |
| `REFERENCE_FORBIDDEN`, `REFERENCE_DISABLED` | Tools need `tool:read` to be placed in a workflow; a disabled tool cannot be. |
| `TOOL_ARGUMENT_MISSING`, `TOOL_ARGUMENT_INVALID` | A tool node's literal arguments leave out a required parameter or break the tool's schema (template values are checked when the step runs). |
| *warning* `DEAD_END` | Nothing this node produces reaches an output (fine for a side effect). |
| *warning* `STEP_BOUND` | The worst case exceeds the step ceiling; such a run will be stopped. |
| *warning* `INPUT_FIELD_UNKNOWN` | A template reads an input field the trigger's schema does not declare. |
| *warning* `TYPE_MISMATCH` | A field an agent's output schema does not declare (probably a typo). |

---

## Tool schemas

Tool parameters, trigger input schemas and agent output schemas use a
**strict subset of JSON Schema (2020-12)**: every keyword accepted is
enforced, and every keyword not enforced is **rejected** — a schema that looks
like it constrains arguments while constraining nothing is refused.

| Accepted | Notes |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`, or an array of these. Required on every schema unless `enum`/`const` is given. A tool's parameters must be `"type": "object"`. |
| `title`, `description` | ≤ 1,000 characters. Descriptions are shown to the model. |
| `enum` (≤ 100 values), `const`, `default` | `default`s are filled for absent properties. |
| `minLength`, `maxLength` (≤ 100,000) | Counted in characters (code points). |
| `format` | `email`, `uri` (http/https), `uuid`, `date`, `date-time` — fixed, linear-time checks. |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` | |
| `properties`, `required`, `additionalProperties` (boolean only) | Property names: identifiers of ≤ 64 characters; `__proto__`, `constructor`, `prototype` are refused. ≤ 100 properties in total. |
| `items` (one schema), `minItems`, `maxItems`, `uniqueItems` | Arrays must declare `items`. |
| `$schema`, `examples` | Tolerated, not used. |

Rejected: `$ref`/`$defs` (no references, no remote fetches), `pattern` and
`patternProperties` (user-supplied regular expressions run against
model-written text are a ReDoS vector — use `format` or `enum`),
`oneOf`/`anyOf`/`allOf`/`not`/`if` (composition), and anything else not
listed. Nesting is limited to 6 levels.

---

## Example: draft, review, revise, sign off

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "start", "type": "trigger", "data": {} },
    { "id": "draft", "type": "agent",
      "data": { "agentId": "…", "prompt": "Write a policy summary for: {{input.input}}\nReviewer notes: {{nodes.review.output.notes?}}" } },
    { "id": "review", "type": "agent",
      "data": { "agentId": "…", "prompt": "Review this draft:\n{{nodes.draft.output}}",
                "output": { "format": "json", "schema": {
                  "type": "object",
                  "properties": { "approved": { "type": "boolean" }, "notes": { "type": "string" } },
                  "required": ["approved", "notes"], "additionalProperties": false } } } },
    { "id": "check", "type": "condition",
      "data": { "rules": [ { "id": "rework", "value": "{{nodes.review.output.approved}}", "operator": "is_false" } ] } },
    { "id": "signoff", "type": "approval", "data": { "message": "Publish this summary?\n\n{{nodes.draft.output}}" } },
    { "id": "published", "type": "output", "data": { "value": "{{nodes.draft.output}}" } },
    { "id": "shelved", "type": "output", "data": { "value": "Not published." } }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "draft" },
    { "id": "e2", "source": "draft", "target": "review" },
    { "id": "e3", "source": "review", "target": "check" },
    { "id": "e4", "source": "check", "sourceHandle": "rework", "target": "draft",
      "data": { "loop": { "maxIterations": 2 } } },
    { "id": "e5", "source": "check", "sourceHandle": "else", "target": "signoff" },
    { "id": "e6", "source": "signoff", "sourceHandle": "approved", "target": "published" },
    { "id": "e7", "source": "signoff", "sourceHandle": "rejected", "target": "shelved" }
  ]
}
```
