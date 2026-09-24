# ADR 0002: Knowledge layer security model

**Status:** Accepted · **Date:** 2026-09-24 · **Phase:** 2

---

## Context

Phase 2 puts enterprise documents into the platform and makes them retrievable
for RAG (proposal modules 6.4–6.6). The proposal's central criticism of
standard RAG is that retrieval ignores who is asking: the vector nearest to
"what does the CEO earn?" is the payroll chunk, for every employee alike.

Two facts about this deployment shape the design:

1. **Everything runs on third-party clouds.** PostgreSQL, Redis, object storage
   and the vector store are each operated by a different provider. Each of
   them, and each of their backups, is a place documents can leak from.
2. **No transaction spans those stores.** At any moment PostgreSQL, the object
   store and the vector store can disagree about a document, for example
   during a reclassification or while a purge is pending.

This record sets out six decisions.

---

## Decision 1: access is a lattice, expressed through RBAC

Two independent dimensions, both required:

- **Compartments (need-to-know).** A knowledge base is either `WORKSPACE`
  (governed by role permissions like any resource) or `RESTRICTED` (reachable
  only through explicit grants to a role, a membership or an API key, at
  READ / WRITE / MANAGE).
- **Classification vs clearance (sensitivity).** Every document is PUBLIC,
  INTERNAL, CONFIDENTIAL or RESTRICTED. A principal's clearance is the highest
  `clearance:*` permission it holds; clearance is hierarchical.

A principal reads a document only if it holds the compartment **and** its
clearance dominates the document's classification. This is the
Bell–LaPadula / Denning lattice (level × category set), realised on top of the
phase 1 permission system rather than beside it. Clearance is granted, revoked,
escalation-checked and audited exactly like every other permission.

**Only `*:*` bypasses compartments.** The administrator role holds
`knowledgebase:*` but not `*:*`, and wildcard matching keeps the two distinct.
Running a workspace is not the same entitlement as reading its HR files.

**Hidden means hidden.** A compartment without a grant returns 404, the same
answer a nonexistent id gets. The audit log, however, records the difference
(`access.denied`, reason `compartment` or `clearance`).

## Decision 2: the policy is part of the query, enforced twice

1. **In the vector search.** A mandatory filter (workspace ∧ readable
   compartments ∧ permitted classifications ∧ embedding model ∧ active) is
   built on the server from the resolved access scope and applied *inside*
   Qdrant's filterable HNSW traversal. Callers may narrow it by naming
   knowledge bases or documents. Naming something outside the scope is refused,
   so a narrowing can never widen access.
2. **In the text fetch.** The vector store holds no text. Turning hits into
   passages means reading chunks from PostgreSQL through a query that restates
   the whole policy in SQL (plus liveness and active version). A hit failing it
   yields no row, so its ciphertext is never decrypted.

Either layer alone would enforce the policy. Together they keep it enforced
while the stores disagree: a document reclassified upward is excluded by SQL
immediately, before its vector payload has been updated. This is tested end to
end.

*Rejected: post-retrieval filtering alone.* It loads unauthorised chunks into
process memory and into anything that logs retrieval, and it returns fewer
than `topK` results unpredictably.

## Decision 3: the vector store holds no text

Points carry vectors and a payload of ids and labels only. Chunk text lives in
PostgreSQL, encrypted. A compromised Qdrant cluster exposes vectors and ids.
Embeddings are not perfectly irreversible, but that is far less than the
documents themselves.

## Decision 4: envelope encryption with crypto-shredding

Each document gets a random 256-bit data key. The stored file and every chunk
of its text are sealed with AES-256-GCM under that key, bound by associated
data to their location (`document:<id>:original`, `chunk:<id>`). The data key
is stored only wrapped by the phase 1 `EncryptionService` master key.

- Every cloud provider holds only ciphertext.
- **Deleting a document nulls its wrapped key in the same transaction.** Every
  copy of the content, including database point-in-time backups and versioned
  bucket copies the platform cannot reach, becomes unreadable at that
  instant. This is what makes a deletion request honourable in a cloud
  deployment. Physical removal of vectors and objects follows asynchronously.
- Master-key rotation becomes re-wrapping small keys, not re-encrypting content.

Duplicate detection uses a keyed (HKDF-derived) HMAC fingerprint, not a bare
SHA-256, so a database dump cannot confirm whether the workspace holds a
specific known file.

## Decision 5: PostgreSQL is the source of truth; everything else converges

- **Status transitions are compare-and-set** on `(id, index_version, status)`.
  A superseded or deleted document's job finds nothing to update and stops.
- **Chunks are persisted in the transaction that moves CHUNKING → EMBEDDING.**
  After a crash there is no half-chunked state.
- **Chunk ids are UUIDv5 of `(document, version, position)`** and double as
  vector point ids. Retried writes overwrite, so a crash mid-embedding cannot
  duplicate chunks. Progress is checkpointed per batch, and a retry resumes.
- **Versions activate atomically from the reader's view.** New points are
  written inactive, activated only when complete, and the previous version is
  retired afterwards. Retrieval serves the old version throughout a reindex.
- **The documents table is the outbox.** An upload whose enqueue fails still
  succeeds; a periodic sweep (a BullMQ job scheduler, so exactly one per
  interval across all workers) enqueues it, resumes stalled runs, finishes
  purges and re-syncs vector payloads.

## Decision 6: the AI service is compute only, and requests to it are signed

The Python service parses and embeds; it never sees the vector store or the
database, so the retrieval policy cannot be bypassed by going through it. Each
request is HMAC-signed over method, path, query, timestamp, nonce and body hash,
giving authenticity, integrity and replay protection that survives TLS
termination. Phase 5 adds mTLS underneath. Its responses are validated as
untrusted input (dimensions, finiteness, model identity) before anything is
stored.

---

## Consequences

- Each retrieval costs one extra indexed SQL query (the second enforcement
  point) and, when auditing what was withheld, one extra vector search that
  returns ids only. Both run within the measured timings reported per query.
- Access scope is resolved per request with one query and **not cached**: its
  inputs are edited by three services, and a missed invalidation would leave
  someone reading a compartment they were just removed from.
- Query text is never written to the audit log (it may itself be sensitive); a
  keyed fingerprint correlates repeated queries instead. For the same reason,
  query embeddings are not cached in Redis.
- Deletion is irreversible by design. The UI must confirm it.
- Restricted-tier clearance (`clearance:restricted`) cannot be granted to API
  keys: the most sensitive tier is reachable only by people.

## Deviations from the implementation plan

- **Storage driver:** S3-compatible only, with no local filesystem driver, because
  the deployment is cloud-only. MinIO covers local use if ever needed.
- **Collection-per-workspace** remains the default as planned, with a `shared`
  tenancy mode (Qdrant's tenant-indexed partitioning) available for scale.
  The mandatory workspace filter applies in both modes.
