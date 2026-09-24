# ADR 0003: Inference, agents and the privacy boundary

**Status:** Accepted · **Date:** 2026-09-25 · **Phase:** 3

---

## Context

Phase 3 connects the platform to language models (proposal module 6.7), lets
workspaces build agents on them (6.8) with conversational memory (6.10), and
adds the project's research component, the PII Redaction Engine (6.12). Phase 2
decided who may *retrieve* a document ([ADR 0002](0002-knowledge-layer-security.md)).
This phase has to keep those guarantees once retrieved text is handed to a
model, written into an answer, stored in a conversation and fed back as history.

The deployment is cloud-only. The model endpoint may be a GPU host the team
runs, or a third party. Either way it is a place where prompts are logged,
cached and retained outside the platform's control. The design treats it as
**untrusted with personal data**.

This record sets out ten decisions.

---

## Decision 1: one gateway, and it is the privacy boundary

Every call to a language model goes through `LlmGatewayService.chat()`. The
request type makes skipping the privacy decision impossible:
`privacy: { mode: 'masked', session } | { mode: 'disabled', reason: 'workspace-policy' }`.
There is no third option, and "disabled" is reachable only from a workspace
policy that an administrator set explicitly (audited as a weakening).

Before anything is sent, the gateway runs an **egress check** on the exact
payload: no value the masking session knows may appear outside a placeholder,
and no structural recognizer may fire. A finding refuses the request
(`PII_EGRESS_BLOCKED`) and is audited as CRITICAL, with entity types only. The
plan's exit criterion — "the prompt captured at the gateway boundary contains
none of them" — is therefore enforced on every request in production, not only
asserted in a test. A defect anywhere upstream fails closed.

## Decision 2: detection in two layers, each doing what it is good at

- **Validated pattern recognizers, in process**: cards (Luhn and issuer prefix),
  IBANs (country length and mod-97), CNIC and SSN (issued ranges), phones,
  emails, IPs, salaries (an amount beside a compensation word), credentials
  (vendor key formats, passwords in assignments and connection strings), and
  each workspace's deny list. Validation keeps precision high enough to run
  alone.
- **NER for names**, through the AI service's `POST /v1/pii/analyze` (Presidio
  and spaCy) or a stock Presidio analyzer. Only the types patterns cannot find
  are requested.

Text is canonicalised first (NFKC, invisible and bidi characters removed), so
full-width digits and zero-width spaces cannot hide a card number, and the
canonical text is what the model receives: what was checked is what is sent.
Python reports code-point offsets and JavaScript indexes UTF-16, so offsets are
converted and bounds-checked before use. NER results are cached in Redis under
an HMAC of (workspace, policy, text) and hold offsets and types, never text.

## Decision 3: masking is request-scoped; the mapping never persists

A `MaskingSession` masks every segment of one prompt — instructions, retrieved
passages, history, the question — so one person is `[PERSON_1]` everywhere in
it. Two mechanisms extend each detection:

- **Linking**: "Raza" joins "Ayesha Raza" when exactly one known person
  matches, and ambiguity creates a new placeholder rather than a guess.
- **Propagation**: once a value is known, every other occurrence in the prompt
  is masked, whether or not the detector saw it there. Numbers match by
  digits (so "950,000", "950000" and "9,50,000" are one salary). Values under
  six digits are not propagated; the benchmark showed that they collide with
  years and reference numbers.

The reverse mapping lives in a `PiiVault`: AES-256-GCM under a key generated
for the request, zeroed when the request ends. Nothing is written to the
database or Redis. This is the plan's "critical subtlety": a stored mapping
table would be a decrypted PII store with extra steps.

## Decision 4: unmasking streams, and measures placeholder fidelity

The model's answer is unmasked as it streams. A `StreamingUnmasker` holds back
text that could still become a placeholder (`[PER` …), so a user never sees half
of one; output is identical however the stream is chunked (fuzz-tested). Common
mangled forms (`[person 1]`, `[PERSON-1]`) resolve too. Placeholders the model
invented are counted as `unresolved`, a direct measure of how well a given
model follows the placeholder instruction.

## Decision 5: fail closed by default, and there is no "send unmasked" mode

If the NER detector is unavailable, the workspace policy decides:
`REFUSE` (the default: `503 PII_DETECTION_UNAVAILABLE`, nothing sent,
audited) or `DEGRADE_TO_PATTERNS` (structural types still masked, names not).
No policy value sends raw text because a dependency is down. Weakening a
policy — fewer types, a higher threshold, degrading, disabling — is audited
with `weakened: true`.

## Decision 6: the egress re-scan judges what is sensitive in itself

A context-dependent detection ("salary" within 64 characters of a number) can
change its verdict when masking shortens the text, or when the gateway sees
segments side by side that detection saw apart. Early benchmark runs showed
the re-scan blocking 1.6% of clean prompts for exactly that reason. Recognizers
therefore report a `contextFreeScore`, and the gateway re-checks only what is
sensitive regardless of context (cards, IBANs, national ids, emails,
credentials, known values). Context-dependent detections are applied fully
where they belong, at detection time.

## Decision 7: an agent is a delegate, not a principal

An agent holds no access of its own. Retrieval for a turn runs with **the
user's** access scope, narrowed by the agent's knowledge bases and
classification ceiling (`restrictToKnowledgeBaseIds`, `maxClassification`).
It is never widened. This removes the confused-deputy problem by construction:
a Helpdesk agent with the HR knowledge base attached returns nothing from HR to
an employee who could not read HR themselves.

Configuration is protected the same way:

- an editor can attach only knowledge bases they can read;
- bases they cannot read are hidden from them and preserved when they save;
- restricting an agent to roles (`RESTRICTED` access mode) decides who may
  *talk to* it, not what it may read.

## Decision 8: agents are versioned, append-only

Anything that changes behaviour — persona, instructions, model, parameters,
retrieval, memory — creates a new immutable version. A database trigger
rejects `UPDATE` on `agent_versions`, and rollback appends a copy of the old
version. Each version carries a digest of its configuration and
instructions, so "restore version 3" is verifiable. Every answer records the
agent version and the platform prompt-template version that produced it.
Instructions are stored encrypted.

## Decision 9: memory is token-budgeted and carries information-flow labels

The context window is planned in this order:

1. the answer's share is reserved;
2. a safety margin follows;
3. the system prompt and question are mandatory — if they alone do not fit, the
   request is refused;
4. passages come next, in rank order;
5. history fills what remains, as a contiguous block newest-first.

"The last N messages" is a ceiling, not the budget.

Retrieved text lives on inside answers, so every message carries a **label**
(the high-water mark of the lattice):

- an assistant message gets the join of the classifications and compartments
  of its inputs;
- a user message gets the conversation's label so far.

Labels are checked against the reader's *current* access on every read and
every time history is considered for a prompt. Losing HR access, or deleting the
payroll document, withdraws the answers derived from it, including from their
owner. Supervisors (`conversation:read_all`) see content masked;
`reveal=true` requires `pii:reveal` and is audited as CRITICAL.
Conversations are encrypted with a per-conversation key, which deletion
destroys.

## Decision 10: the model endpoint has a trust tier

`LLM_MAX_CLASSIFICATION` caps what may be sent to the configured endpoint, even
masked: passages and history above it never enter a prompt. `RESTRICTED` suits
a model the team runs; a third-party API should get `INTERNAL` or lower. The
effective ceiling for a turn is the lower of this and the agent's own.

---

## Operational design

- **Streaming.** Server-Sent Events over POST. Failures before the stream opens
  (validation, access, an unknown or disallowed model) are ordinary JSON errors
  with their status. After it opens, they arrive as an `error` event carrying
  the same code, status and details. Headers disable compression and proxy
  buffering; a heartbeat every 15 s keeps idle-timeout proxies away; a client
  disconnect aborts the upstream generation.
- **Resilience.**
  - A bulkhead admits `LLM_MAX_CONCURRENCY` generations per process, with a
    bounded, cancellable queue.
  - A circuit breaker opens only for endpoint faults, not for bad requests.
  - Retries happen only before the first token.
  - Three deadlines apply: first token, idle gap, and total duration, plus an
    output size ceiling.
- **Conversations.** A turn holds a lease on its conversation (compare-and-set
  with expiry), so two tabs cannot interleave a conversation and a crash cannot
  wedge it. `clientMessageId` makes sends idempotent. The question is stored only
  once the model has admitted the request, and an interrupted answer is stored
  with what was shown.
- **Measurement.** Every model call writes a content-free row to
  `llm_invocations`. It records outcome, tokens (reported or estimated),
  time to first token, and redaction time split into detection, egress check
  and unmasking. `GET …/llm/usage` reports percentiles and the redaction
  overhead's share of the total. `npm run benchmark:pii` measures accuracy
  and overhead on a documented corpus (`docs/benchmarks/pii-redaction.md`).

## Consequences

- **Latency.** In-process redaction costs about 1.5 ms per typical prompt
  (p50), 12 ms at p95 for long ones. NER adds its round trip, which the cache
  removes for recurring passages. Against 0.3–2 s to a local model's first
  token, the overhead is small but visible, and it is reported.
- **Answer quality depends on the model keeping placeholders.** Instructions
  tell it to copy them exactly, and mangled forms are tolerated. A model that
  paraphrases `[PERSON_1]` as "the employee" produces a vaguer answer, never a
  leak. Invented placeholders are counted.
- **Fail-closed costs availability.** With the default policy, an NER outage
  stops agent turns in every workspace that did not opt into degradation.
- **Context heuristics are heuristics.** A price near the word "salary" can be
  masked, and a salary far from any such word can be missed. Propagation, the
  known-value egress check and the NER layer narrow the gap without closing it.
  The benchmark reports both rates.

## Deviations from the implementation plan

- **Two detection layers, not Presidio alone.** Structural types are found in
  process with validation, which is faster, available when the NER service is
  not, and what the gateway re-runs at egress. Presidio (through the AI service,
  or directly) handles names.
- **The mapping is sealed with a per-request key, not the phase 1
  `EncryptionService`.** A long-lived key could decrypt a leaked mapping later.
  An ephemeral one is zeroed with the request, so nothing can.
- **Provider-neutral gateway.** Ollama's native API and any OpenAI-compatible
  server (vLLM, TGI, hosted open-weight APIs) are both supported. A cloud-only
  deployment may not run Ollama, and `LLM_MAX_CLASSIFICATION` makes the choice
  of endpoint a policy decision.
- **Failure mode rather than `PII_FAIL_CLOSED`.** The boolean became
  `REFUSE | DEGRADE_TO_PATTERNS`, and model and PII settings moved from the
  organisation record into dedicated policies with their own permissions
  (`llm:manage`, `pii:policy:update`) and audit trails.
- **Granted tools are deferred to phase 4**, with the Tool Execution Engine
  (module 6.11). In this phase an agent has no tools, so a prompt injection
  through a document has nothing to escalate to. Retrieved text is still
  delimited as data, and delimiter-like text inside it is escaped.
- **"The RBAC rules the agent operates under"** are the user's own
  (Decision 7). An agent's restrictions narrow access and never grant it.
