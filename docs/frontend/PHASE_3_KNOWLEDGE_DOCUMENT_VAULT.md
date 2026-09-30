# Frontend Phase 3: Knowledge Bases & Document Vault (Secure RAG)

**Status:** ready to implement
**Roadmap:** [`FRONTEND_PHASES.md`](FRONTEND_PHASES.md), Phase 3 of 9
**Builds on:** [`PHASE_1_FOUNDATION_AUTH_WORKSPACE.md`](PHASE_1_FOUNDATION_AUTH_WORKSPACE.md) and
[`PHASE_2_WORKSPACE_ADMINISTRATION.md`](PHASE_2_WORKSPACE_ADMINISTRATION.md). Their API client,
token manager, envelope, error handling, permission loader, workspace gate, theme and
member/role/API-key data are reused without being repeated here.
**Backend:** every request, response and error in this document was run against a live
instance of the backend on 2026-09-30: about 550 requests covering all 19 endpoints,
their failure cases, the five demo roles, and outages of each cloud dependency (object
storage, vector store, AI service, PII detector). That includes the **backend fixes made
that day** (§11 lists what changed). The three cloud services were in-memory stand-ins
(§13), so a few behaviours come from reading the backend code rather than from a live
run: real PDF and DOCX text extraction and the AI service's own failure codes, real
hybrid-search scores and cross-encoder reranking, the `409` integrity failure on download,
`408` on a slow upload, and `INGESTION_TIMEOUT`. They are described as the code implements
them.
**Design:** mockup screen 5, "Document Vault & RAG Pipeline" (proposal §13, Figure 5).
Three elements of the mockup have no data behind them in the API; §6.10 maps every
element and says what to do instead.
**Before you start:** the knowledge layer needs object storage, Qdrant and the Python AI
service. Until a backend has all three, uploads and search answer `503`. For frontend
work, run the backend with **`npm run start:standins`** (§13): the real API with
in-memory stand-ins for those three services.

---

## Contents

1. [What Phase 3 delivers](#1-what-phase-3-delivers)
2. [Changes to Phase 1–2 code](#2-changes-to-phase-12-code)
3. [The access model you are building a UI for](#3-the-access-model-you-are-building-a-ui-for)
4. [Concepts the screens depend on](#4-concepts-the-screens-depend-on)
5. [Routes and navigation](#5-routes-and-navigation)
6. [Screens](#6-screens)
7. [Endpoint reference (E60–E78)](#7-endpoint-reference-e60e78)
8. [Error codes Phase 3 must handle](#8-error-codes-phase-3-must-handle)
9. [Client-side validation rules](#9-client-side-validation-rules)
10. [State, caching, polling and invalidation](#10-state-caching-polling-and-invalidation)
11. [Backend fixes of 2026-09-30 (what changed for the frontend)](#11-backend-fixes-of-2026-09-30-what-changed-for-the-frontend)
12. [Definition of done](#12-definition-of-done)
13. [Local development: the stand-ins server](#13-local-development-the-stand-ins-server)
14. [Appendix A: TypeScript types](#appendix-a-typescript-types)
15. [Appendix B: helper code](#appendix-b-helper-code)

---

## 1. What Phase 3 delivers

The Document Vault: people put enterprise documents into access-controlled knowledge
bases, watch them move through the ingestion pipeline, check what an AI model would see
of them, and search them securely.

- **Document Vault** (mockup 5): every document you can see, across knowledge bases,
  with filters, search, sorting, paging and live pipeline status.
- **Upload:** drag and drop several files, each with a progress bar and its own error
  message, into a knowledge base, with a classification and optional title, description
  and tags.
- **Document detail:** metadata, processing timeline, the exact chunks retrieval serves,
  edit and reclassify, reindex or retry, download, and delete (irreversible).
- **PII redaction report:** per document, each chunk as the model would receive it, with
  every detection. Real values are shown only to holders of `pii:reveal`.
- **Knowledge bases:** create, edit and delete, with an access mode (open to the workspace
  or a restricted compartment), a default classification and chunking settings.
- **Access grants:** admit roles, members or API keys to a restricted knowledge base at
  `READ`, `WRITE` or `MANAGE`.
- **Retrieval playground:** ask a question and see the passages retrieval returns, with
  sources, scores and timings, next to a "what can I reach" panel.
- **Honest failure states:** the vault stays usable (lists, metadata, chunks) when object
  storage, the vector store or the AI service is missing or down, and says exactly what
  is unavailable.

The server enforces every rule. The UI's job is to offer only what can succeed, to
explain refusals, and above all **never to reveal that something hidden exists** (§3.4).

---

## 2. Changes to Phase 1–2 code

1. **The Documents nav item becomes real** (`knowledgebase:read` or `document:read`,
   Phase 1 §5.4). Below it, the sidebar lists knowledge bases with document counts, as in
   the mockup (§6.1).
2. **Per-request timeouts in `request()`.** Phase 1 aborts every call after 35 s. Add an
   optional `timeoutMs`: retrieval (E76) gets **65 s** (the server allows 60 s); every
   other JSON call keeps 35 s.
3. **Uploads do not go through `request()`.** `fetch` cannot report upload progress, so
   use the `XMLHttpRequest` helper in Appendix B (`lib/knowledge/upload.ts`). It keeps
   Phase 1's behaviour: bearer token, workspace header, one refresh-and-retry on a
   refreshable `401`, `ApiError` on failure.
4. **Downloads** use `fetch` + `Blob` like Phase 1's data export, but must read the
   RFC 5987 `filename*` parameter first, or non-ASCII names arrive as `_berblick.md`
   (Appendix B, `filenameFromDisposition`).
5. **New HTTP statuses reach the generic error UI:** `202` (accepted for processing),
   `410` (content destroyed), `413` (file too large), `415` (file refused). Phase 1's
   `toApiError` already handles any status; add designed messages (§8).
6. **Organization details (E25) are now also read by the vault**, for the workspace's
   chunking defaults shown as "inherited" values in the knowledge-base form (§6.6).
7. **Phase 2's "Document processing" card** (workspace chunk defaults) now has a visible
   effect. Link to it from the knowledge-base form: "Inherited from workspace settings".

---

## 3. The access model you are building a UI for

Read this section before building any screen. Every refusal Phase 3 can produce comes
from one of these rules, and the "hidden means 404" rule shapes every screen.

### 3.1 Three gates, checked in this order

Every knowledge request passes three independent checks:

1. **Role permission** (the route's permission, such as `document:create`). Missing →
   `403 PERMISSION_DENIED` with `details.missingPermissions`. This is checked **first**,
   before the server looks up anything: the auditor, who can read HR Policies but lacks
   `document:create`, gets `PERMISSION_DENIED` when uploading there, not `404`.
2. **Compartment** (your access level on the knowledge base, §3.2). A base you cannot see
   → `404 KNOWLEDGE_BASE_NOT_FOUND`. One you can see at too low a level → `403
   KNOWLEDGE_BASE_ACCESS_DENIED` with `details: { required, granted }`.
3. **Clearance** (§3.3). A document above your clearance → `404 DOCUMENT_NOT_FOUND`.
   Assigning a classification above your clearance → `403
   CLASSIFICATION_EXCEEDS_CLEARANCE` with `details: { requested, clearance }`.

A level says **where** you may act; the role permission says **what** you may do. Both
are required.

### 3.2 Compartments: access modes, levels and grants

Every knowledge base has an **access mode**:

| Mode | Who can see it | Effective level |
|---|---|---|
| `WORKSPACE` | everyone with the route permission (`knowledgebase:read`, `document:read`, …) | `MANAGE` for everyone who can see it; role permissions alone decide what they may do |
| `RESTRICTED` | only principals with a **grant**: to them as a member, to one of their roles, or to their API key | the **highest** of their grants; no grant → the base does not exist for them |

**Levels:** `READ` (see the base and its documents, read chunks, download, search, PII
report) < `WRITE` (upload, edit, reclassify, reindex, delete documents) < `MANAGE` (edit
the base, list and change its grants, delete it).

**Who bypasses compartments:** only holders of `*:*`, which means the workspace **owner**
(and platform administrators). **Not the Administrator role**: running a workspace is not
the same entitlement as reading its HR files. Verified: `admin@acme.test` does not see HR
Policies at all.

**Grants** (E65–E67):

- A grant names a **role**, a **member** (by **membership id**, not user id; a user id is
  refused with `404 RESOURCE_NOT_FOUND`) or an **API key**, at one level.
- Granting the same subject again changes its level (upsert, same grant id).
- Grants are stored on `WORKSPACE`-mode bases too, but only take effect while the base is
  `RESTRICTED`.
- A grant whose subject has gone (role deleted, member removed, key revoked) stops
  working and disappears from the grant list.
- Creating a `RESTRICTED` base, or switching one to `RESTRICTED`, **automatically grants
  you `MANAGE`** as a member, so you do not lock yourself out (the owner gets no grant: they
  do not need one). Verified: the admin who created "Finance Reports" appears as
  `MEMBER · Ahmad Hanbal · MANAGE`.
- **You can lock yourself out.** Revoking or lowering your own grant takes effect at once.
  Verified: the admin revoked their own grant and immediately got `404` on the base; only
  another `MANAGE` holder or the owner could restore it. Warn before doing it (§6.7).

### 3.3 Clearance and classification

Every document has a **classification**: `PUBLIC` < `INTERNAL` < `CONFIDENTIAL` <
`RESTRICTED`. Every principal has a **clearance**: the highest tier whose permission they
hold. Clearance is hierarchical.

| Clearance | Needs | Reads |
|---|---|---|
| `PUBLIC` | nothing | `PUBLIC` |
| `INTERNAL` | `clearance:internal` | `PUBLIC`, `INTERNAL` |
| `CONFIDENTIAL` | `clearance:confidential` | … and `CONFIDENTIAL` |
| `RESTRICTED` | `clearance:restricted` | everything |

- You can read a document only if **both** your clearance covers its classification
  **and** you can see its knowledge base. Neither alone is enough: the HR Manager can
  see the Handbook but not a `RESTRICTED` file in a base without a grant; the auditor
  can see HR Policies but not its `RESTRICTED` payroll file.
- You can only **assign** classifications within your clearance: on upload, when
  reclassifying (both the current and the new level), and as a knowledge base's default
  classification.
- Each knowledge base has a **default classification** for uploads that do not choose
  one. An upload with no classification into a base whose default is above your clearance
  is refused with `CLASSIFICATION_EXCEEDS_CLEARANCE`, so the upload form must always
  send a classification the user can assign (§6.2).
- API keys never hold `clearance:restricted`, so a machine can never read `RESTRICTED`
  documents.

### 3.4 Hidden means 404, everywhere

The server never confirms that something you cannot see exists. Build every screen around
this:

| Situation | What the server does |
|---|---|
| List knowledge bases | Restricted bases without a grant are omitted |
| A base's `stats` | Count only documents within your clearance |
| List documents | Documents above your clearance or in hidden bases are omitted |
| `?knowledgeBaseId=` naming a hidden base | `404 KNOWLEDGE_BASE_NOT_FOUND` |
| `?classification=` above your clearance | an empty page, not an error |
| Get, edit, chunk, download or report a hidden document | `404 DOCUMENT_NOT_FOUND` (and the probe is audited) |
| Upload a duplicate of a document above your clearance | `409 DOCUMENT_DUPLICATE` with **empty** `details` (it names the existing copy only to someone who can see it) |
| Retrieval narrowed to a hidden base (`knowledgeBaseIds`) | `404 KNOWLEDGE_BASE_NOT_FOUND` with `details.knowledgeBaseIds` |
| Retrieval narrowed to a hidden document (`documentIds`) | no results from it, silently |

Two users can therefore see different totals for the same workspace. That is correct;
never "fix" it on the client.

### 3.5 Who can do what

"Level" is your effective level on the document's knowledge base (the `access` field of
E60/E62).

| Action | Permission(s) | Level | Extra rule |
|---|---|---|---|
| See knowledge bases | `knowledgebase:read` | READ | |
| See documents, read chunks | `document:read` | READ | classification within clearance |
| Upload | `document:create` | WRITE | classification within clearance |
| Edit metadata, reclassify | `document:update` | WRITE | old and new classification within clearance |
| Reindex, retry a failed document | `document:reindex` | WRITE | only when `READY` or `FAILED` |
| Delete a document | `document:delete` | WRITE | |
| Download the original | `document:download` | READ | |
| PII report | `document:read` **and** `pii:policy:read` | READ | revealing values also needs `pii:reveal` |
| Search (retrieval), "what can I reach" | `rag:query` | READ | |
| See a base's grants | `knowledgebase:read` | MANAGE | |
| Change grants | `knowledgebase:update` | MANAGE | |
| Create a knowledge base | `knowledgebase:create` | — | default classification within clearance |
| Edit a knowledge base | `knowledgebase:update` | MANAGE | default classification within clearance |
| Delete a knowledge base | `knowledgebase:delete` | MANAGE | |

Helper: `canOnKnowledgeBase(action, knowledgeBase, myPermissions)` in Appendix B
(`lib/knowledge/access.ts`) implements this table.

### 3.6 The demo workspace, verified

Every cell below was observed against the server.

| | owner | admin | hr | employee | auditor |
|---|---|---|---|---|---|
| Role | Owner | Administrator | HR Manager | Member | Compliance Auditor |
| Clearance | RESTRICTED | CONFIDENTIAL | RESTRICTED | INTERNAL | CONFIDENTIAL |
| Company Handbook (`WORKSPACE`) | MANAGE | MANAGE | MANAGE | MANAGE | MANAGE |
| HR Policies (`RESTRICTED`: HR Manager MANAGE, Auditor READ) | MANAGE (bypass) | hidden | MANAGE | hidden | READ |
| Upload (`document:create`) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Edit / reclassify (`document:update`) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Reindex (`document:reindex`) | ✓ | ✓ | ✗ | ✓ | ✗ |
| Delete document (`document:delete`) | ✓ | ✓ | ✗ | ✗ | ✗ |
| Download (`document:download`) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Search (`rag:query`) | ✓ | ✓ | ✓ | ✓ | ✗ |
| PII report (`pii:policy:read`) | ✓ | ✓ | ✗ | ✓ | ✓ |
| Reveal PII values (`pii:reveal`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Create / edit / delete bases | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✗ | ✗ | ✗ |

Consequences worth designing for: the HR Manager manages HR Policies but cannot delete
documents there, retry a failed one or open its PII report; the employee can search the
Handbook but not download from it; the auditor sees everything up to `CONFIDENTIAL`,
including HR Policies, but has no search at all.

### 3.7 The UI rules (compute these once, use them everywhere)

```ts
myPermissions    = the expanded permission set                    // Phase 1 §5.2
myClearance      = clearanceOf(myPermissions)                      // Appendix B; = E77 clearance
assignable       = classifications up to myClearance               // upload, reclassify, base default
can(action, kb)  = every permission of the action ∈ myPermissions
                   && level(kb.access) ≥ required level             // §3.5
```

Hide what the user can never do in this workspace (no permission at all); **disable** what
they could do elsewhere but not here (the level is too low), with a tooltip such as "You
have read-only access to HR Policies". Handle every `403` and `404` anyway: grants and
roles can change while the page is open.

---

## 4. Concepts the screens depend on

### 4.1 The document lifecycle

```
                                 ┌───────────────────── reindex / retry ─────────────────────┐
                                 ▼                                                            │
  upload ─▶ UPLOADED ─▶ PARSING ─▶ CHUNKING ─▶ EMBEDDING ─▶ READY ──────────────────────────┤
               │           │           │            │                                         │
               └───────────┴───────────┴────────────┴──▶ FAILED ─────────────────────────────┘
```

| Status | Mockup label | Meaning | Typical time |
|---|---|---|---|
| `UPLOADED` | PENDING | Stored (encrypted), waiting for a worker | seconds; longer when many files queue |
| `PARSING` | INDEXING | The AI service is extracting text | seconds to minutes (large PDFs) |
| `CHUNKING` | INDEXING | Chunks being encrypted and saved | usually under a second; you may never see it |
| `EMBEDDING` | INDEXING | Chunks being embedded and indexed, batch by batch | seconds to minutes |
| `READY` | INDEXED | Searchable | |
| `FAILED` | FAILED | See `failureCode` and `statusMessage` | |

Verified timelines on the stand-ins server: `UPLOADED → PARSING → EMBEDDING → READY` in
about 2.5 s; a permanent failure `UPLOADED → PARSING → FAILED`; a transient one retries
while staying in `PARSING` (§4.1.3) before `FAILED`.

#### 4.1.1 Status is the latest run; `isSearchable` is what retrieval serves

A document has two version numbers: `indexVersion` (the run in progress or last run) and
`activeIndexVersion` (the version retrieval serves, `null` until the first run succeeds).
`isSearchable` is `activeIndexVersion !== null`.

- **First processing:** `isSearchable` is `false` until `READY`.
- **Reindex:** `indexVersion` goes up, the status restarts at `UPLOADED`, but
  `activeIndexVersion` stays on the old version, so **the document keeps answering
  queries** throughout. Verified: `PARSING v2 active=1 searchable=true` →
  `EMBEDDING v2 active=1` → `READY v2 active=2`.
- **A failed reindex keeps the previous version searchable.** Verified: `FAILED v2
  active=1 searchable=true`, and search and the chunk view still return version 1.
  Show "Reindex failed · previous version still searchable", not a plain "Failed".

Helper: `displayStatus(document)` in Appendix B.

#### 4.1.2 What a failure looks like

A `FAILED` document has `failureCode` (a machine code) and `statusMessage` (a sentence
written for the user). **Always show `statusMessage`.** Use `failureCode` only to choose
an icon, a hint and whether to offer **Retry** (E74, which needs `document:reindex`).

| `failureCode` | Cause | Retry helps? | Hint |
|---|---|---|---|
| `DOCUMENT_EMPTY` | No extractable text: "No extractable text was found. Scanned documents need OCR support in the AI service." | no | Upload a text-based PDF or DOCX |
| `ENCRYPTED_DOCUMENT`, `UNPARSEABLE_DOCUMENT`, `TOO_MANY_CHUNKS`, `UNSUPPORTED_FILE_TYPE`, `DOCUMENT_TOO_LARGE` | The AI service refused this file; `statusMessage` is its explanation ("The PDF is password protected. …") | no | Fix the file, delete this one, upload again |
| `AI_SERVICE_UNAVAILABLE` | "The AI service was unavailable." after every retry | yes, later | |
| `VECTOR_STORE_UNAVAILABLE` | "The vector store was unavailable." / "…rejected the document's vectors." | yes, later | |
| `OBJECT_STORAGE_UNAVAILABLE` | "Document storage was unavailable." | yes, later | |
| `INGESTION_TIMEOUT` | Over the processing time budget (30 min) | yes | Very large file: consider splitting it |
| `CONTENT_MISSING`, `CONTENT_INTEGRITY_FAILURE` | The stored file is gone or failed its integrity check | no | Delete and upload again |
| anything else | `INGESTION_ERROR` or a code the AI service invented | yes | Show `statusMessage` |

The set is open: the AI service may add codes. Never switch exhaustively on
`failureCode`.

#### 4.1.3 Retries are visible while the status stays in progress

A transient failure is retried with exponential backoff (5 attempts by default, starting
at 15 s). Between attempts the status **stays** where it was and `statusMessage` says so.
Verified sequence:

```
PARSING
PARSING  "Attempt 1 of 3 failed (AI_SERVICE_UNAVAILABLE); retrying."
PARSING
PARSING  "Attempt 2 of 3 failed (AI_SERVICE_UNAVAILABLE); retrying."
FAILED   "The AI service was unavailable."   failureCode AI_SERVICE_UNAVAILABLE
```

So `statusMessage` on an in-progress document is a warning to show under the status
("Retrying: the AI service was unavailable"), not an error.

#### 4.1.4 No push events: poll

There are no realtime events for documents. Poll while anything visible is in progress
(§10.3). `lastStatusAt` changes on every transition and as a heartbeat during embedding,
which is how you tell "slow" from "stuck".

### 4.2 Chunking settings are inherited

A document is chunked with a size and overlap (in tokens), each taken from the most
specific level that sets it:

```
knowledge base (chunkSize / chunkOverlap)  →  workspace settings (defaultChunkSize /
defaultChunkOverlap, Phase 2 §5.7)  →  platform default (512 / 64 unless the deployment changed it)
```

- `null` on a knowledge base means "inherit". Send `null` to go back to inheriting
  (fixed today, §11).
- The overlap must be smaller than the size **that will actually apply**, including
  inherited values. The server checks this with `422` on the field you sent (fixed today).
- Changes apply to documents processed **after** the change. Offer "Reindex all documents
  in this knowledge base" as a follow-up (a loop over E74; there is no bulk endpoint).
- The **embedding model** (`embeddingModel`, `embeddingDimensions`) is fixed when the base
  is created. Show it read-only.

### 4.3 Deleting destroys content

Each document is encrypted with its own key. Deleting a document (E75) or a knowledge base
(E64) destroys the key in the same transaction, so the content is unrecoverable at once,
backups included. The stored file and the vectors are purged in the background (verified:
gone within about a second). There is no trash and no undo. The confirmation dialog must
say so, and deleting a knowledge base should require typing its name.

### 4.4 What retrieval returns

- **Modes:** `hybrid` (the default: dense vectors and keyword matching fused by
  reciprocal rank fusion) or `dense` (vectors only, where `minScore` applies).
- **Scores are comparable only within one response.** Cosine similarity in dense mode, a
  fused rank score in hybrid mode (often small numbers such as 0.016 in production), a
  cross-encoder score when reranked. **Never show a score as a percentage or "match
  quality".** Show the rank, and at most a bar relative to the top result.
- **Hybrid mode has no relevance threshold.** It returns the best `topK` passages even
  when nothing is really relevant. Verified: "zebra quantum volcano" returned seven
  passages. An empty result means there was nothing searchable in your scope, not "no
  good match".
- `topK` defaults to 8 and is capped at 50: `topK: 200` is answered with `topK: 50`.
- `rerank: true` asks the AI service's cross-encoder to reorder; if it has none, the
  answer comes back with `reranked: false` rather than an error.
- The passage `text` is the **unmasked** text of a chunk you are cleared to read. Masking
  applies when text is sent to a model (Phase 5), not here.
- Every query is audited (`rag.query.executed`) **without the query text**. When the
  policy withheld relevant documents from you, `rag.access.filtered` records which (Phase
  8 shows these).

### 4.5 What the PII report is

The platform masks personal data **when text is about to reach a model**, not during
ingestion. The report (E78) shows, for each chunk, exactly what a model would receive if
that chunk were retrieved: `maskedText` with placeholders such as `[PERSON_1]`,
`[EMAIL_ADDRESS_1]`, and the list of detections.

- Detections come from pattern recognizers (email, phone, card, IBAN, CNIC, salary, …)
  and, for names and places, a statistical NER model in the AI service.
- If the NER detector is down, the workspace policy decides: `DEGRADE_TO_PATTERNS` →
  `degraded: true` and names are **not** masked; `REFUSE` → `503
  PII_DETECTION_UNAVAILABLE`. Both verified.
- If the workspace turned redaction off, `maskedText` is the original text and there are
  no detections (verified). Say so explicitly (§6.5).
- Real values appear only with `reveal=true`, which needs `pii:reveal` (only the owner in
  the demo) and writes a CRITICAL `pii.unmasked` audit record every time.

---

## 5. Routes and navigation

| Route | Visible when | Screen |
|---|---|---|
| `/w/:slug/documents` | `knowledgebase:read` or `document:read` | §6.1 Document Vault |
| `/w/:slug/documents?kb=&status=&classification=&q=&sort=&dir=&page=` | same | the vault's filters live in the URL, so views can be shared and reloaded |
| `/w/:slug/documents/:documentId` | `document:read` | §6.4 Document detail (a drawer over the vault, with its own URL) |
| `/w/:slug/documents/:documentId/chunks` | `document:read` | detail, Chunks tab |
| `/w/:slug/documents/:documentId/pii` | `document:read` + `pii:policy:read` | detail, PII report tab (§6.5) |
| `/w/:slug/knowledge-bases` | `knowledgebase:read` | §6.6 Knowledge bases |
| `/w/:slug/knowledge-bases/new` | `knowledgebase:create` | §6.6 create |
| `/w/:slug/knowledge-bases/:kbId` | `knowledgebase:read` | §6.6 settings (read-only below MANAGE + `knowledgebase:update`) and §6.7 Access |
| `/w/:slug/search` | `rag:query` | §6.8 Retrieval playground |

Sidebar (mockup): under **Documents**, a "KNOWLEDGE BASES" group lists the bases from E60
with `stats.documents`, each linking to `/documents?kb={id}`, plus "Manage" (to
`/knowledge-bases`) and "Search" (to `/search`, if `rag:query`).

A document or base that returns `404` on direct navigation shows "This document doesn't
exist or you don't have access to it." (the same words for both cases, never "access
denied").

---

## 6. Screens

Conventions from Phases 1 and 2 apply: loading, empty and error states everywhere; the
request id in error toasts; confirmation dialogs for destructive actions; buttons disabled
while their request runs.

### 6.1 Document Vault (`/w/:slug/documents`)

Layout from mockup 5: header, drop zone, toolbar, table, and a right-hand column of three
panels.

**Header:** "Document Vault", subtitle "Secure RAG pipeline · {n} documents"
(`meta.pagination.totalItems` of the current query), button **Upload documents**
(shown when the user can upload to at least one base; §6.2).

**Drop zone:** "Drop PDF, DOCX, TXT or Markdown files here" (the mockup's list, plus
Markdown; spreadsheets such as the mockup's `.xlsx` are **not** accepted), sub-line "Files
are encrypted before storage · chunked and embedded · PII masked before any model sees
it". Dropping files opens the upload dialog (§6.2) with them. Hidden when the user cannot
upload anywhere.

**Toolbar:**

- **Search box** with a mode switch:
  - **Titles** (default, every user): filters the table by title (`search`, debounced
    300 ms; case-insensitive "contains"; `%` and `_` match literally).
  - **Ask** (needs `rag:query`; the mockup's "Semantic search across all documents"):
    runs retrieval (E76) over the current knowledge-base filter and shows passages in a
    results panel above the table, each linking to its document. This is the only
    semantic search the API offers; the table itself cannot be ranked by meaning.
- **Filter** menu: knowledge base (from E60), status, classification (only those within
  the user's clearance; others always return nothing).
  - Status options map to the mockup's badges: **Indexed** (`READY`), **Indexing**
    (`PARSING,CHUNKING,EMBEDDING`, one request since §11 BF-18), **Pending**
    (`UPLOADED`), **Failed** (`FAILED`).
- **Sort** menu: Newest (default: `createdAt` DESC), Oldest, Title A–Z / Z–A (`title`),
  Largest (`sizeBytes` DESC), Recently updated (`updatedAt` DESC), Status (`status`).

**Table** (E69, 20 per page, pagination from `meta.pagination`):

| Column | Source |
|---|---|
| (checkbox) | bulk selection (below) |
| Document | file-type icon from `fileType`; **`title`**; below it `originalFilename` when different from the title, and "Added {createdAt, date}" |
| Knowledge base | name, from the E60 list by `knowledgeBaseId` |
| Classification | badge: PUBLIC grey, INTERNAL blue, CONFIDENTIAL amber, RESTRICTED red. (Replaces the mockup's "PII Found" column, §6.10) |
| Size | `sizeBytes` (a **string**) formatted with `formatBytes` (Appendix B) |
| Chunks | `chunkCount`, or "—" while it is 0 and the document is not searchable |
| Status | badge from `displayStatus` (Appendix B): INDEXED / INDEXING (+ stage) / PENDING / FAILED; "Retrying…" or "Reindexing" as a second line when relevant |
| (actions) | **View** (opens §6.4), **Delete** (`deleteDocument`), overflow: Download, Reindex / Retry, PII report, each shown per §3.5 |

**Bulk actions** on selected rows: Reindex, Reclassify, Delete. There are no bulk
endpoints: run the single calls one at a time with a progress toast ("Reindexing 3 of 12…"),
skip rows the user cannot act on, and report per-row failures at the end. Stay well under
the 120-requests-per-minute default budget (for example, 4 calls per second at most).

**Empty states:**

- No documents at all, can upload: "Your vault is empty. Drop files here or use Upload
  documents."
- No documents at all, cannot upload: "No documents you can access yet."
- Filters exclude everything: "No documents match these filters." + **Clear filters**.
- The `kb` filter names a base that answered `404`: remove the filter, show "That
  knowledge base no longer exists or you no longer have access to it."

**Right-hand panels:**

1. **RAG pipeline status** (§6.3).
2. **Vault statistics**, summed over E60 (all pages): Documents (`stats.documents`),
   Indexed (`ready`), Processing (`processing`), Failed (`failed`), Storage used
   (`totalBytes`, a string). Label the storage tile "in documents you can access": it is
   **not** the workspace's quota usage, which also counts documents above your
   clearance. (The mockup's "Vector embeddings" and "PII entities masked" tiles: §6.10.)
3. **PII redaction preview** (if `pii:policy:read`): for the selected document, the first
   chunk with detections from E78 (`limit=5`, page 1), with placeholders highlighted. No
   selection or no detections: "Personal data is masked before any model sees it. Select
   a document to preview." Load it on selection only, never on hover: the report is
   limited to 30 requests per minute.

### 6.2 Upload

**Opening:** the Upload documents button, or files dropped on the drop zone or the page.

**Dialog fields:**

| Field | Rules |
|---|---|
| Knowledge base | only bases where `canOnKnowledgeBase('upload', kb)`; preselect the vault's `kb` filter if uploadable. If none: replace the dialog with "You can't upload to any knowledge base. Ask for write access." |
| Classification | options: the user's assignable classifications (§3.3). Preselect the base's `defaultClassification` when assignable; otherwise preselect the highest assignable level and show "This knowledge base normally classifies uploads as {default}, above your clearance." **Always send it.** |
| Title | only when exactly one file is selected; ≤255; placeholder is the filename without extension (what the server uses when omitted) |
| Description | ≤2000, optional (applies to every file in this batch) |
| Tags | chip input; each ≤40 characters, ≤20 tags; sent as one comma-separated string; the server trims, lower-cases and de-duplicates them |

**Before sending, check each file on the client** (Appendix B `precheckFile`), and list
problems without sending those files:

- extension must be `.pdf`, `.docx`, `.txt`, `.text`, `.md` or `.markdown` (the server
  decides the type from the **content** and requires it to agree with the extension; the
  `Content-Type` you send is ignored);
- not empty;
- at most 50 MB (52,428,800 bytes, `UPLOAD_MAX_FILE_SIZE`).

**Sending:** one request per file (the server accepts exactly one file per request;
a second file part is refused with `400 "Too many files"`), at most **3 in parallel**,
through `uploadDocument` (Appendix B), each row showing a progress bar from upload
progress events. The server allows **120 s for the whole request, including the
transfer**: a 50 MB file needs at least about 3.5 Mbit/s upstream, otherwise it ends with
`408 REQUEST_TIMEOUT`. Say so in the error.

**Rate limit:** 100 uploads per hour per user (`x-ratelimit-limit: 100` on every upload
response). Refuse more than 100 files per drop, read `x-ratelimit-remaining` from each
response, and when it reaches 0 keep the rest queued with "Upload limit reached. The rest
will start in {retry-after}."

**On `202`:** the row turns into "Uploaded · queued for processing", the document appears
in the table (invalidate the list and the bases' stats, §10.4), and polling starts.

**Per-file errors** (`describeUploadError`, Appendix B):

| Status / code | Message on the file's row | Action |
|---|---|---|
| `409 DOCUMENT_DUPLICATE` with `details.existingDocumentId` | "Already in this knowledge base as “{existingTitle}”." | **Open it** (§6.4) |
| `409 DOCUMENT_DUPLICATE` without details | "An identical file is already in this knowledge base." | none (the copy is above the user's clearance: do not say that) |
| `415 DOCUMENT_TYPE_NOT_ALLOWED`, `DOCUMENT_CONTENT_MISMATCH`, `DOCUMENT_EMPTY` | show `error.message`; it is specific: "Files with the .exe extension are not accepted.", "The file is named .txt but its contents are a PDF.", "The document contains macros. Save it as a macro-free .docx and upload again.", "The archive is truncated or corrupt.", "The file is empty." (`details.reason` is `TYPE_NOT_ALLOWED`, `CONTENT_MISMATCH`, `MACROS_PRESENT`, `MALFORMED`, `ARCHIVE_TOO_LARGE` or `EMPTY`) | remove |
| `413 PAYLOAD_TOO_LARGE` | "Larger than the 50 MB limit." | remove |
| `403 CLASSIFICATION_EXCEEDS_CLEARANCE` | "You can't classify documents above {details.clearance}." | fix the classification |
| `403 KNOWLEDGE_BASE_ACCESS_DENIED` | "You have read-only access to this knowledge base." | refetch bases |
| `404 KNOWLEDGE_BASE_NOT_FOUND` | "This knowledge base no longer exists or you lost access to it." | refetch bases |
| `403 STORAGE_QUOTA_EXCEEDED` | `error.message` ("This upload would exceed the workspace's 1 GB storage quota.") + "{usedBytes} of {quotaBytes} used" | stop the queue |
| `403 PERMISSION_DENIED` | "You don't have permission to upload documents." | refetch permissions |
| `408 REQUEST_TIMEOUT` | "The upload took too long. Try a faster connection or a smaller file." | retry |
| `429 RATE_LIMIT_EXCEEDED` | "Upload limit reached. Try again in {mm:ss}." | requeue after `Retry-After` |
| `422 VALIDATION_FAILED` | the field messages (title, description, tags, classification) | fix |
| `503 KNOWLEDGE_LAYER_NOT_CONFIGURED`, `OBJECT_STORAGE_UNAVAILABLE` | "Uploads are unavailable right now." (§6.9) | stop the queue |

**Duplicates:** detection is by content, per knowledge base. The same file may exist in
two bases (verified), and a deleted document's file can be uploaded again at once
(verified).

### 6.3 Pipeline status panel and polling

The mockup's "RAG pipeline status" panel lists five stages. Map them to the lifecycle:

| Mockup stage | Status reached | Note |
|---|---|---|
| 1. Text extraction | `PARSING` | |
| 2. Chunking ({size} tokens) | `CHUNKING` | size: the base's `chunkSize`, else the workspace's `settings.defaultChunkSize`, else "default" |
| 3. PII scan & redact | (not an ingestion stage) | label it "PII masked at query time" with a shield icon, linking to the PII report. Do not animate it as part of processing |
| 4. Embedding ({model}) | `EMBEDDING` | `embeddingModel` of the base (for example `nomic-embed-text`) |
| 5. Vector store | `READY` | "Searchable" |

- **With a document selected:** stages before its status show a check, the current one a
  spinner, later ones empty; `FAILED` marks the stage it failed in red with
  `statusMessage` below. During a reindex add "Previous version still searchable".
- **With nothing selected:** show the configuration (chunk size, embedding model) and the
  counts of Pending, Indexing and Failed documents in view.

Polling rules are in §10.3.

### 6.4 Document detail (drawer: `/w/:slug/documents/:documentId`)

Data: E70, refetched while in progress (§10.3). Tabs: **Overview**, **Chunks**, **PII
report** (if `pii:policy:read`).

**Overview:**

- Title, classification badge, status badge (`displayStatus`), knowledge base name.
- Facts: original filename, type (`fileType` / `mimeType`), size, pages (`pageCount`, or
  "—" for text files), language, chunks, tokens, embedding model, uploaded by (match
  `uploadedById` to a member's `userId` from E37; `null` means an API key uploaded it or
  the account has since been erased; no matching member: "Former member"), added
  (`createdAt`), last change (`updatedAt`), processed (`processingCompletedAt`).
- Description and tags.
- **Processing** (collapsible): `processingMetrics` as a small timing bar: `queueWaitMs`,
  `parseMs`, `persistMs`, `embedMs`, `indexMs`, `totalMs`, plus `attempts` and
  `embeddingTokens`. Keys may be missing; show only those present.
- Failure box when `FAILED` (§4.1.2).

**Actions** (each per §3.5):

- **Edit** (`editDocument`): title (required, ≤255), description (≤2000; empty clears),
  tags → E73 with only the changed fields.
- **Reclassify** (`editDocument`): a select limited to assignable classifications. When
  lowering: "Lowering the classification makes this document visible to more people."
  When raising: "People below {new level} lose access immediately, including in search."
  → E73 `{ classification }`. It applies to retrieval immediately (verified: an employee
  saw the document at once after a declassification, and lost it after raising it back).
- **Reindex** (`reindex`, when `READY`): "Re-run text extraction and embedding. The
  current version keeps answering searches until the new one is ready." → E74.
- **Retry** (`reindex`, when `FAILED`): same call, labelled Retry. Hide it for failure
  codes where it cannot help (§4.1.2) or show it with "This will probably fail again".
  If the user lacks `document:reindex` (the HR Manager), show "Ask someone who can
  reindex documents to retry it."
- **Download** (`download`): `downloadDocument` (Appendix B). Takes up to 120 s on the
  server for big files; show a spinner on the button. Every download is audited.
- **Delete** (`deleteDocument`): "Delete “{title}”? Its content is destroyed immediately
  and cannot be recovered, including from backups." → E75 → close the drawer, invalidate
  the list and stats.

Errors: `404` → "This document no longer exists or you no longer have access to it." and
close; `409 DOCUMENT_PROCESSING` on reindex → "Already being processed" and refetch;
`410 DOCUMENT_CONTENT_UNAVAILABLE` on download → "The stored file is no longer available.
Delete this document and upload it again."; `403 CLASSIFICATION_EXCEEDS_CLEARANCE` on
reclassify.

**Chunks tab** (E71, 20 per page): each chunk as a card: `#chunkIndex`, pages
(`pageStart`–`pageEnd` when not null), `tokenCount`, and the text (monospace off,
preserve line breaks). This is exactly what retrieval serves. Empty when the document has
never become searchable: "No chunks yet. They appear when processing completes." During a
reindex it shows the **old** version's chunks until the new one is ready.

### 6.5 PII report tab (`/w/:slug/documents/:documentId/pii`)

Data: E78, `limit=10` per page (maximum 20).

- **Header:** "What an AI model sees", then counts **for this page**: `entityCount` and
  `byType` as chips ("PERSON 1 · EMAIL_ADDRESS 1 · PHONE_NUMBER 1"), with the note
  "Counts cover the chunks on this page." (`byType` and `entityCount` are per page, not
  per document; verified.)
- **Paging:** `page` and `totalChunks` are returned; compute pages as
  `ceil(totalChunks / limit)`. There is no `totalPages` field.
- **Chunks:** `maskedText` with each placeholder (`[TYPE_N]`) rendered as a coloured
  chip. Find them with the regular expression in Appendix B (`splitPlaceholders`) and
  match them to `entities[].placeholder`. Hovering a chip shows the entity type label,
  `score` and `source` (`pattern`, `ner`, `custom` or `propagation`). Use the `start`/`end`
  offsets only for sorting: they refer to a normalised form of the text (NFKC, line
  endings unified), which can differ from the chunk text in E71.
- **Legend and labels** from `GET …/pii/entity-types` (a Phase 4 endpoint that needs the
  same `pii:policy:read`; it returns `type`, `label`, `detector`, `available`, `enabled`,
  `example` for 20 types). Cache it for the session.
- **`degraded: true`:** amber banner "Name detection is unavailable, so only patterns
  (emails, phone numbers, card numbers…) are masked right now."
- **`503 PII_DETECTION_UNAVAILABLE`:** "Sensitive-data detection is unavailable, and this
  workspace refuses to show unprotected text to models. Try again later." (`details.hint`
  is written for administrators; show it only to users with `pii:policy:update`.)
- **Redaction turned off:** when `GET …/pii/policy` says `enabled: false`, show "PII
  redaction is turned off for this workspace: models receive this text unmasked." (the
  report then shows plain text and no detections).
- **Reveal** (only with `pii:reveal`): a **Show real values** toggle with the notice "Each
  reveal is recorded in the audit log as a critical event." → refetch with `reveal=true`;
  each entity then has `value`. Never cache revealed data (§10.2); hide the values again
  when the tab loses focus or after 60 s.
- Rate limit: 30 reports per minute per user. Page with buttons, not infinite scroll.
- A document that is not searchable yet (or failed) returns no chunks: "Nothing to report
  until the document is processed."

### 6.6 Knowledge bases (`/w/:slug/knowledge-bases`)

**List** (E60, 20 per page, default order: name A–Z): cards or rows with name,
description, access-mode badge (**Workspace** / **Restricted**, with a lock icon), your
access level (for restricted bases: Read / Write / Manage), default classification badge,
and stats: documents, indexed, processing, failed, size. Search by name (`search`),
sort by name, created or updated.

**Create** (`knowledgebase:create`) and **edit** (`editKnowledgeBase`) form:

| Field | Rules / notes |
|---|---|
| Name | required, 1–120 (trimmed); unique in the workspace, case-insensitive (`409 KNOWLEDGE_BASE_NAME_TAKEN` on the field). A deleted base's name can be reused at once. |
| Description | ≤2000; empty removes it |
| Access | **Workspace** "Everyone with document permissions can see it" / **Restricted** "Only people, roles and API keys you grant can see it. Everyone else won't know it exists." |
| Default classification | assignable classifications only (§3.3); default `INTERNAL` |
| Chunk size | 64–4096 tokens, or "Inherit ({workspace value or default})" (`null`) |
| Chunk overlap | 0–1024 tokens, smaller than the effective size, or "Inherit" (`null`) |
| Embedding model | read-only after creation: `embeddingModel` (`embeddingDimensions` dims) |

Create → E61; edit → E63 with only changed fields. Show chunk errors on the field the
server names in `details.fields` (`chunkOverlap` or `chunkSize`).

**Switching access mode** (edit):

- **Workspace → Restricted:** confirm "Only people and roles with a grant will see
  {name} and its documents. You'll get Manage access automatically." Then open the Access
  tab (§6.7) so the user can grant roles.
- **Restricted → Workspace:** confirm "Everyone with document permissions will see
  {name} and its documents up to their clearance. Existing grants are kept but have no
  effect while the base is open to the workspace."

**Delete** (`deleteKnowledgeBase`): danger zone; "Deleting {name} destroys its
{stats.documents} documents immediately. This can't be undone." (the count is only what you
can see; say "at least" if the user's clearance is below `RESTRICTED`); type the name to
confirm → E64 → back to the list, invalidate documents and stats.

A user without `knowledgebase:update` or below `MANAGE` sees the settings read-only with
"You have {level} access to this knowledge base."

### 6.7 Access (grants) tab

Visible on restricted bases to users at `MANAGE` (E65). On a workspace-mode base show
"This knowledge base is open to everyone with document permissions. Switch it to
Restricted to control access by grant." and hide the grant list (E65 would return the
dormant grants, if any).

**List:** subject type icon, `subjectLabel` (role name, member display name, or API key
"name (prefix)"), level select (Read / Write / Manage), granted date, remove button. A
level change → E66 with the same subject. Remove → E67.

**Add access:** a picker with three tabs, then a level:

- **Roles** from Phase 1 E27 (`role:read`). Explain: "Everyone holding this role, now and
  later."
- **Members** from Phase 2 E37 with `status=ACTIVE` (`member:read`). Send the member's
  **`id`** (membership id), never `userId`.
- **API keys** from Phase 2 E57 (`apikey:read`; hide the tab without it), active keys
  only. Explain: "Within its scopes, the key can list and read document details, upload,
  reindex and search. It can't read chunks or download, and never sees RESTRICTED
  documents."

Mark subjects that already have a grant and turn "Add" into "Change level" for them.

**Self-lockout guard:** before removing or lowering a grant, compute your own level
afterwards with `myLevelAfter` (Appendix B) from the grant list, your membership id and
your role ids (Phase 1 E26). If it drops below `MANAGE`: "You'll lose the ability to
manage {name}. Only the workspace owner or another manager can give it back." If it drops
to nothing: "You'll lose access to {name} completely." Owners never lose access
(they bypass compartments).

**Errors:** `404 RESOURCE_NOT_FOUND` "No active member with that id exists in this
workspace." (the member left or was removed: refetch members), "No active role…" or "No
active api key…"; `404 KNOWLEDGE_BASE_GRANT_NOT_FOUND` on remove (already removed:
refetch); `403 KNOWLEDGE_BASE_ACCESS_DENIED` (you are no longer a manager: refetch the
base); `404 KNOWLEDGE_BASE_NOT_FOUND` (you lost access: leave the page).

### 6.8 Retrieval playground (`/w/:slug/search`)

For `rag:query` holders. Also the target of the vault's **Ask** mode.

**Query panel:**

| Control | Maps to | Default |
|---|---|---|
| Question (textarea) | `query`, 1–2000 characters after whitespace is collapsed | — |
| Knowledge bases (multi-select from E77) | `knowledgeBaseIds` (empty = everything you can reach) | all |
| Results (1–50) | `topK` | 8 |
| Mode: Hybrid / Keyword + meaning, Dense / Meaning only | `mode` | hybrid |
| Minimum similarity (0–1, only in Dense) | `minScore` | none |
| Rerank | `rerank` | off |

Submit → E76 (a mutation; do not cache). Show a spinner; the server allows 60 s.

**Results:** one card per passage: rank, document title (link to §6.4; the document may
still show `404` for users who can search but lack `document:read`), knowledge base,
classification badge, pages when present, chunk number, and the text with the query's
words highlighted. Score: a thin bar relative to the top result, and the raw number on
hover (§4.4). Footer: "{results.length} passages from {knowledgeBasesSearched} knowledge
bases · {timings.totalMs} ms" with a details popover for the timing breakdown
(`accessMs`, `embedMs`, `searchMs`, `hydrateMs`, `rerankMs`). Show "Reranked" when
`reranked` is true.

**Empty result:** "No passages found in the {knowledgeBasesSearched} knowledge bases you
can search." and, when `knowledgeBasesSearched` is 0, "You don't have access to any
knowledge base with searchable documents yet."

**Your access panel** (E77): "Your clearance: {clearance}" with the readable
classifications as badges; "Owner: you can see every knowledge base" when
`bypassesCompartments`; the list of reachable bases with their access mode and your level.
Help text: "Search only returns passages you're allowed to read. Anything outside this
scope is never retrieved."

**Errors:** `404 KNOWLEDGE_BASE_NOT_FOUND` with `details.knowledgeBaseIds` → remove those
bases from the selection, refetch E77, and say "One knowledge base is no longer
available"; `422` on `query`; `429` "You've run 60 searches in a minute. Try again in
{s} s."; the `503`s of §6.9.

### 6.9 When the knowledge layer is unavailable

Keep everything that works working, and say precisely what does not.

| Response | Where | UI |
|---|---|---|
| `503 KNOWLEDGE_LAYER_NOT_CONFIGURED`, `details.missingConfiguration: ["STORAGE_S3_BUCKET", "QDRANT_URL", "AI_SERVICE_URL"]` | upload, reindex (needs all three), download (storage), retrieval (Qdrant + AI service) | A page-level info banner the first time it happens: "Document uploads and search aren't set up on this server yet." Disable Upload, Reindex, Download or Search accordingly for the session. Show `missingConfiguration` only to users with `workspace:update` (it names server settings) |
| `503 OBJECT_STORAGE_UNAVAILABLE` | upload, download | "Document storage is temporarily unavailable. Try again in a few minutes." |
| `503 AI_SERVICE_UNAVAILABLE` (`details.reason`, for example `AI_SERVICE_UNREACHABLE`) | retrieval | "Search is temporarily unavailable." |
| `503 VECTOR_STORE_UNAVAILABLE` | retrieval | "Search is temporarily unavailable." |
| `503 PII_DETECTION_UNAVAILABLE` | PII report | §6.5 |

Verified on a server with nothing configured: listing and creating knowledge bases,
listing documents, reading chunks, the access scope and the PII report all keep working.
Only the calls in the table fail.

### 6.10 Mockup 5 → API mapping

| Mockup element | Implementation |
|---|---|
| Header, "Secure RAG pipeline · N documents" | E69 `meta.pagination.totalItems` |
| Upload documents button, drop zone | §6.2. Accepted: PDF, DOCX, TXT, Markdown. **Not** `.xlsx` (the mockup's "Payroll_March_2024.xlsx" would be refused with `415`) |
| "Semantic search across all documents" | the toolbar's **Ask** mode → E76 (§6.1). The table's own search matches titles only |
| Filter, Sort | §6.1 toolbar |
| Columns Document, Knowledge Base, Size, Chunks, Status | E69 fields (§6.1) |
| Column **PII Found** | **Not available in the list**: PII detection runs when text goes to a model, and the report is per document, paged and rate-limited (30 per minute). Show the Classification column instead, and the PII report per document (§6.5). A per-document PII count would need a new backend feature (a scan at ingestion) |
| Status badges INDEXED / INDEXING / PENDING / FAILED | `displayStatus` (§4.1) |
| Row actions view / delete | §6.4, E75 |
| Sidebar "KNOWLEDGE BASES" with counts | E60 `stats.documents` (§5) |
| RAG pipeline status (5 steps) | §6.3; step 3 "PII scan & redact" is shown as applied at query time |
| Vault statistics: Total documents, Storage used | sums of E60 `stats` (§6.1) |
| Vault statistics: **Vector embeddings** | not provided by any endpoint. Leave it out (or show "Chunks: {sum of chunkCount}" over the documents on screen, labelled as such) |
| Vault statistics: **PII entities masked** | Phase 8: `GET …/analytics/overview` → `privacy.entitiesMasked` (needs `usage:read`). Leave the tile out until then |
| PII redaction preview | §6.1 panel 3, from E78 |

---

## 7. Endpoint reference (E60–E78)

Conventions as in Phases 1 and 2: paths relative to `/api/v1`; responses show `data` only
(the envelope wraps it); every endpoint needs `Authorization: Bearer …` and
`X-Organization-Id: <workspace uuid>` equal to `{organizationId}` in the path.
Abbreviation: `{ws}` = `/organizations/{organizationId}`. Path ids must be UUID v4, or the
answer is `400 BAD_REQUEST` "Validation failed (uuid v 4 is expected)".

### Summary

| # | Method & path | Permission | Level | Throttle | Timeout | API key | Screen |
|---|---|---|---|---|---|---|---|
| E60 | `GET {ws}/knowledge-bases` | `knowledgebase:read` | — | default | 30 s | ✓ | §6.6, sidebar |
| E61 | `POST {ws}/knowledge-bases` | `knowledgebase:create` | — | default | 30 s | ✗ | §6.6 |
| E62 | `GET {ws}/knowledge-bases/{kbId}` | `knowledgebase:read` | READ | default | 30 s | ✓ | §6.6 |
| E63 | `PATCH {ws}/knowledge-bases/{kbId}` | `knowledgebase:update` | MANAGE | default | 30 s | ✗ | §6.6 |
| E64 | `DELETE {ws}/knowledge-bases/{kbId}` | `knowledgebase:delete` | MANAGE | default | 30 s | ✗ | §6.6 |
| E65 | `GET {ws}/knowledge-bases/{kbId}/grants` | `knowledgebase:read` | MANAGE | default | 30 s | ✗ | §6.7 |
| E66 | `PUT {ws}/knowledge-bases/{kbId}/grants` | `knowledgebase:update` | MANAGE | default | 30 s | ✗ | §6.7 |
| E67 | `DELETE {ws}/knowledge-bases/{kbId}/grants/{grantId}` | `knowledgebase:update` | MANAGE | default | 30 s | ✗ | §6.7 |
| E68 | `POST {ws}/knowledge-bases/{kbId}/documents` (multipart) | `document:create` | WRITE | **upload** | **120 s** incl. transfer | ✓ | §6.2 |
| E69 | `GET {ws}/documents` | `document:read` | READ | default | 30 s | ✓ | §6.1 |
| E70 | `GET {ws}/documents/{documentId}` | `document:read` | READ | default | 30 s | ✓ | §6.4 |
| E71 | `GET {ws}/documents/{documentId}/chunks` | `document:read` | READ | default | 30 s | ✗ | §6.4 |
| E72 | `GET {ws}/documents/{documentId}/download` | `document:download` | READ | default | **120 s** | ✗ | §6.4 |
| E73 | `PATCH {ws}/documents/{documentId}` | `document:update` | WRITE | default | 30 s | ✗ | §6.4 |
| E74 | `POST {ws}/documents/{documentId}/reindex` | `document:reindex` | WRITE | default | 30 s | ✓ | §6.4 |
| E75 | `DELETE {ws}/documents/{documentId}` | `document:delete` | WRITE | default | 30 s | ✗ | §6.4 |
| E76 | `POST {ws}/rag/query` | `rag:query` | READ | **rag** | **60 s** | ✓ | §6.8 |
| E77 | `GET {ws}/rag/access-scope` | `rag:query` | — | default | 30 s | ✓ | §6.8 |
| E78 | `GET {ws}/pii/documents/{documentId}/report` | `document:read` + `pii:policy:read` | READ | **privacy** | 30 s | ✓ | §6.5 |

Throttle budgets (per signed-in user): **default** 120 per minute; **upload** 100 per hour;
**rag** 60 per minute; **privacy** 30 per minute. Each has its own bucket: using up the
search budget does not affect other calls (verified). "API key" says whether the endpoint
also accepts `X-API-Key` (useful when explaining what a key with a grant can do; the
browser always uses Bearer). A Bearer-only endpoint called with a key answers `401
AUTH_SCHEME_NOT_ALLOWED`.

Reused: Phase 1 E7 (`/auth/me` permissions), E25 (workspace settings for chunk defaults),
E26 (your membership id and roles, for the self-lockout guard), E27 (roles, for grants);
Phase 2 E37 (members) and E57 (API keys), for grants; Phase 4's `GET {ws}/pii/entity-types`
and `GET {ws}/pii/policy` (both `pii:policy:read`) for the PII report's legend and banner.

---

### E60. `GET {ws}/knowledge-bases`

**Query:** `page` (≥1), `limit` (1–100, default 20; above 100 is `422` "limit cannot exceed
100"), `search` (≤200; name contains, case-insensitive), `sortBy` (`name` | `createdAt` |
`updatedAt`; anything else means `name`), `sortDirection` (`ASC` | `DESC`, default
`DESC`). Without `sortBy` the order is name A–Z; with it, `sortDirection` applies (send
both).

**200:** paginated `KnowledgeBase[]`, only bases you can read. Example item:

```json
{
  "id": "8df97318-db90-49a0-8a1a-6d34cef3a182",
  "name": "Company Handbook",
  "description": "Policies and guides every employee may read.",
  "accessMode": "WORKSPACE",
  "defaultClassification": "INTERNAL",
  "embeddingModel": "nomic-embed-text",
  "embeddingDimensions": 768,
  "chunkSize": null,
  "chunkOverlap": null,
  "access": "MANAGE",
  "stats": { "documents": 0, "ready": 0, "processing": 0, "failed": 0, "totalBytes": "0" },
  "createdById": "d48f1424-3ea9-4b82-afb7-e7670ad831df",
  "createdAt": "2026-09-30T04:35:34.867Z",
  "updatedAt": "2026-09-30T04:35:34.867Z"
}
```

- `access`: your effective level (`MANAGE` on every workspace-mode base).
- `stats`: documents **within your clearance**; `processing` counts `UPLOADED`,
  `PARSING`, `CHUNKING` and `EMBEDDING`; `totalBytes` is a string (64-bit).
- `chunkSize` / `chunkOverlap`: `null` means inherited (§4.2).
- `createdById` is a user id.

### E61. `POST {ws}/knowledge-bases`

**Body:**

| Field | Rules |
|---|---|
| `name` | required, 1–120 after trimming |
| `description` | ≤2000 |
| `accessMode` | `WORKSPACE` (default) \| `RESTRICTED` |
| `defaultClassification` | default `INTERNAL`; within your clearance |
| `chunkSize` | integer 64–4096 |
| `chunkOverlap` | integer 0–1024; smaller than the effective chunk size (§4.2) |

**201:** the `KnowledgeBase` with `access: "MANAGE"` and zero stats. A `RESTRICTED` base
comes with a `MANAGE` grant for you (unless you are the owner).
**Errors:** `403 PERMISSION_DENIED` · `403 CLASSIFICATION_EXCEEDS_CLEARANCE`
`{ requested: "RESTRICTED", clearance: "CONFIDENTIAL" }` · `409
KNOWLEDGE_BASE_NAME_TAKEN` "A knowledge base with this name already exists in this
workspace." (case-insensitive) · `422` (fields; for example `name` "name should not be
empty", `accessMode` "accessMode must be one of the following values: WORKSPACE,
RESTRICTED", `chunkSize` "chunkSize must not be less than 64", unknown fields "property
extra should not exist"; chunk combination: message "Chunk overlap (300) must be smaller
than chunk size (256)." with `details.fields.chunkOverlap: ["must be smaller than the
chunk size (256)"]`).

### E62. `GET {ws}/knowledge-bases/{kbId}`

**200:** one `KnowledgeBase`. **Errors:** `404 KNOWLEDGE_BASE_NOT_FOUND` (unknown, deleted
or hidden: the same answer).

### E63. `PATCH {ws}/knowledge-bases/{kbId}`

**Body** (all optional; send only what changed): `name`, `description` (`null` or `""`
removes it), `accessMode`, `defaultClassification`, `chunkSize` / `chunkOverlap` (`null`
returns to inheriting). `name`, `accessMode` and `defaultClassification` cannot be `null`
(`422` on the field).
**200:** the updated `KnowledgeBase` (an empty or unchanged body returns it unchanged).
Switching to `RESTRICTED` grants you `MANAGE` (§3.2).
**Errors:** `403 PERMISSION_DENIED` (`knowledgebase:update`) · `403
KNOWLEDGE_BASE_ACCESS_DENIED` `{ required: "MANAGE", granted: "READ" }` · `403
CLASSIFICATION_EXCEEDS_CLEARANCE` · `404 KNOWLEDGE_BASE_NOT_FOUND` · `409
KNOWLEDGE_BASE_NAME_TAKEN` · `422` (as E61; a chunk conflict is filed under the field you
sent: `chunkOverlap`, or `chunkSize` "must be larger than the chunk overlap (600)" when you
only changed the size).

### E64. `DELETE {ws}/knowledge-bases/{kbId}`

No body. **200** `{ "deleted": true }`. Every document's key is destroyed in the same
transaction; the documents are gone from every list and return `404`; files and vectors
are purged in the background. **Errors:** `403 PERMISSION_DENIED`
(`knowledgebase:delete`; the demo HR Manager lacks it even with `MANAGE`) · `403
KNOWLEDGE_BASE_ACCESS_DENIED` · `404`.

### E65. `GET {ws}/knowledge-bases/{kbId}/grants`

**200** (oldest first, not paginated):

```json
[
  { "id": "7eaabe2f-8ce5-4ed1-a45f-5ec341895b57", "subjectType": "ROLE",
    "subjectId": "10655ad1-6b1b-4c4d-bbdf-a5a07cdd0b85", "subjectLabel": "HR Manager",
    "accessLevel": "MANAGE", "grantedById": "d48f1424-3ea9-4b82-afb7-e7670ad831df",
    "createdAt": "2026-09-30T04:35:34.889Z" },
  { "id": "6a05aaae-077d-43fc-9e2e-cce3cbc4fad7", "subjectType": "ROLE",
    "subjectId": "31af5f0e-d33c-4278-a933-a46733ac8c49", "subjectLabel": "Compliance Auditor",
    "accessLevel": "READ", "grantedById": "d48f1424-3ea9-4b82-afb7-e7670ad831df",
    "createdAt": "2026-09-30T04:35:34.912Z" }
]
```

`subjectId` is a role id, a **membership** id or an API key id. `subjectLabel`: the role
name; the member's workspace display name (else account name); for a key "{name}
({prefix})", for example `"AI service (daiap_sk_erFcoIik)"`. `grantedById` is a user id.
**Errors:** `403 KNOWLEDGE_BASE_ACCESS_DENIED` `{ required: "MANAGE", granted: "READ" }`
(verified for the auditor on HR Policies) · `404`.

### E66. `PUT {ws}/knowledge-bases/{kbId}/grants`

**Body** `{ "subjectType": "ROLE" | "MEMBER" | "API_KEY", "subjectId": "<uuid>",
"accessLevel": "READ" | "WRITE" | "MANAGE" }`. **200:** the grant (as in E65). Upsert:
granting an existing subject again returns the **same `id`** with the new level.
**Errors:** `404 RESOURCE_NOT_FOUND` "No active member with that id exists in this
workspace." / "No active role with that id exists in this workspace." / "No active api
key with that id exists in this workspace." · `403 PERMISSION_DENIED`
(`knowledgebase:update`) · `403 KNOWLEDGE_BASE_ACCESS_DENIED` · `404
KNOWLEDGE_BASE_NOT_FOUND` · `422` (`subjectType`, `subjectId` "subjectId must be a UUID",
`accessLevel`).

### E67. `DELETE {ws}/knowledge-bases/{kbId}/grants/{grantId}`

**200** `{ "revoked": true }`, effective on the next request. **Errors:** `404
KNOWLEDGE_BASE_GRANT_NOT_FOUND` "The access grant was not found." (including a second
revoke) · `403` · `404 KNOWLEDGE_BASE_NOT_FOUND`.

---

### E68. `POST {ws}/knowledge-bases/{kbId}/documents`: upload

**Request:** `multipart/form-data`. Do **not** set `Content-Type` yourself (the browser adds
the boundary).

| Part | Rules |
|---|---|
| `file` | **exactly one** file part named `file`; ≤50 MB; `.pdf`, `.docx`, `.txt`/`.text`, `.md`/`.markdown`. The type is detected from the bytes; the part's `Content-Type` is ignored. The filename is kept (UTF-8 is fine), with any path removed, `" * : < > ? |` replaced by `_`, leading dots removed, and cut to 200 characters. |
| `title` | optional, 1–255 (trimmed); default: the filename without its extension |
| `description` | optional, ≤2000; empty means none |
| `classification` | optional; default: the base's `defaultClassification`; must be within your clearance |
| `tags` | optional, **one comma-separated string**, ≤20 tags of ≤40 characters; trimmed, lower-cased, de-duplicated (`"Policy, remote ,policy,2026"` → `["policy","remote","2026"]`) |

No other parts: an unknown one is `422` (`"property foo should not exist"`), a second file
`400 "Too many files"`, a file under another name `400 "Unexpected file field -
document"`, a JSON body `400 "Attach the document as a multipart field named "file"."`.

**202** (accepted for processing): the `Document` with `status: "UPLOADED"`:

```json
{
  "id": "5db1a517-dfbe-4be9-8d18-68e0d1e80df0",
  "knowledgeBaseId": "8df97318-db90-49a0-8a1a-6d34cef3a182",
  "title": "leave-policy",
  "description": null,
  "tags": [],
  "originalFilename": "leave-policy.txt",
  "fileType": "TXT",
  "mimeType": "text/plain",
  "sizeBytes": "297",
  "classification": "INTERNAL",
  "status": "UPLOADED",
  "statusMessage": null,
  "failureCode": null,
  "isSearchable": false,
  "indexVersion": 1,
  "activeIndexVersion": null,
  "chunkCount": 0,
  "tokenCount": 0,
  "pageCount": null,
  "language": null,
  "embeddingModel": null,
  "processingMetrics": {},
  "uploadedById": "8ceb01e2-9320-4580-8748-b9391d6949ee",
  "lastStatusAt": "2026-09-30T04:39:25.852Z",
  "processingCompletedAt": null,
  "createdAt": "2026-09-30T04:39:25.850Z",
  "updatedAt": "2026-09-30T04:39:25.850Z"
}
```

**Errors, in the order the server checks them:**

| # | Status / code | When |
|---|---|---|
| 1 | `403 PERMISSION_DENIED`, `429 RATE_LIMIT_EXCEEDED` | no `document:create`; over 100 uploads in the hour (checked before the file is read) |
| 2 | `413 PAYLOAD_TOO_LARGE` "File too large"; `400 BAD_REQUEST` "Too many files" / "Unexpected file field - …" | while the file is received; `408 REQUEST_TIMEOUT` if receiving and processing take over 120 s |
| 3 | `422 VALIDATION_FAILED` | form fields (`title` "title should not be empty", `classification`, `tags` "tags must contain no more than 20 elements", "each value in tags must be shorter than or equal to 40 characters", unknown fields) |
| 4 | `503 KNOWLEDGE_LAYER_NOT_CONFIGURED` | storage, Qdrant or AI service not configured |
| 5 | `400 BAD_REQUEST` "Attach the document as a multipart field named "file"." | no file part |
| 6 | `404 KNOWLEDGE_BASE_NOT_FOUND` / `403 KNOWLEDGE_BASE_ACCESS_DENIED` `{ required: "WRITE", granted: "READ" }` | compartment |
| 7 | `415 DOCUMENT_EMPTY` / `DOCUMENT_TYPE_NOT_ALLOWED` / `DOCUMENT_CONTENT_MISMATCH` | content inspection; `details: { reason, allowedTypes: ["pdf","docx","txt","md"] }` |
| 8 | `403 CLASSIFICATION_EXCEEDS_CLEARANCE` | classification (sent or default) above your clearance |
| 9 | `409 DOCUMENT_DUPLICATE` | identical content already in this base; `details: { existingDocumentId, existingTitle }` only if you can see it |
| 10 | `503 OBJECT_STORAGE_UNAVAILABLE` | storage down |
| 11 | `403 STORAGE_QUOTA_EXCEEDED` | `details: { quotaBytes, usedBytes, incomingBytes }`; message "This upload would exceed the workspace's 300 KB storage quota." (the quota is 1 GB by default; the test used 300 KB) |

Verified `415` messages: "The file is empty." · "Files with the .exe extension are not
accepted." · "The file has no extension, so its type cannot be confirmed." · "The file is
named .txt but its contents are not a recognised document." · "The file is named .txt but
its contents are a PDF." · "The file is named .pdf but its contents are plain text." ·
"The file is named .docx but its contents are an archive that is not a Word document." ·
"The document contains macros. Save it as a macro-free .docx and upload again." (code
`DOCUMENT_TYPE_NOT_ALLOWED`, reason `MACROS_PRESENT`) · "The archive is truncated or
corrupt." (`DOCUMENT_TYPE_NOT_ALLOWED`, `MALFORMED`).

### E69. `GET {ws}/documents`

**Query:**

| Param | Values | Default |
|---|---|---|
| `page`, `limit` | ≥1; 1–100 | 1, 20 |
| `knowledgeBaseId` | uuid v4 of a base you can see (hidden → `404 KNOWLEDGE_BASE_NOT_FOUND`) | all you can see |
| `status` | one status, a comma-separated list (`PARSING,CHUNKING,EMBEDDING`), or the parameter repeated; up to 6 | any |
| `classification` | one classification; above your clearance → empty page | within your clearance |
| `search` | ≤200; title contains, case-insensitive; `%` and `_` literal | — |
| `sortBy` | `createdAt` \| `updatedAt` \| `title` \| `sizeBytes` \| `status` (others fall back to `createdAt`) | `createdAt` |
| `sortDirection` | `ASC` \| `DESC` (case-insensitive) | `DESC` |

**200:** paginated `Document[]` (E68 shape). Invalid values → `422` keyed by parameter,
for example `status`: "each value in status must be one of the following values: UPLOADED,
PARSING, CHUNKING, EMBEDDING, READY, FAILED", `page`: "page must be at least 1".
Title ordering follows the database collation; do not re-sort on the client.

### E70. `GET {ws}/documents/{documentId}`

**200:** one `Document`. A processed one:

```json
{
  "id": "5db1a517-dfbe-4be9-8d18-68e0d1e80df0",
  "title": "leave-policy",
  "status": "READY",
  "isSearchable": true,
  "indexVersion": 1,
  "activeIndexVersion": 1,
  "chunkCount": 4,
  "tokenCount": 51,
  "pageCount": null,
  "language": "en",
  "embeddingModel": "nomic-embed-text",
  "processingMetrics": {
    "embedMs": 830, "parseMs": 1514, "totalMs": 2448, "attempts": 1,
    "persistMs": 37, "downloadMs": 0, "queueWaitMs": 5, "embeddingTokens": 4
  },
  "lastStatusAt": "2026-09-30T04:39:28.317Z",
  "processingCompletedAt": "2026-09-30T04:39:28.317Z",
  "…": "other fields as in E68"
}
```

A failed one: `"status": "FAILED", "failureCode": "ENCRYPTED_DOCUMENT", "statusMessage":
"The PDF is password protected. Remove the password and upload it again.",
"isSearchable": false, "processingMetrics": { "parseMs": 1505, "attempts": 1, … }`.
**Errors:** `404 DOCUMENT_NOT_FOUND` (unknown, deleted, in a hidden base, or above your
clearance).

### E71. `GET {ws}/documents/{documentId}/chunks`

**Query:** `page`, `limit` (1–100, default 20). **200:** paginated `DocumentChunk[]` of the
version retrieval serves, in order:

```json
[
  { "id": "289bf02a-3c73-5a12-b693-fabb912442f5", "chunkIndex": 0,
    "text": "Annual leave policy.", "tokenCount": 3, "pageStart": null, "pageEnd": null },
  { "id": "11e5a773-ea30-5fde-8939-fe827321a3ac", "chunkIndex": 1,
    "text": "Every employee receives twenty five days of annual leave per year. Contact Ayesha Raza at ayesha.raza@acme.test or +92 300 1234567.",
    "tokenCount": 20, "pageStart": null, "pageEnd": null }
]
```

PDF chunks carry pages (`"pageStart": 2, "pageEnd": 2`). A document never processed, or
failed on its first run, returns an empty page. Chunk ids change on every reindex.
**Errors:** `404 DOCUMENT_NOT_FOUND`.

### E72. `GET {ws}/documents/{documentId}/download`

**200:** the original bytes, **not enveloped**. Headers (verified):

```
content-type: text/markdown
content-length: 226
content-disposition: attachment; filename="_berblick remote-work.md"; filename*=UTF-8''%C3%9Cberblick%20remote-work.md
cache-control: private, no-store
x-request-id: 10e4be43-f548-480d-9567-55e0cec50501
```

`content-type` is the detected type (`application/pdf`, `application/vnd.openxmlformats-
officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`). Take the name
from `filename*` (decoded), else `filename`. Errors are ordinary JSON envelopes.
**Errors:** `403 PERMISSION_DENIED` (`document:download`; the demo employee lacks it) ·
`404 DOCUMENT_NOT_FOUND` · `410 DOCUMENT_CONTENT_UNAVAILABLE` "The document's content has
been destroyed and cannot be retrieved." (the stored file is gone) · `409
DOCUMENT_CONTENT_UNAVAILABLE` "The stored file failed its integrity check and will not be
served." · `503 KNOWLEDGE_LAYER_NOT_CONFIGURED` (`missingConfiguration:
["STORAGE_S3_BUCKET"]`) · `503 OBJECT_STORAGE_UNAVAILABLE`.

### E73. `PATCH {ws}/documents/{documentId}`

**Body** (all optional; only changed fields): `title` (1–255, not `null`), `description`
(≤2000; `null` or `""` removes it), `classification` (not `null`; old and new within your
clearance), `tags` (array of strings, or one comma-separated string; replaces the tags;
`[]` removes them; not `null`). Moving a document to another base is not supported
(`knowledgeBaseId` → `422` "property knowledgeBaseId should not exist").
**200:** the updated `Document`. Reclassification takes effect for search immediately.
**Errors:** `403 PERMISSION_DENIED` (`document:update`) · `403
KNOWLEDGE_BASE_ACCESS_DENIED` (`WRITE` needed) · `403 CLASSIFICATION_EXCEEDS_CLEARANCE`
`{ requested: "RESTRICTED", clearance: "CONFIDENTIAL" }` · `404` · `422` (`title` "title
should not be empty", `classification`, `tags`).

### E74. `POST {ws}/documents/{documentId}/reindex`

No body. Allowed when the status is `READY` (reindex) or `FAILED` (retry).
**202:** the `Document` with `status: "UPLOADED"`, `indexVersion` + 1, `failureCode` and
`statusMessage` cleared, and `activeIndexVersion` / `isSearchable` unchanged (a `READY`
document stays searchable).
**Errors:** `409 DOCUMENT_PROCESSING` "The document is still being processed. Try again
when processing finishes." `{ status: "UPLOADED" }` (including a second click) · `403
PERMISSION_DENIED` (`document:reindex`) · `403 KNOWLEDGE_BASE_ACCESS_DENIED` · `404` ·
`503 KNOWLEDGE_LAYER_NOT_CONFIGURED`.

### E75. `DELETE {ws}/documents/{documentId}`

No body. **200** `{ "deleted": true }`; from then on `404` everywhere, including a second
delete. **Errors:** `403 PERMISSION_DENIED` (`document:delete`) · `403
KNOWLEDGE_BASE_ACCESS_DENIED` · `404`.

---

### E76. `POST {ws}/rag/query`

**Body:**

| Field | Rules |
|---|---|
| `query` | required; whitespace runs collapsed and trimmed; 1–2000 characters (`RAG_MAX_QUERY_LENGTH`) |
| `knowledgeBaseIds` | optional, ≤50 uuids; narrows the search, never widens it |
| `documentIds` | optional, ≤100 uuids; narrows to these documents |
| `topK` | 1–200 accepted, **capped at 50**; default 8 |
| `mode` | `hybrid` (default) \| `dense` |
| `minScore` | 0–1, dense mode only |
| `rerank` | boolean; default off |

**200:**

```json
{
  "retrievalId": "80f8647d-c4cb-4b8c-a85d-a8ef90496e4a",
  "mode": "hybrid",
  "topK": 8,
  "reranked": false,
  "embeddingModel": "nomic-embed-text",
  "knowledgeBasesSearched": 2,
  "clearance": "INTERNAL",
  "effectiveClearance": "INTERNAL",
  "results": [
    {
      "chunkId": "a60a0594-3571-5523-aa06-67688964bb20",
      "documentId": "5db1a517-dfbe-4be9-8d18-68e0d1e80df0",
      "documentTitle": "Annual leave policy",
      "knowledgeBaseId": "8df97318-db90-49a0-8a1a-6d34cef3a182",
      "knowledgeBaseName": "Company Handbook",
      "classification": "PUBLIC",
      "chunkIndex": 1,
      "pageStart": null,
      "pageEnd": null,
      "rank": 1,
      "score": 1,
      "text": "Every employee receives twenty five days of annual leave per year. Contact Ayesha Raza at ayesha.raza@acme.test or +92 300 1234567."
    }
  ],
  "timings": { "accessMs": 2, "embedMs": 0, "searchMs": 2, "hydrateMs": 12, "rerankMs": 0, "totalMs": 17 }
}
```

`retrievalId` identifies the query in the audit log. `effectiveClearance` equals
`clearance` for your own queries (an agent can lower it, Phase 5). Verified isolation: the
same question "What is the CEO salary?" returns the RESTRICTED payroll passage to the HR
Manager and never to the admin or the employee.
**Errors:** `403 PERMISSION_DENIED` (`rag:query`) · `404 KNOWLEDGE_BASE_NOT_FOUND`
`{ knowledgeBaseIds: ["d6ffea64-…"] }` · `422` (`query` "query should not be empty",
"must be at most 2000 characters"; `topK` "topK must not be less than 1"; `mode`;
`minScore` "minScore must not be greater than 1"; `knowledgeBaseIds` "each value in
knowledgeBaseIds must be a UUID"; `rerank` "rerank must be a boolean value") · `429`
(60 per minute: "Rate limit exceeded for this endpoint (60 requests per 60s). Try again in
59s.", `retry-after: 59`) · `503 KNOWLEDGE_LAYER_NOT_CONFIGURED`
(`missingConfiguration: ["QDRANT_URL", "AI_SERVICE_URL"]`) · `503 AI_SERVICE_UNAVAILABLE`
`{ reason: "AI_SERVICE_UNREACHABLE" }` · `503 VECTOR_STORE_UNAVAILABLE`.

### E77. `GET {ws}/rag/access-scope`

**200** (bases sorted by name):

```json
{
  "clearance": "INTERNAL",
  "readableClassifications": ["PUBLIC", "INTERNAL"],
  "bypassesCompartments": false,
  "knowledgeBases": [
    { "id": "8df97318-db90-49a0-8a1a-6d34cef3a182", "name": "Company Handbook",
      "accessMode": "WORKSPACE", "access": "MANAGE" },
    { "id": "250feecd-9e71-47cf-9bd8-94818e53e1ea", "name": "People Ops Wiki",
      "accessMode": "WORKSPACE", "access": "MANAGE" }
  ]
}
```

`bypassesCompartments` is true for the owner. Needs `rag:query` (the demo auditor gets
`403`); for users without it, compute the clearance on the client (`clearanceOf`). Works
even when the knowledge layer is not configured.

### E78. `GET {ws}/pii/documents/{documentId}/report`

**Query:** `page` (≥1, default 1), `limit` (1–20, default 10), `reveal` (`true` to include
values; needs `pii:reveal`).
**200:**

```json
{
  "documentId": "5db1a517-dfbe-4be9-8d18-68e0d1e80df0",
  "chunks": [
    { "chunkId": "6d82e7e7-e8f0-5d16-8847-50898182e502", "chunkIndex": 0, "pageStart": null,
      "maskedText": "Annual leave policy.", "entities": [] },
    {
      "chunkId": "a60a0594-3571-5523-aa06-67688964bb20", "chunkIndex": 1, "pageStart": null,
      "maskedText": "Every employee receives twenty five days of annual leave per year. Contact [PERSON_1] at [EMAIL_ADDRESS_1] or [PHONE_NUMBER_1].",
      "entities": [
        { "entityType": "PERSON", "start": 75, "end": 86, "score": 0.85, "source": "ner",
          "recognizer": "e2e-ner@1", "placeholder": "[PERSON_1]" },
        { "entityType": "EMAIL_ADDRESS", "start": 90, "end": 111, "score": 1, "source": "pattern",
          "recognizer": "email", "placeholder": "[EMAIL_ADDRESS_1]" },
        { "entityType": "PHONE_NUMBER", "start": 115, "end": 130, "score": 0.85, "source": "pattern",
          "recognizer": "phone", "placeholder": "[PHONE_NUMBER_1]" }
      ]
    }
  ],
  "byType": { "PERSON": 1, "EMAIL_ADDRESS": 1, "PHONE_NUMBER": 1 },
  "entityCount": 3,
  "page": 1,
  "totalChunks": 4,
  "degraded": false,
  "revealed": false,
  "timings": { "patternMs": 44.25, "nerMs": 3.17, "maskingMs": 9.89, "totalMs": 62.8 }
}
```

With `reveal=true` (owner, verified) each entity also has `"value": "4111 1111 1111 1111"`
and `revealed` is `true`. `byType` and `entityCount` cover **this page** only.
`recognizer` is informational (a cached detection reads `ner-cache`); do not branch on
it. Timings are fractional milliseconds.
**Errors:** `403 PERMISSION_DENIED` `missingPermissions: ["pii:policy:read"]` (the demo HR
Manager) or `["pii:reveal"]` (reveal without the permission; the refusal is audited) ·
`404 DOCUMENT_NOT_FOUND` · `422` (`limit` "limit must not be greater than 20") · `429`
(30 per minute) · `503 PII_DETECTION_UNAVAILABLE` `{ reason: "UNAVAILABLE", detector:
"ai-service", entityTypes: ["PERSON"], missingConfiguration: [], hint: "Configure the NER
detector, or set the workspace PII policy to DEGRADE_TO_PATTERNS to continue with
pattern-based masking only." }`.

---

## 8. Error codes Phase 3 must handle

On top of Phase 1 §9 and Phase 2 §7.

| HTTP | Code | Where | `details` | Handling |
|---|---|---|---|---|
| 404 | `KNOWLEDGE_BASE_NOT_FOUND` | E62–E68, E69 (`knowledgeBaseId`), E76 | `knowledgeBaseIds` (E76) | "doesn't exist or no access"; refetch bases; drop filters and selections |
| 403 | `KNOWLEDGE_BASE_ACCESS_DENIED` | E63–E68, E73–E75 | `required`, `granted` | "You have {granted} access to this knowledge base"; refetch the base |
| 409 | `KNOWLEDGE_BASE_NAME_TAKEN` | E61, E63 | — | on the Name field |
| 404 | `KNOWLEDGE_BASE_GRANT_NOT_FOUND` | E67 | — | refetch grants |
| 403 | `CLASSIFICATION_EXCEEDS_CLEARANCE` | E61, E63, E68, E73 | `requested`, `clearance` | "Above your clearance ({clearance})" on the classification field |
| 404 | `DOCUMENT_NOT_FOUND` | E70–E75, E78 | — | "doesn't exist or no access"; close the drawer; refetch the list |
| 409 | `DOCUMENT_DUPLICATE` | E68 | `existingDocumentId`, `existingTitle` (only when visible) | §6.2 |
| 415 | `DOCUMENT_TYPE_NOT_ALLOWED` | E68 | `reason`, `allowedTypes` | show `message` |
| 415 | `DOCUMENT_CONTENT_MISMATCH` | E68 | `reason`, `allowedTypes` | show `message` |
| 415 | `DOCUMENT_EMPTY` | E68 | `reason`, `allowedTypes` | show `message` |
| 413 | `PAYLOAD_TOO_LARGE` | E68 | — | "Larger than 50 MB" |
| 409 | `DOCUMENT_PROCESSING` | E74 | `status` | "Already being processed"; refetch |
| 410 / 409 | `DOCUMENT_CONTENT_UNAVAILABLE` | E72 | — | "The stored file is no longer available" |
| 403 | `STORAGE_QUOTA_EXCEEDED` | E68 | `quotaBytes`, `usedBytes`, `incomingBytes` | stop the upload queue; show usage |
| 503 | `KNOWLEDGE_LAYER_NOT_CONFIGURED` | E68, E72, E74, E76 | `missingConfiguration` | §6.9 |
| 503 | `OBJECT_STORAGE_UNAVAILABLE` | E68, E72 | — | §6.9 |
| 503 | `AI_SERVICE_UNAVAILABLE` | E76 | `reason` | §6.9 |
| 503 | `VECTOR_STORE_UNAVAILABLE` | E76 | — | §6.9 |
| 503 | `PII_DETECTION_UNAVAILABLE` | E78 | `reason`, `detector`, `entityTypes`, `missingConfiguration`, `hint` | §6.5 |
| 404 | `RESOURCE_NOT_FOUND` | E66 | — | the grant's subject is gone; show `message`; refetch the picker |
| 400 | `BAD_REQUEST` | E68 (multipart), path ids | — | show `message` (client bug) |
| 408 | `REQUEST_TIMEOUT` | E68, E72, E76 | — | "took too long" |
| 401 | `AUTH_SCHEME_NOT_ALLOWED` | API-key calls to Bearer-only routes | — | not seen by the browser app |
| 403 | `PERMISSION_DENIED` | all | `missingPermissions` | Phase 1; refetch permissions |
| 429 | `RATE_LIMIT_EXCEEDED` | all (upload, rag, privacy budgets) | `retryAfterSeconds` | countdown from `Retry-After` |
| 422 | `VALIDATION_FAILED` | all bodies and queries | `fields` | Phase 1 §3.3 |

Document **failure codes** (`failureCode` on a `FAILED` document) are not API errors; they
are in §4.1.2.

---

## 9. Client-side validation rules

| Field | Rule |
|---|---|
| Knowledge base name | required, 1–120 after trimming |
| Knowledge base description | ≤2000 |
| Access mode | `WORKSPACE` \| `RESTRICTED` |
| Default classification | within your clearance |
| Chunk size | integer 64–4096, or inherit |
| Chunk overlap | integer 0–1024, below the effective chunk size (yours, else the workspace's, else 512), or inherit |
| Grant subject | a role id, a **membership** id or an API key id; level `READ` \| `WRITE` \| `MANAGE` |
| Upload file | extension in `pdf`, `docx`, `txt`, `text`, `md`, `markdown`; 1 byte – 50 MB; one per request |
| Document title | 1–255 after trimming |
| Document description | ≤2000 |
| Tags | ≤20, each 1–40 characters, no commas inside a tag |
| Classification (upload, reclassify) | within your clearance |
| Retrieval query | 1–2000 characters after collapsing whitespace |
| `topK` | integer 1–50 |
| `minScore` | 0–1 (dense mode only) |
| Knowledge-base filter for retrieval | ≤50 ids |
| PII report page size | 1–20 |

---

## 10. State, caching, polling and invalidation

### 10.1 Query keys

Every key starts with `['ws', workspaceId]` (Phase 1 §11).

| Key | Source | Notes |
|---|---|---|
| `['ws', id, 'knowledge-bases', params]` | E60 | sidebar uses `{ limit: 100 }` |
| `['ws', id, 'knowledge-base', kbId]` | E62 | |
| `['ws', id, 'knowledge-base', kbId, 'grants']` | E65 | |
| `['ws', id, 'documents', params]` | E69 | polled while anything in view is in progress |
| `['ws', id, 'document', documentId]` | E70 | polled while in progress |
| `['ws', id, 'document', documentId, 'chunks', page]` | E71 | |
| `['ws', id, 'document', documentId, 'pii-report', page]` | E78 without reveal | staleTime 60 s |
| `['ws', id, 'rag-scope']` | E77 | staleTime 60 s |
| `['ws', id, 'pii-entity-types']` | Phase 4 endpoint | staleTime Infinity |
| `['ws', id, 'details']` | E25 | Phase 2; chunk defaults |

Not cached: retrieval (E76, a mutation whose result lives in component state) and revealed
PII reports.

### 10.2 Sensitive data

- Revealed PII (`reveal=true`) is fetched with `gcTime: 0` or outside the query cache, and
  dropped when the tab closes.
- Never put document text, chunk text, passages or report text in `localStorage`,
  `sessionStorage`, URLs or logs. The query cache is memory only and is cleared on
  sign-out (Phase 1).

### 10.3 Polling while documents are processing

Documents change status with no event, so poll. Use `pollInterval` (Appendix B) as the
TanStack Query `refetchInterval`:

- no document in view is in progress (`UPLOADED`, `PARSING`, `CHUNKING`, `EMBEDDING`) → no
  polling;
- the most recent `lastStatusAt` among them is under 1 minute old → every 2 s;
- under 10 minutes → every 5 s;
- older (a big file, a retry backoff, or a stuck job) → every 15 s.

Poll the **current page** of the list, and the open document detail. When a poll shows a
document leaving the in-progress states, also invalidate the knowledge-base list (the
stats changed) and that document's chunks. Pause polling when the tab is hidden
(`refetchIntervalInBackground: false`).

### 10.4 After a mutation, invalidate

| Mutation | Invalidate |
|---|---|
| E61 create base | `knowledge-bases`, `rag-scope` |
| E63 edit base | set `knowledge-base` from the response; `knowledge-bases`; `rag-scope` if access mode changed; `grants` if it became restricted |
| E64 delete base | **remove** `knowledge-base`, its `grants` and every `document` of it; invalidate `knowledge-bases`, `documents`, `rag-scope`; clear filters naming it |
| E66 / E67 grants | `grants`, `knowledge-base`, `knowledge-bases`, `rag-scope`, `documents` (your own access may have changed) |
| E68 upload | `documents`, `knowledge-bases` (stats) |
| E73 edit / reclassify | set `document` from the response; `documents`; `knowledge-bases` (a reclassification changes who counts it); its `pii-report` |
| E74 reindex | set `document` from the response; `documents`; `knowledge-bases` |
| E75 delete | remove `document` and its children; invalidate `documents`, `knowledge-bases` |
| Phase 2 role or member changes, E30 settings | `knowledge-bases`, `rag-scope`, `documents` (clearance and grants can change) |

---

## 11. Backend fixes of 2026-09-30 (what changed for the frontend)

Writing this specification uncovered six more backend issues (numbering continues from
Phase 2's BF-12). All were fixed on 2026-09-30 and re-verified against a running server;
unit tests were added, and the knowledge end-to-end suite passes (13/13). This document
already describes the fixed behaviour.

| # | Was | Now | Frontend impact |
|---|---|---|---|
| BF-13 | `PATCH` knowledge base with `name`, `accessMode` or `defaultClassification` set to `null` reached the database and came back as `422` "The request violates a data integrity rule." naming no field; `description: ""` was stored as an empty string; `null` chunk settings were accepted but undocumented | `null` on those three fields is `422` on the field; `""` or `null` removes the description; `null` chunk size or overlap returns to inheriting (documented) | Send `null` to inherit chunking; map field errors as usual |
| BF-14 | `PATCH` document with `"classification": null` returned **500**; `title: null` or `tags: null` gave the same field-less `422` | `422` on the field; `""` or `null` removes the description (also on upload) | none beyond ordinary field errors |
| BF-15 | A knowledge base's chunk overlap was checked against the platform's chunk size, not the one that applies: with a workspace default of 256, an overlap of 300 was accepted and then silently shrunk during ingestion; the `422` named no field | Checked against the effective size (knowledge base → workspace → platform); `details.fields` names `chunkOverlap` or `chunkSize` | Show the error on the field; show inherited values in the form (§6.6) |
| BF-16 | Knowledge-base list ignored `sortDirection` when sorting by name | Honoured when `sortBy` is sent; still A–Z by default | Send both `sortBy` and `sortDirection` |
| BF-17 | An over-long retrieval query returned `422` with a message only | `details.fields.query: ["must be at most 2000 characters"]` | Map to the query field |
| BF-18 | The document list filtered by one status only, so the mockup's "Indexing" filter (three statuses) was impossible with paging | `status` accepts a comma-separated list or a repeated parameter | Use `status=PARSING,CHUNKING,EMBEDDING` for Indexing |

Also added for frontend work: `npm run start:standins` (§13).

---

## 12. Definition of done

Use the demo workspace (`acme-corp`, password `Demo-Workspace-2026!`) against a backend
started with `npm run start:standins` (§13), and in a second browser profile another demo
account.

**Vault and upload**
- [ ] As `employee@acme.test`: the vault shows the Company Handbook documents only; the
      sidebar lists Company Handbook but not HR Policies.
- [ ] Drop five files at once (a `.txt`, a `.md`, a `.pdf`, a `.docx`, an `.exe`): the
      `.exe` is refused before sending; the others upload in parallel with progress bars
      and appear as Pending, then Indexing, then Indexed without a page reload.
- [ ] Upload the same `.txt` again: "Already in this knowledge base as …" with **Open it**.
- [ ] A `.txt` renamed from a PDF is refused with the server's content-mismatch message; an
      empty file with "The file is empty."
- [ ] The employee's classification choices are only PUBLIC and INTERNAL.
- [ ] A file containing `STANDIN_FAIL_PERMANENT` ends as Failed with "The PDF is password
      protected…", `STANDIN_NO_TEXT` with the OCR message, and `STANDIN_FAIL_TRANSIENT`
      shows "Retrying…" before Failed (about 4 minutes with the default 5 attempts and
      15 s exponential backoff); Retry is offered only where it can help.
- [ ] The Indexing filter shows only in-progress documents; the Failed filter only failed
      ones; sort by size and by title work; paging appears at `limit` 2.

**Detail**
- [ ] The Chunks tab shows the chunks; the PDF's chunks show page numbers.
- [ ] As the employee: no Download, Edit or Delete; Reindex is offered. As
      `hr@acme.test` on a Handbook document: Download and Edit work, Delete and Reindex
      are hidden.
- [ ] Reindex a Ready document: it stays searchable (search finds it) while the status
      runs again; a second click while it runs says "Already being processed".
- [ ] As HR, reclassify a document to CONFIDENTIAL: the employee's vault drops it on the
      next refresh and a direct link shows "doesn't exist or you don't have access".
- [ ] Download a file with a non-ASCII name (`Überblick.md`): it saves under that exact
      name.
- [ ] Delete a document: the confirmation says the content is destroyed; it disappears
      from the list and the counts.

**PII report**
- [ ] As the employee on a document containing a name, an email and a phone number: the
      placeholders show as chips with the per-page counts; no reveal toggle.
- [ ] As `owner@acme.test`: **Show real values** reveals the values with the audit notice.
- [ ] As HR: the PII tab is hidden.

**Knowledge bases and access**
- [ ] As `admin@acme.test`: HR Policies is not listed anywhere. Create "Finance Reports"
      as Restricted with CONFIDENTIAL; the Access tab shows the admin as Manage.
      RESTRICTED is not offered as its default classification.
- [ ] Grant the Member role Read: the employee now sees Finance Reports but cannot upload
      there (Upload disabled, with the read-only explanation).
- [ ] Removing your own grant shows the self-lockout warning.
- [ ] Set the workspace's default chunk size to 256 (Phase 2 settings), then an overlap
      of 300 on a base: refused on the Overlap field; "Inherit" shows 256.
- [ ] Delete a base by typing its name: its documents vanish from the vault.

**Search**
- [ ] As HR, "What is the CEO salary?" returns the payroll passage from HR Policies (after
      uploading a RESTRICTED payroll file there); as the admin, the same question never
      does.
- [ ] Narrowing to one knowledge base, Dense mode with a minimum similarity, and Rerank
      all change the results; scores show as relative bars, not percentages.
- [ ] As the auditor: Search is not in the navigation.

**Failure states** (with a normal `npm run start:dev` backend that has no storage, Qdrant
or AI service configured)
- [ ] Upload, Download, Reindex and Search show the "not set up yet" state; lists, detail,
      chunks and knowledge-base management still work.

**Quality**
- [ ] Unit tests for `canOnKnowledgeBase`, `clearanceOf`, `assignableClassifications`,
      `defaultUploadClassification`, `displayStatus`, `pollInterval`, `precheckFile`,
      `filenameFromDisposition`, `myLevelAfter`, `splitPlaceholders` (cases in Appendix
      B).
- [ ] Every error code in §8 and every failure code in §4.1.2 has a designed message.
- [ ] No document text, passages or revealed values in storage, URLs or logs.

---

## 13. Local development: the stand-ins server

Uploading and searching need object storage, Qdrant and the Python AI service. Until your
backend has all three, those calls answer `503 KNOWLEDGE_LAYER_NOT_CONFIGURED`. To build
Phase 3 without them, start the backend with:

```bash
npm run start:standins      # instead of npm run start:dev
```

It is the real API (same database, Redis, queue workers, guards, access policy,
encryption and audit log), with the three cloud services replaced by in-memory stand-ins.
Same port, same URLs; your dev proxy (Phase 1 §2.4) needs no change.

| Behaviour | Stand-ins server | Production |
|---|---|---|
| Upload, statuses, polling, retries | real pipeline; about 1.5 s of simulated extraction per file so each status is visible (`STANDIN_PARSE_DELAY_MS`) | real |
| Text and Markdown | split into chunks at blank lines | split by tokens with overlap |
| PDF and DOCX | accepted and inspected for real, but get three stand-in pages of text | real text extraction |
| Search ranking | bag-of-words vectors: plausible, not good | real embeddings |
| Rerank | word overlap | cross-encoder, if the AI service has one |
| Name detection (PERSON) | only the names Ayesha Raza, Sara Khan, Imran Qureshi, Ahmad Hanbal | statistical NER |
| Stored files and vectors | in memory, **lost on restart**: older documents then fail to download (410) and drop out of search. Delete and upload them again | durable |

To design failure states, put one of these words anywhere in a `.txt` file's text:
`STANDIN_FAIL_PERMANENT` (fails like a password-protected PDF), `STANDIN_FAIL_TRANSIENT`
(retries, then fails with `AI_SERVICE_UNAVAILABLE`), `STANDIN_NO_TEXT` (fails like a
scanned PDF). The server refuses to start with `NODE_ENV=production`.

---

## Appendix A: TypeScript types

Add to Phase 1's `lib/api/types.ts`. `VaultDocument` avoids clashing with the DOM's
`Document`.

```ts
// ── Access ──────────────────────────────────────────────────────────────────
export type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type KnowledgeBaseAccessMode = 'WORKSPACE' | 'RESTRICTED';
export type AccessLevel = 'READ' | 'WRITE' | 'MANAGE';

// ── Knowledge bases ─────────────────────────────────────────────────────────
export interface KnowledgeBaseStats {
  documents: number;                 // within your clearance
  ready: number;
  processing: number;                // UPLOADED + PARSING + CHUNKING + EMBEDDING
  failed: number;
  totalBytes: string;                // bigint as a string
}
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  accessMode: KnowledgeBaseAccessMode;
  defaultClassification: Classification;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkSize: number | null;          // null: inherited
  chunkOverlap: number | null;       // null: inherited
  access: AccessLevel;               // your effective level
  stats: KnowledgeBaseStats;
  createdById: string | null;        // a user id
  createdAt: string;
  updatedAt: string;
}
export interface ListKnowledgeBasesParams {
  page?: number;
  limit?: number;                    // ≤100
  search?: string;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortDirection?: 'ASC' | 'DESC';
}
export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string;
  accessMode?: KnowledgeBaseAccessMode;
  defaultClassification?: Classification;
  chunkSize?: number;
  chunkOverlap?: number;
}
export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string | null;       // null or '' removes it
  accessMode?: KnowledgeBaseAccessMode;
  defaultClassification?: Classification;
  chunkSize?: number | null;         // null: inherit
  chunkOverlap?: number | null;      // null: inherit
}

// ── Grants ──────────────────────────────────────────────────────────────────
export type GrantSubjectType = 'ROLE' | 'MEMBER' | 'API_KEY';
export interface KnowledgeBaseGrant {
  id: string;
  subjectType: GrantSubjectType;
  subjectId: string;                 // role id, MEMBERSHIP id, or API key id
  subjectLabel: string | null;
  accessLevel: AccessLevel;
  grantedById: string | null;        // a user id
  createdAt: string;
}
export interface UpsertGrantRequest {
  subjectType: GrantSubjectType;
  subjectId: string;
  accessLevel: AccessLevel;
}

// ── Documents ───────────────────────────────────────────────────────────────
export type DocumentStatus = 'UPLOADED' | 'PARSING' | 'CHUNKING' | 'EMBEDDING' | 'READY' | 'FAILED';
export type DocumentFileType = 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN';
export interface DocumentProcessingMetrics {
  queueWaitMs?: number;
  downloadMs?: number;
  parseMs?: number;
  persistMs?: number;
  embedMs?: number;
  indexMs?: number;
  totalMs?: number;
  attempts?: number;
  embeddingTokens?: number;
}
export interface VaultDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  description: string | null;
  tags: string[];
  originalFilename: string;
  fileType: DocumentFileType;
  mimeType: string;                  // detected from the content
  sizeBytes: string;                 // bigint as a string
  classification: Classification;
  status: DocumentStatus;
  statusMessage: string | null;      // failure explanation, or a retry notice while in progress
  failureCode: string | null;        // open set, §4.1.2
  isSearchable: boolean;
  indexVersion: number;
  activeIndexVersion: number | null;
  chunkCount: number;
  tokenCount: number;
  pageCount: number | null;
  language: string | null;
  embeddingModel: string | null;
  processingMetrics: DocumentProcessingMetrics;
  uploadedById: string | null;       // a user id; null when an API key uploaded it
  lastStatusAt: string;
  processingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ListDocumentsParams {
  page?: number;
  limit?: number;                    // ≤100
  knowledgeBaseId?: string;
  status?: DocumentStatus[];         // sent comma-separated
  classification?: Classification;
  search?: string;
  sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'sizeBytes' | 'status';
  sortDirection?: 'ASC' | 'DESC';
}
export interface UploadDocumentFields {
  title?: string;
  description?: string;
  classification?: Classification;
  tags?: string[];                   // sent as one comma-separated string
}
export interface UpdateDocumentRequest {
  title?: string;
  description?: string | null;       // null or '' removes it
  classification?: Classification;
  tags?: string[];                   // replaces; [] removes
}
export interface DocumentChunk {
  id: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  pageStart: number | null;
  pageEnd: number | null;
}

// ── Retrieval ───────────────────────────────────────────────────────────────
export type RetrievalMode = 'hybrid' | 'dense';
export interface RetrievalQuery {
  query: string;
  knowledgeBaseIds?: string[];
  documentIds?: string[];
  topK?: number;                     // capped at 50
  mode?: RetrievalMode;
  minScore?: number;                 // dense only
  rerank?: boolean;
}
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  classification: Classification;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  rank: number;                      // from 1
  score: number;                     // comparable within one response only
  text: string;
}
export interface RetrievalResponse {
  retrievalId: string;
  mode: RetrievalMode;
  topK: number;
  reranked: boolean;
  embeddingModel: string;
  knowledgeBasesSearched: number;
  clearance: Classification;
  effectiveClearance: Classification;
  results: RetrievedChunk[];
  timings: { accessMs: number; embedMs: number; searchMs: number; hydrateMs: number; rerankMs: number; totalMs: number };
}
export interface AccessScope {
  clearance: Classification;
  readableClassifications: Classification[];
  bypassesCompartments: boolean;
  knowledgeBases: Array<{ id: string; name: string; accessMode: KnowledgeBaseAccessMode; access: AccessLevel }>;
}

// ── PII report ──────────────────────────────────────────────────────────────
export interface DetectedEntity {
  entityType: string;
  start: number;                     // in the normalised text; for ordering only
  end: number;
  score: number;
  source: 'pattern' | 'ner' | 'custom' | 'propagation';
  recognizer: string;
  placeholder: string;               // e.g. "[PERSON_1]"
  value?: string;                    // only when revealed
}
export interface ChunkPiiReport {
  chunkId: string;
  chunkIndex: number;
  pageStart: number | null;
  maskedText: string;
  entities: DetectedEntity[];
}
export interface DocumentPiiReport {
  documentId: string;
  chunks: ChunkPiiReport[];
  byType: Record<string, number>;    // this page only
  entityCount: number;               // this page only
  page: number;
  totalChunks: number;
  degraded: boolean;
  revealed: boolean;
  timings: { patternMs: number; nerMs: number; maskingMs: number; totalMs: number };
}
export interface PiiEntityType {     // GET …/pii/entity-types (Phase 4 endpoint)
  type: string;
  label: string;
  description: string;
  detector: 'pattern' | 'ner' | 'custom';
  available: boolean;
  enabled: boolean;
  example: string;
}

// ── Error codes added in Phase 3 ────────────────────────────────────────────
export type Phase3ErrorCode =
  | 'KNOWLEDGE_BASE_NOT_FOUND' | 'KNOWLEDGE_BASE_NAME_TAKEN' | 'KNOWLEDGE_BASE_ACCESS_DENIED'
  | 'KNOWLEDGE_BASE_GRANT_NOT_FOUND' | 'CLASSIFICATION_EXCEEDS_CLEARANCE'
  | 'DOCUMENT_NOT_FOUND' | 'DOCUMENT_DUPLICATE' | 'DOCUMENT_TYPE_NOT_ALLOWED'
  | 'DOCUMENT_CONTENT_MISMATCH' | 'DOCUMENT_EMPTY' | 'DOCUMENT_PROCESSING'
  | 'DOCUMENT_CONTENT_UNAVAILABLE' | 'STORAGE_QUOTA_EXCEEDED' | 'PAYLOAD_TOO_LARGE'
  | 'KNOWLEDGE_LAYER_NOT_CONFIGURED' | 'AI_SERVICE_UNAVAILABLE' | 'VECTOR_STORE_UNAVAILABLE'
  | 'OBJECT_STORAGE_UNAVAILABLE' | 'PII_DETECTION_UNAVAILABLE' | 'AUTH_SCHEME_NOT_ALLOWED';
```

---

## Appendix B: helper code

Reference implementations. They were type-checked with the backend's TypeScript compiler
(DOM library on), and the pure helpers were run against the behaviour recorded from the
live server (the demo matrix of §3.6, the verified status sequences, the download header of
E72). `ApiError`, `toApiError`, `REFRESHABLE_401`, `getAccessToken`,
`refreshAccessToken` and `endSession` are Phase 1's (Appendix B there).

### `lib/knowledge/access.ts`

```ts
import type { AccessLevel, Classification, KnowledgeBase, KnowledgeBaseGrant } from '../api/types';

export const CLASSIFICATIONS: readonly Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

const CLEARANCE_PERMISSION: Readonly<Record<Exclude<Classification, 'PUBLIC'>, string>> = {
  INTERNAL: 'clearance:internal',
  CONFIDENTIAL: 'clearance:confidential',
  RESTRICTED: 'clearance:restricted',
};

/** The highest tier whose clearance permission you hold (§3.3). Same answer as E77's `clearance`. */
export function clearanceOf(myPermissions: ReadonlySet<string>): Classification {
  for (const level of ['RESTRICTED', 'CONFIDENTIAL', 'INTERNAL'] as const) {
    if (myPermissions.has(CLEARANCE_PERMISSION[level])) return level;
  }
  return 'PUBLIC';
}

export const rankOf = (classification: Classification): number => CLASSIFICATIONS.indexOf(classification);

export const withinClearance = (classification: Classification, clearance: Classification): boolean =>
  rankOf(classification) <= rankOf(clearance);

/** Classifications you may assign: upload, reclassify, a base's default. */
export const assignableClassifications = (myPermissions: ReadonlySet<string>): Classification[] =>
  CLASSIFICATIONS.slice(0, rankOf(clearanceOf(myPermissions)) + 1);

/**
 * What the upload form preselects (§6.2). Always send the result: an upload without a
 * classification uses the base's default, which is refused when above your clearance.
 */
export function defaultUploadClassification(
  knowledgeBase: Pick<KnowledgeBase, 'defaultClassification'>,
  myPermissions: ReadonlySet<string>,
): { value: Classification; aboveClearance: boolean } {
  const clearance = clearanceOf(myPermissions);
  return withinClearance(knowledgeBase.defaultClassification, clearance)
    ? { value: knowledgeBase.defaultClassification, aboveClearance: false }
    : { value: clearance, aboveClearance: true };
}

const LEVEL_RANK: Readonly<Record<AccessLevel, number>> = { READ: 1, WRITE: 2, MANAGE: 3 };
export const atLeast = (level: AccessLevel | null | undefined, required: AccessLevel): boolean =>
  !!level && LEVEL_RANK[level] >= LEVEL_RANK[required];

export type KnowledgeAction =
  | 'viewDocuments' | 'upload' | 'editDocument' | 'reindex' | 'deleteDocument' | 'download'
  | 'piiReport' | 'revealPii' | 'search' | 'viewGrants' | 'manageGrants'
  | 'editKnowledgeBase' | 'deleteKnowledgeBase';

/** §3.5: every permission is required, and at least this level on the knowledge base. */
export const KNOWLEDGE_RULES: Readonly<Record<KnowledgeAction, { permissions: readonly string[]; level: AccessLevel }>> = {
  viewDocuments: { permissions: ['document:read'], level: 'READ' },
  upload: { permissions: ['document:create'], level: 'WRITE' },
  editDocument: { permissions: ['document:update'], level: 'WRITE' },
  reindex: { permissions: ['document:reindex'], level: 'WRITE' },
  deleteDocument: { permissions: ['document:delete'], level: 'WRITE' },
  download: { permissions: ['document:download'], level: 'READ' },
  piiReport: { permissions: ['document:read', 'pii:policy:read'], level: 'READ' },
  revealPii: { permissions: ['document:read', 'pii:policy:read', 'pii:reveal'], level: 'READ' },
  search: { permissions: ['rag:query'], level: 'READ' },
  viewGrants: { permissions: ['knowledgebase:read'], level: 'MANAGE' },
  manageGrants: { permissions: ['knowledgebase:update'], level: 'MANAGE' },
  editKnowledgeBase: { permissions: ['knowledgebase:update'], level: 'MANAGE' },
  deleteKnowledgeBase: { permissions: ['knowledgebase:delete'], level: 'MANAGE' },
};

/** Whether the action can succeed on a document of this base (or on the base itself). */
export function canOnKnowledgeBase(
  action: KnowledgeAction,
  knowledgeBase: Pick<KnowledgeBase, 'access'>,
  myPermissions: ReadonlySet<string>,
): boolean {
  const rule = KNOWLEDGE_RULES[action];
  return rule.permissions.every((permission) => myPermissions.has(permission)) && atLeast(knowledgeBase.access, rule.level);
}

/** Whether the role permission alone is missing (hide), as opposed to a low level (disable). */
export const lacksPermissionFor = (action: KnowledgeAction, myPermissions: ReadonlySet<string>): boolean =>
  !KNOWLEDGE_RULES[action].permissions.every((permission) => myPermissions.has(permission));

/**
 * Your level on a RESTRICTED base after a grant change (§6.7): the strongest of your member
 * grant and the grants to your roles. `null` means you would lose access. Owners bypass
 * compartments, so check `membership.isOwner` before warning.
 */
export function myLevelAfter(
  grants: readonly KnowledgeBaseGrant[],
  me: { membershipId: string; roleIds: readonly string[] },
  change: { removeGrantId: string } | { grantId: string; accessLevel: AccessLevel },
): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const grant of grants) {
    if ('removeGrantId' in change && grant.id === change.removeGrantId) continue;
    const level = 'grantId' in change && grant.id === change.grantId ? change.accessLevel : grant.accessLevel;
    const mine =
      (grant.subjectType === 'MEMBER' && grant.subjectId === me.membershipId) ||
      (grant.subjectType === 'ROLE' && me.roleIds.includes(grant.subjectId));
    if (mine && (!best || LEVEL_RANK[level] > LEVEL_RANK[best])) best = level;
  }
  return best;
}
```

### `lib/knowledge/status.ts`

```ts
import type { DocumentStatus, VaultDocument } from '../api/types';

export const IN_PROGRESS: readonly DocumentStatus[] = ['UPLOADED', 'PARSING', 'CHUNKING', 'EMBEDDING'];
export const isInProgress = (status: DocumentStatus): boolean => IN_PROGRESS.includes(status);

export type VaultBadge = 'PENDING' | 'INDEXING' | 'INDEXED' | 'FAILED';

export interface DisplayStatus {
  badge: VaultBadge;
  /** Short stage text for the second line. */
  stage: string;
  /** A reindex is running or failed while the previous version keeps answering searches. */
  previousVersionServing: boolean;
  /** An in-progress document whose last attempt failed and will be retried. */
  retrying: boolean;
}

const STAGE: Readonly<Record<DocumentStatus, string>> = {
  UPLOADED: 'Queued',
  PARSING: 'Extracting text',
  CHUNKING: 'Chunking',
  EMBEDDING: 'Embedding',
  READY: 'Searchable',
  FAILED: 'Failed',
};

export function displayStatus(
  document: Pick<VaultDocument, 'status' | 'statusMessage' | 'isSearchable' | 'indexVersion' | 'activeIndexVersion'>,
): DisplayStatus {
  const reprocessing = document.activeIndexVersion !== null && document.activeIndexVersion !== document.indexVersion;
  const inProgress = isInProgress(document.status);
  const badge: VaultBadge =
    document.status === 'READY'
      ? 'INDEXED'
      : document.status === 'FAILED'
        ? 'FAILED'
        : document.status === 'UPLOADED'
          ? 'PENDING'
          : 'INDEXING';
  return {
    badge,
    stage: reprocessing && inProgress ? `Reindexing: ${STAGE[document.status].toLowerCase()}` : STAGE[document.status],
    previousVersionServing: reprocessing && document.isSearchable && document.status !== 'READY',
    retrying: inProgress && !!document.statusMessage,
  };
}

/** §4.1.2: failure codes a retry cannot fix. */
const PERMANENT_FAILURES = new Set([
  'DOCUMENT_EMPTY', 'ENCRYPTED_DOCUMENT', 'UNPARSEABLE_DOCUMENT', 'TOO_MANY_CHUNKS',
  'UNSUPPORTED_FILE_TYPE', 'DOCUMENT_TOO_LARGE', 'CONTENT_MISSING', 'CONTENT_INTEGRITY_FAILURE',
]);
export const retryCanHelp = (failureCode: string | null): boolean => !failureCode || !PERMANENT_FAILURES.has(failureCode);

/**
 * TanStack Query `refetchInterval` for the vault list and the detail (§10.3): no polling
 * when nothing is in progress; faster while statuses are moving.
 */
export function pollInterval(
  documents: ReadonlyArray<Pick<VaultDocument, 'status' | 'lastStatusAt'>>,
  now = Date.now(),
): number | false {
  const moving = documents.filter((document) => isInProgress(document.status));
  if (moving.length === 0) return false;
  const newest = Math.max(...moving.map((document) => Date.parse(document.lastStatusAt)));
  const age = now - newest;
  if (age < 60_000) return 2_000;
  if (age < 600_000) return 5_000;
  return 15_000;
}
```

### `lib/knowledge/files.ts`

```ts
/** The server's accepted extensions (UPLOAD_ALLOWED_TYPES pdf,docx,txt,md). */
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'txt', 'text', 'md', 'markdown'] as const;
/** For `<input type="file" accept=…>`. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(',');
/** UPLOAD_MAX_FILE_SIZE, 50 MB in binary units. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type PrecheckProblem =
  | { code: 'EMPTY'; message: string }
  | { code: 'TOO_LARGE'; message: string }
  | { code: 'TYPE_NOT_ALLOWED'; message: string };

/** Same extension rule as the server: the text after the last dot, not counting a leading dot. */
export function fileExtension(name: string): string {
  const base = name.replace(/^\.+/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Problems the server would certainly refuse. The server still inspects the content. */
export function precheckFile(file: Pick<File, 'name' | 'size'>, maxBytes = MAX_UPLOAD_BYTES): PrecheckProblem | null {
  const extension = fileExtension(file.name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return {
      code: 'TYPE_NOT_ALLOWED',
      message: extension
        ? `.${extension} files aren't accepted. Use PDF, Word (.docx), text or Markdown.`
        : "This file has no extension, so its type can't be confirmed.",
    };
  }
  if (file.size === 0) return { code: 'EMPTY', message: 'The file is empty.' };
  if (file.size > maxBytes) return { code: 'TOO_LARGE', message: `Larger than the ${formatBytes(maxBytes)} limit.` };
  return null;
}

/** For `sizeBytes` / `totalBytes` (strings) and numbers. Binary units, like the server. */
export function formatBytes(value: string | number): string {
  const bytes = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Number.isFinite(bytes) ? bytes : 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? Math.round(size) : Math.round(size * 10) / 10} ${units[unit]}`;
}
```

### `lib/knowledge/upload.ts`

```ts
import { ApiError, REFRESHABLE_401 } from '../api/errors';
import { endSession, getAccessToken, refreshAccessToken } from '../api/token-manager';
import type { UploadDocumentFields, VaultDocument } from '../api/types';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export interface UploadOptions {
  workspaceId: string;
  knowledgeBaseId: string;
  file: File;
  fields?: UploadDocumentFields;
  /** 0…1, bytes sent so far. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  document: VaultDocument;
  /** From `x-ratelimit-remaining`: uploads left in this hour. */
  remaining: number | null;
}

interface RawResponse {
  status: number;
  text: string;
  requestId: string | null;
  retryAfter: string | null;
  remaining: string | null;
}

/** E68 with upload progress. One file per call; run at most 3 at a time (§6.2). */
export async function uploadDocument(options: UploadOptions, retried = false): Promise<UploadResult> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'AUTH_TOKEN_MISSING', 'Please sign in.');

  const form = new FormData();
  form.append('file', options.file, options.file.name);
  const { title, description, classification, tags } = options.fields ?? {};
  if (title) form.append('title', title);
  if (description) form.append('description', description);
  if (classification) form.append('classification', classification);
  if (tags?.length) form.append('tags', tags.join(','));

  const url = `${API}/organizations/${options.workspaceId}/knowledge-bases/${options.knowledgeBaseId}/documents`;
  const raw = await send(url, form, token, options);

  if (raw.status === 202) {
    const body = JSON.parse(raw.text) as { data: VaultDocument };
    return { document: body.data, remaining: raw.remaining === null ? null : Number(raw.remaining) };
  }

  const error = toUploadError(raw);
  if (raw.status === 401 && REFRESHABLE_401.has(error.code)) {
    if (!retried && (await refreshAccessToken())) return uploadDocument(options, true);
    endSession(error.code);
  }
  throw error;
}

function send(url: string, form: FormData, token: string, options: UploadOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.timeout = 130_000; // the server allows 120 s including the transfer
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('X-Organization-Id', options.workspaceId);
    xhr.setRequestHeader('Accept', 'application/json');
    // No Content-Type: the browser sets multipart/form-data with its boundary.

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        text: xhr.responseText,
        requestId: xhr.getResponseHeader('x-request-id'),
        retryAfter: xhr.getResponseHeader('retry-after'),
        remaining: xhr.getResponseHeader('x-ratelimit-remaining'),
      });
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', "Can't reach AgentVault. Check your connection."));
    xhr.ontimeout = () => reject(new ApiError(408, 'REQUEST_TIMEOUT', 'The upload took too long.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

interface ErrorBody {
  error?: { code: string; message: string; details?: Record<string, unknown> };
  meta?: { requestId?: string };
}

function parseErrorBody(text: string): ErrorBody | null {
  try {
    return JSON.parse(text) as ErrorBody;
  } catch {
    return null; // not JSON (a proxy's HTML error page, for example)
  }
}

function toUploadError(raw: RawResponse): ApiError {
  const body = parseErrorBody(raw.text);
  return new ApiError(
    raw.status,
    body?.error?.code ?? (raw.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'),
    body?.error?.message ?? `Upload failed (${raw.status}).`,
    body?.error?.details,
    body?.meta?.requestId ?? raw.requestId ?? undefined,
    Number(raw.retryAfter) || undefined,
  );
}
```

### `lib/knowledge/upload-errors.ts`

```ts
import type { ApiError } from '../api/errors';
import { formatBytes } from './files';

export interface UploadErrorView {
  message: string;
  /** Offer "Open it" for this document. */
  openDocumentId?: string;
  /** Stop sending the rest of the queue. */
  stopQueue?: boolean;
  /** Refetch knowledge bases or permissions. */
  refetch?: 'knowledge-bases' | 'permissions';
  /** Requeue after this many seconds. */
  retryAfterSeconds?: number;
}

/** §6.2: one message per failed file. */
export function describeUploadError(error: ApiError): UploadErrorView {
  const details = (error.details ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case 'DOCUMENT_DUPLICATE':
      return typeof details.existingDocumentId === 'string'
        ? { message: `Already in this knowledge base as “${String(details.existingTitle)}”.`, openDocumentId: details.existingDocumentId }
        : { message: 'An identical file is already in this knowledge base.' };
    case 'DOCUMENT_TYPE_NOT_ALLOWED':
    case 'DOCUMENT_CONTENT_MISMATCH':
    case 'DOCUMENT_EMPTY':
      return { message: error.message };
    case 'PAYLOAD_TOO_LARGE':
      return { message: 'Larger than the 50 MB limit.' };
    case 'CLASSIFICATION_EXCEEDS_CLEARANCE':
      return { message: `You can't classify documents above ${String(details.clearance)}.` };
    case 'KNOWLEDGE_BASE_ACCESS_DENIED':
      return { message: 'You have read-only access to this knowledge base.', refetch: 'knowledge-bases' };
    case 'KNOWLEDGE_BASE_NOT_FOUND':
      return { message: 'This knowledge base no longer exists or you lost access to it.', refetch: 'knowledge-bases', stopQueue: true };
    case 'STORAGE_QUOTA_EXCEEDED':
      return {
        message: `${error.message} ${formatBytes(Number(details.usedBytes))} of ${formatBytes(Number(details.quotaBytes))} used.`,
        stopQueue: true,
      };
    case 'PERMISSION_DENIED':
      return { message: "You don't have permission to upload documents.", refetch: 'permissions', stopQueue: true };
    case 'REQUEST_TIMEOUT':
      return { message: 'The upload took too long. Try a faster connection or a smaller file.' };
    case 'RATE_LIMIT_EXCEEDED':
      return { message: 'Upload limit reached.', retryAfterSeconds: error.retryAfterSeconds ?? 60 };
    case 'VALIDATION_FAILED':
      return { message: Object.values(error.fieldErrors()).join(' ') || error.message };
    case 'KNOWLEDGE_LAYER_NOT_CONFIGURED':
    case 'OBJECT_STORAGE_UNAVAILABLE':
      return { message: 'Uploads are unavailable right now.', stopQueue: true };
    default:
      return { message: error.message };
  }
}
```

### `lib/knowledge/download.ts`

```ts
import { ApiError, REFRESHABLE_401, toApiError } from '../api/errors';
import { endSession, getAccessToken, refreshAccessToken } from '../api/token-manager';

const API = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

/**
 * The filename from Content-Disposition: the RFC 5987 `filename*` (UTF-8) first, then
 * `filename`. E72 sends both; the plain one has non-ASCII characters replaced by `_`.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // malformed escape: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** E72: fetch the original file and save it under its real name. */
export async function downloadDocument(
  workspaceId: string,
  documentId: string,
  fallbackName: string,
  retried = false,
): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'AUTH_TOKEN_MISSING', 'Please sign in.');

  let res: Response;
  try {
    res = await fetch(`${API}/organizations/${workspaceId}/documents/${documentId}/download`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Organization-Id': workspaceId },
      credentials: 'include',
      signal: AbortSignal.timeout(130_000), // the server allows 120 s
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', "Can't reach AgentVault. Check your connection.");
  }

  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 401 && REFRESHABLE_401.has(error.code)) {
      if (!retried && (await refreshAccessToken())) return downloadDocument(workspaceId, documentId, fallbackName, true);
      endSession(error.code);
    }
    throw error;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
```

### `lib/knowledge/pii.ts`

```ts
import type { DetectedEntity } from '../api/types';

export type MaskedPart = { kind: 'text'; text: string } | { kind: 'entity'; placeholder: string; entity?: DetectedEntity };

/** Placeholders as the server writes them: [PERSON_1], [EMAIL_ADDRESS_2], [CUSTOM_1]. */
const PLACEHOLDER = /\[([A-Z][A-Z0-9_]*)_(\d+)\]/g;

/** Splits `maskedText` into plain text and placeholder chips (§6.5). */
export function splitPlaceholders(maskedText: string, entities: readonly DetectedEntity[]): MaskedPart[] {
  const byPlaceholder = new Map(entities.map((entity) => [entity.placeholder, entity]));
  const parts: MaskedPart[] = [];
  let last = 0;
  for (const match of maskedText.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: maskedText.slice(last, at) });
    parts.push({ kind: 'entity', placeholder: match[0], entity: byPlaceholder.get(match[0]) });
    last = at + match[0].length;
  }
  if (last < maskedText.length) parts.push({ kind: 'text', text: maskedText.slice(last) });
  return parts;
}

/** The report has no totalPages: compute it (§6.5). */
export const reportPages = (totalChunks: number, limit: number): number => Math.max(1, Math.ceil(totalChunks / limit));
```

### Test cases (all agree with the server)

- `clearanceOf` for the demo accounts: owner and HR → `RESTRICTED`; admin and auditor →
  `CONFIDENTIAL`; employee → `INTERNAL`; a set holding only `clearance:restricted` →
  `RESTRICTED`; an empty set → `PUBLIC`.
- `assignableClassifications(employee)` → `['PUBLIC', 'INTERNAL']`.
- `defaultUploadClassification({ defaultClassification: 'CONFIDENTIAL' }, employee)` →
  `{ value: 'INTERNAL', aboveClearance: true }`.
- `canOnKnowledgeBase` reproduces §3.6: employee on the Handbook (`MANAGE`): `upload`,
  `reindex`, `piiReport`, `search`, `viewGrants` true; `editDocument`, `deleteDocument`,
  `download`, `manageGrants`, `editKnowledgeBase`, `deleteKnowledgeBase` false. Employee
  with a `READ` grant: `upload` false (server: `KNOWLEDGE_BASE_ACCESS_DENIED`). HR on HR
  Policies (`MANAGE`): `deleteKnowledgeBase`, `reindex`, `piiReport` false; `download`,
  `manageGrants` true. Auditor on HR Policies (`READ`): `viewGrants` false (server: `403
  KNOWLEDGE_BASE_ACCESS_DENIED`), `piiReport` true, `upload` and `search` false.
- `displayStatus`: `{ status: 'EMBEDDING', indexVersion: 2, activeIndexVersion: 1,
  isSearchable: true }` → badge `INDEXING`, stage "Reindexing: embedding",
  `previousVersionServing` true; `{ status: 'FAILED', indexVersion: 2, activeIndexVersion:
  1, isSearchable: true }` → badge `FAILED`, `previousVersionServing` true;
  `{ status: 'PARSING', statusMessage: 'Attempt 1 of 3 failed (AI_SERVICE_UNAVAILABLE);
  retrying.' }` → `retrying` true.
- `pollInterval([])` → `false`; one `PARSING` document changed 5 s ago → 2000; 20 minutes
  ago → 15000; only `READY` documents → `false`.
- `precheckFile({ name: 'tool.exe', size: 4 })` → `TYPE_NOT_ALLOWED`; `{ name: 'README',
  size: 5 }` → `TYPE_NOT_ALLOWED` (no extension); `{ name: '.pdf', size: 5 }` →
  `TYPE_NOT_ALLOWED`; `{ name: 'Notes.MD', size: 5 }` → `null`; `{ name: 'a.txt', size: 0 }`
  → `EMPTY`; 52,428,801 bytes → `TOO_LARGE`; exactly 52,428,800 → `null`.
- `filenameFromDisposition('attachment; filename="_berblick remote-work.md";
  filename*=UTF-8\'\'%C3%9Cberblick%20remote-work.md')` → `'Überblick remote-work.md'`;
  `'attachment; filename="travel.pdf"; filename*=UTF-8\'\'travel.pdf'` → `'travel.pdf'`.
- `myLevelAfter` on the live grant list of a restricted base the admin created (their own
  `MEMBER` `MANAGE` grant, plus grants to other subjects): removing their own grant →
  `null`; lowering it to `READ` → `'READ'`.
- `reportPages(21, 10)` → `3`; `reportPages(0, 10)` → `1`.
- `splitPlaceholders('Contact [PERSON_1] at [EMAIL_ADDRESS_1].', entities)` → text,
  entity, text, entity, text; each entity part carries its `DetectedEntity`.
- `formatBytes('297')` → `'297 B'`; `formatBytes('204800')` → `'200 KB'`;
  `formatBytes(52428800)` → `'50 MB'`.
