# ADR 0004: Orchestration, tools and real-time events

**Status:** Accepted · **Date:** 2026-09-26 · **Phase:** 4

---

## Context

Phase 4 turns individual agents into collaborating ones. Four proposal modules
are involved: the Multi-Agent Workflow Engine (6.9), the Tool Execution Engine
(6.11), the backend half of the Interactive Workflow Canvas (6.13), and the
Real-Time Notification & WebSocket Engine (6.16). Phase 3 established that
nothing reaches a model unmasked and that an agent is a delegate of the person
using it ([ADR 0003](0003-inference-and-privacy.md)). This phase must keep both
properties when:

- work passes from agent to agent through a queue;
- agents take actions in the world through tools;
- progress streams to browsers.

The queue (Redis) is a third-party service. Tool arguments are written by a
model, which is to say by whoever managed to influence its context. A
WebSocket is a long-lived channel that outlives the access check that opened
it. The design treats all three as untrusted. It is organised around the
plan's three exit criteria:

- a three-agent run whose full trace can be rebuilt from the audit log alone;
- a failing step whose dead letter holds no sensitive payload;
- a runaway loop stopped by the step ceiling, not by the queue.

This record sets out twelve decisions.

---

## Decision 1: PostgreSQL is the source of truth; the queue only delivers

Every state change of a run is a row change in PostgreSQL; BullMQ carries
"please look at step X". The alternative — state in job data, chained jobs
enqueuing their successors — loses work whenever an enqueue fails after a
commit, and doubles it whenever a job is redelivered.

- **One transaction per step outcome.** Settling a step runs in one
  transaction that holds the run's row lock. It stores the step's encrypted
  output and labels, writes its audit record, asks the scheduler what became
  ready, inserts those steps, and finishes the run if nothing is left. No state
  exists in which a step finished but its successors were never recorded.
- **Deterministic step ids**, `uuidv5(run:node:iteration)`: inserting a step
  that already exists is a no-op.
- **Compare-and-set claims.** A worker claims a step with
  `UPDATE … WHERE status='QUEUED' AND dispatch=$job`. Exactly one caller wins,
  and a stale or replayed job (whose dispatch number has moved on) is a no-op.
- **Leases.** A running step sends heartbeats. A step silent for
  `WORKFLOW_STALL_THRESHOLD` is taken over, and the original worker notices
  that it has lost the lease and stops.
- **The engine owns retries.** Jobs have `attempts: 1`. Retry state (attempt,
  class, next time) lives in PostgreSQL, with jittered exponential backoff.
  Only transient failures and timeouts are retried; policy and permanent ones
  are not.
- **A reconciliation sweep**, a BullMQ job scheduler with one sweep per
  interval cluster-wide:
  - re-dispatches QUEUED steps whose job was lost, and stalled steps;
  - times out runs past their deadline;
  - resolves expired approvals by their node's policy;
  - settles runs with nothing in flight;
  - destroys runs past retention.

Because the scheduler recomputes from the whole recorded state, instead of
reacting to one event, a duplicated or lost event cannot strand or
double-schedule a run.

## Decision 2: the broker carries references and a MAC, never content

A queued job is `{ organizationId, runId, stepId, dispatch, issuedAt, mac }`.
The MAC is an HMAC-SHA-256 keyed by HKDF of the run's data key. Consequences:

- A compromised Redis, its snapshots or its replicas yield no content — not
  even ciphertext. This is stronger than the plan's "the broker yields
  ciphertext".
- Nobody without the run key, which exists only wrapped by the master key in
  PostgreSQL, can mint a job a worker accepts. A forged MAC, or a job pointed
  at another workspace (the MAC covers the organisation), is refused and
  audited `workflow.step.rejected` at CRITICAL.
- Deleting a run destroys its key, so its jobs still in the queue can no
  longer be verified and are dropped.

The inter-agent messages themselves — each step's input and output — are
sealed with AES-256-GCM under a **per-run data key** (envelope encryption).
The AAD binds each ciphertext to its run, step and field, so it cannot be
swapped for another. Deleting a run (or retention) destroys the key first:
crypto-shredding.

## Decision 3: a workflow is a validated graph with explicit, bounded loops

Definitions are the JSON the React Flow canvas saves (`nodes` with `type`,
`position`, `data`; `edges` with handles), versioned append-only like agents.
Validation (`validateGraph`) is the security boundary for what a definition
may do:

- **Structure.**
  - One trigger and at least one output.
  - Every node reachable.
  - Size ceilings.
  - Unknown properties dropped, so what is stored is what is understood.
- **Acyclic core with explicit loops.** A cycle is legal only as a back edge:
  - it leaves a *condition* rule;
  - it carries `data.loop.maxIterations` (≤ `WORKFLOW_MAX_LOOP_ITERATIONS`);
  - it closes over a single-entry, single-exit region.

  Everything else must be a DAG.
- **References owned.** Agents, tools and knowledge bases are checked against
  the workspace *and* against the editor's own access. Nobody can wire in an
  agent they could not use.
- **Templates only reference.** `{{input.x}}` and `{{nodes.<id>.output.y}}`
  are the whole language: no expressions. A reference must name an ancestor.
  A path into an agent's JSON output must exist in that agent's output schema.
  Retrieved passages may flow only into agents.
- **A worst-case step bound** is computed and reported.

Execution semantics follow BPMN and Airflow:

- **AND-joins.**
- **Dead-path elimination:** a node whose inputs all resolve with none live is
  skipped, and so is everything below it.
- **Error handles:** a failed step with an `error` edge follows it instead of
  failing the run.
- **Loops:** a loop iteration re-runs its body with the iteration number
  increased.

## Decision 4: two circuit breakers, checked before the queue

- **The step ceiling** (`WORKFLOW_MAX_STEPS`, lowerable per workflow) is
  checked when steps are *scheduled*, inside the settle transaction. A
  runaway loop is stopped before its next step reaches the queue. It is never
  stopped by the queue running dry or by retry exhaustion.
- **The token budget** (`WORKFLOW_MAX_TOKENS_PER_RUN`) is charged after every
  model call.

Either one fails the run and is audited `agent.circuit_broken`. Per-edge loop
limits and supervisor round limits bound each construct on its own.

## Decision 5: the Supervisor pattern, as steps

A supervisor node (AutoGen's group-chat manager) hands each *round* to one of
its workers:

- **`llm` strategy:** a model reads the goal and a transcript of the workers'
  outputs, presented as data, and answers
  `{"next": "<worker>"|"FINISH", "instruction": …}`. The answer is validated
  against the worker keys and gets one repair attempt.
- **`round_robin` strategy:** workers take turns in order.

Each round is its own persisted step, so a supervised conversation survives
crashes and is traced like everything else. `maxRounds` bounds it.

## Decision 6: a run acts as its initiator, re-checked before every step

Continuing ADR 0003 Decision 7: a workflow run is a delegate of the person (or
API key) who started it.

- **Before every step**, the engine re-resolves the principal from the
  database: membership, suspension, effective permissions. The permission
  cache is not used here. A member removed mid-run stops the run at its next
  step (`WORKFLOW_PRINCIPAL_REVOKED`, a policy failure, not retried).
- **Labels flow.** Each step records its output's classification (the high
  water mark of what it read) and integrity (the low water mark). Content
  endpoints withhold output a reader is not cleared for.
- **Supervisors see masked content.** Someone with `workflow:read_all` who is
  not the initiator reads a run's content masked, unless they reveal it with
  `pii:reveal`; both are audited.
- **Human approval, with separation of duties.** By default, whoever started a
  run cannot approve its approval nodes. An approver must also be cleared for
  the label of what the approval concerns. The decision is audited inside the
  same transaction as the step it settles.

## Decision 7: tools speak a text ReAct protocol

The model calls a tool by writing `<tool_call>{"name": …, "arguments": {…}}`.
Generation stops at the closing tag. The result returns in `<tool_result>`
tags, and the system prompt says results are data, never instructions.
Why text rather than providers' native function calling:

- The gateway speaks two dialects to many open-weight models, and native tool
  calling differs across them. Some models lack it, and streamed tool-call
  deltas are shaped differently by each server.
- **The privacy boundary stays simple.** A tool call is text in the model's
  output, so the gateway's egress check and streaming unmasker already cover
  it. A result is text in the next prompt, so it is escaped (delimiter-like
  text neutralised) and then masked *in the same masking session*. A person
  is the same placeholder in the question, in a searched passage and in a
  drafted email.
- The parser is tolerant of how models actually write calls, and strict about
  meaning. The tool must be on offer and the arguments an object. A call
  inside `<think>` is not a call. Malformed calls are answered with an
  explanation.

The loop is bounded:

- at most `maxIterations` calls;
- an exact repeat is answered from the transcript;
- three failures in a row end it;
- results are capped in tokens, and old ones are elided to fit the window;
- when the loop stops, the model is told to answer with what it has.

## Decision 8: every tool call is checked in a fixed order, and recorded

`ToolExecutorService.execute` applies, in order:

1. **granted** to this agent (or used by this workflow node);
2. **enabled and available**;
3. **permitted**: `tool:execute` and the tool's own required permissions,
   checked against the delegating principal;
4. **arguments valid**, against a strict JSON Schema subset, at most 16 KB;
5. **approval**, if the tool requires it;
6. **information flow** (Decision 9);
7. **personal data** in the arguments;
8. **budget**: per run and per tool;
9. for side-effecting tools, an **idempotency claim** keyed by a deterministic
   execution id (step, iteration, tool). A retried step does not send the
   email twice.

Then the tool runs with a timeout and its result is bounded. Every call —
executed, failed or denied — writes a content-free ledger row
(`tool_executions`: a keyed digest of the arguments, never the arguments) and
an audit record (`tool.executed`, `tool.execution.failed`,
`tool.execution.denied`) keyed to its run and step.

The schema subset rejects every keyword it does not enforce (`pattern`,
`oneOf`, `$ref`, …). A schema that *looks* like it constrains arguments while
constraining nothing is worse than none. Property names reaching the
prototype machinery (`__proto__`, `constructor`) are refused in schemas and in
arguments.

Tools that require approval are refused *inside an agent's loop*: the masking
session cannot persist across a human wait. In a workflow they run as a tool
node behind an approval node, which is also the clearer design.

## Decision 9: information-flow control at every tool sink

Each tool declares a data policy:

- `maxClassification`: the most sensitive context that may flow into it;
- `minIntegrity`: the least trusted context it may be called from;
- `piiArguments`: `unmask` or `deny`;
- `sideEffects`.

The context carries a confidentiality label, joined from everything read, and
an integrity label, met over the lattice TRUSTED > INTERNAL > EXTERNAL. A call
is refused when either check fails. This is the FIDES / CaMeL line of defence
against prompt injection. Once an agent has read a web page (EXTERNAL), tools
with side effects are disabled for the rest of that answer, whatever the page
told it to do. Having read payroll (CONFIDENTIAL), it cannot send it anywhere
cleared only for INTERNAL.

The defaults lock down anything external: external tools accept PUBLIC context
only and refuse personal data in arguments (`deny`, with the gateway's egress
scan re-run on the outgoing request). `send_email` reaches only workspace
members, and only those cleared for the context's label. Weakening a tool's
policy is audited.

## Decision 10: egress control for HTTP tools

An HTTP tool is a request an attacker can partly write, so SSRF is the tool
engine's main network threat. Controls:

- **Fixed origin.** A tool's scheme, host and port are fixed at definition and
  must match `TOOL_HTTP_ALLOWED_HOSTS` (empty means no HTTP tools).
  Arguments fill only the path (percent-encoded per segment; `.` and `..`
  refused), the query and the body. A rendered request that leaves the tool's
  fixed path prefix is refused.
- **Public addresses only.** Every address a name resolves to must be public
  unicast. The connection is pinned to the checked address, which closes the
  DNS-rebinding window. The cloud metadata service (`169.254.169.254`,
  `fd00:ec2::254`, `100.100.100.200`) is refused even in development mode.
- **No redirects** are followed.
- **Ceilings** on response size and time.
- **Headers.** Transport and identity headers cannot be set by a tool.
- **Credentials** are stored encrypted, never returned, and never shown to the
  model.

## Decision 11: real-time events are metadata, routed by verified ids

Socket.IO, WebSocket transport only by default (no sticky sessions needed).

- **Authentication at the handshake** reuses the HTTP machinery:
  `{ token, organizationId }` or `{ apiKey }`, never in the URL. On top of it:
  - an origin check against `CORS_ORIGINS`;
  - a per-IP handshake throttle;
  - a per-user connection cap;
  - the workspace IP allowlist.

  Refusals are audited.
- **Rooms are derived from verified ids only.**
  - The person's own runs, and their notifications.
  - Every run in the workspace, only with `workflow:read_all`.
  - Approval requests, only with `workflow:approve`.
  - One run's step detail, only after a subscription that checks the run's
    tenant and ownership.

  Every delivery re-checks that the event's workspace is the socket's: a
  mis-routed event still cannot cross tenants.
- **Access that changes, closes the socket.** Sockets are re-validated
  periodically, and at once when access changes anywhere: RBAC, token
  revocation and API-key revocation emit `security.access_changed`, which
  reaches every API instance through Redis. A removed member's socket gets
  `auth:revoked` and is closed. Token expiry closes it too, unless the client
  refreshes with `auth:refresh`.
- **Events carry no content.** Event data is flattened, bounded and
  structure-free by construction (`sanitizeEventData`): ids, statuses,
  counts, durations. Content is fetched over HTTP, with its label check.
- **Delivery.** One Lua script appends each event to a capped per-workspace
  Redis Stream and publishes it, atomically. A reconnecting client replays
  what it missed (`resume` with `lastEventId`); live delivery is pub/sub.

## Decision 12: the audit log is sufficient to redraw a run

Every fact of a run is written to the hash-chained audit log as it happens,
the step's record inside the transaction that settles it:

- the start: workflow, version, definition digest, initiator;
- each step: node, iteration, attempts, predecessors, the outcome taken, the
  agent or tool version, tool calls, tokens;
- each tool call, keyed to its step;
- approvals and who decided;
- circuit breakers;
- the end, with the number of steps that ran and the ones skipped.

`reconstructTrace` rebuilds the graph of the run from these records alone and
reports whether every promised fact is present (`complete`). Runs can be
deleted; the trace survives. An expression index on `metadata->>'runId'`
keeps the query cheap. None of it is content.

---

## Operational design

- **Health.** `workflow_engine` reports steps stalled or overdue beyond the
  sweep's windows. That means no process is consuming the queue, typically
  a worker deployed without workers enabled. `realtime` reports the event-bus
  subscription and this instance's connections. Both report *degraded*,
  never *down*.
- **Poison steps.** A step whose worker dies on every attempt is taken over at
  most `WORKFLOW_STEP_MAX_ATTEMPTS` times, then failed and dead-lettered
  rather than crashing worker after worker.
- **Dead letters** are built field by field from typed inputs (no free text,
  no error messages, no ciphertext) with a keyed fingerprint of the input, so
  "the same input fails every time" is visible without the input. Every
  final step failure is dead-lettered.
- **Admission control.** Runs in progress per workspace are bounded, under a
  per-workspace advisory lock, so one tenant cannot occupy every worker.
  `idempotencyKey` makes starting a run safe to retry.
- **Cancellation reaches in-flight work.** A cancel publishes a control
  message. Every process aborts that run's running steps, down to the model
  request.
- **Resume, not restart.** A failed run resumes from its failed steps;
  finished steps keep their outputs.

## Consequences

- **PostgreSQL does more work.** Each step costs a claim, heartbeats, and a
  settle transaction under the run's row lock. That is milliseconds against
  the seconds of a model call, and it is what makes crash recovery and exact
  once-only scheduling possible. Very wide fan-outs serialise on the run lock.
- **A queue hop per step.** Latency between steps is the BullMQ pickup time
  (typically under 50 ms), not zero.
- **Text-protocol tool calling depends on the model following the format.**
  Small models sometimes do not. Malformed calls are explained back to the
  model, and the loop is bounded, so the cost is a weaker answer, never an
  unintended action.
- **Information-flow control is conservative.** Labels are the high-water mark
  of everything read, so an agent that looked at one external page cannot
  email anyone for the rest of that answer, even about something unrelated.
  Workflows that need both read the external data in one step and act, behind
  an approval node, in another.
- **Pub/sub is at-most-once.** A socket that misses a live event recovers it
  by replay from the stream, within `REALTIME_STREAM_MAXLEN` /
  `REALTIME_STREAM_TTL`.

## Deviations from the implementation plan

- **The broker carries no ciphertext either** (Decision 2). The plan asked
  that a compromised broker yield only ciphertext; here it yields references
  that cannot be forged.
- **Retries belong to the engine, not BullMQ** (Decision 1), so retry state
  survives Redis and is visible in the run's steps; "per-step retry,
  backoff, timeouts" are all per node.
- **Circuit breaking for workflows arrives in this phase** (Decision 4). The
  plan scheduled `agent.circuit_broken` for phase 5; the step ceiling is this
  phase's exit criterion, and the token budget is the same mechanism. Phase 5
  still adds quotas per workspace, agent and member.
- **ReAct is a text protocol** rather than native function calling
  (Decision 7).
- **Approval-required tools run as workflow nodes**, not inside an agent's
  loop (Decision 8).
- **Real-time events never carry content** (Decision 11). The plan asked for
  "live execution events"; the canvas gets statuses and fetches content over
  HTTP, where the label checks live.
