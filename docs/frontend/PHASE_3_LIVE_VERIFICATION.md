# Phase 3 live API verification

**Date:** 6 October 2026, Asia/Karachi. **Backend source baseline:** `979dfd5` plus the P3-G01 phone-recognizer fix.

This report supplements the [Phase 3 handoff](PHASE_3_KNOWLEDGE_DOCUMENT_VAULT_PRIVACY.md). The owner asked for every Phase 3 endpoint to be tested and proven. The tests sent real HTTP requests to `http://localhost:3000`, with the backend running as `npm run start:dev`, and used disposable fixtures. Apart from P3-G01, no backend behavior was changed.

**Result of the final run: 401 checks, 401 passed, 0 failed; all 23 Phase 3 operations exercised, including an AI-service outage and recovery.** Completed at 2026-10-05T21:28:13.578Z (UTC). Machine-readable evidence: [PHASE_3_LIVE_RESULTS.json](PHASE_3_LIVE_RESULTS.json).

## Environment

| Dependency | What served it | Health at start |
|---|---|---|
| PostgreSQL | Supabase (session pooler), row-level security enforced under `daiap_rls` | up |
| Queues and workers | Aiven Valkey; BullMQ ingestion and maintenance workers inside the backend process | up |
| Object storage | Cloudflare R2 (`daiap/` key prefix) | up |
| Vector store | Qdrant Cloud, one `daiap_ws_<workspace>` collection per workspace | up |
| AI service | The project's `ai-service/` on `127.0.0.1:8000`: EmbeddingGemma 300M int8 (768 dimensions), jina-reranker-v1-turbo-en, Presidio + spaCy `en_core_web_md` + bert-base-NER, PDFium/python-docx parsers | up |
| Mail | Ethereal SMTP test inbox | used for invitations |

The backend's `/health` reported every dependency `up` before the run, and `/health/ready` returned 200.

## Coverage by operation

Each row counts the recorded requests to that operation and the outcomes observed. Polling requests are not recorded as checks. 129 further checks assert response shapes, visibility, data integrity and timing facts.

| Operation | Requests | Passed | Outcomes observed |
|---|---:|---:|---|
| P3-API-01 List knowledge bases | 13 | 13 | 200, 401 `API_KEY_REVOKED`, 404 `ORGANIZATION_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P3-API-02 Create knowledge base | 12 | 12 | 201, 403 `CLASSIFICATION_EXCEEDS_CLEARANCE`, 403 `PERMISSION_DENIED`, 409 `KNOWLEDGE_BASE_NAME_TAKEN`, 422 `VALIDATION_FAILED` |
| P3-API-03 Read knowledge base | 12 | 12 | 200, 400 `BAD_REQUEST`, 404 `KNOWLEDGE_BASE_NOT_FOUND` |
| P3-API-04 Update knowledge base | 10 | 10 | 200, 403 `CLASSIFICATION_EXCEEDS_CLEARANCE`, 403 `PERMISSION_DENIED`, 409 `KNOWLEDGE_BASE_NAME_TAKEN`, 422 `VALIDATION_FAILED` |
| P3-API-05 Delete knowledge base | 7 | 7 | 200, 403 `PERMISSION_DENIED` |
| P3-API-06 List grants | 5 | 5 | 200, 403 `KNOWLEDGE_BASE_ACCESS_DENIED` |
| P3-API-07 Grant or change access | 8 | 8 | 200, 403 `PERMISSION_DENIED`, 404 `RESOURCE_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P3-API-08 Revoke grant | 3 | 3 | 200, 404 `KNOWLEDGE_BASE_GRANT_NOT_FOUND` |
| P3-API-09 Upload document | 39 | 39 | 202, 400 `BAD_REQUEST`, 403 `CLASSIFICATION_EXCEEDS_CLEARANCE`, 403 `KNOWLEDGE_BASE_ACCESS_DENIED`, 403 `PERMISSION_DENIED`, 404 `KNOWLEDGE_BASE_NOT_FOUND`, 409 `DOCUMENT_DUPLICATE`, 413 `PAYLOAD_TOO_LARGE`, 415 `DOCUMENT_CONTENT_MISMATCH`, 415 `DOCUMENT_EMPTY`, 415 `DOCUMENT_TYPE_NOT_ALLOWED`, 422 `VALIDATION_FAILED` |
| P3-API-10 List documents | 14 | 14 | 200, 404 `KNOWLEDGE_BASE_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P3-API-11 Read document | 8 | 8 | 200, 404 `DOCUMENT_NOT_FOUND` |
| P3-API-12 Read chunks | 6 | 6 | 200, 401 `AUTH_SCHEME_NOT_ALLOWED`, 404 `DOCUMENT_NOT_FOUND` |
| P3-API-13 Download original | 9 | 9 | 200, 403 `PERMISSION_DENIED`, 404 `DOCUMENT_NOT_FOUND` |
| P3-API-14 Edit or reclassify | 9 | 9 | 200, 403 `CLASSIFICATION_EXCEEDS_CLEARANCE`, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED` |
| P3-API-15 Reindex or retry | 4 | 4 | 202, 403 `PERMISSION_DENIED`, 409 `DOCUMENT_PROCESSING` |
| P3-API-16 Delete document | 5 | 5 | 200, 403 `PERMISSION_DENIED`, 404 `DOCUMENT_NOT_FOUND` |
| P3-API-17 Read policy | 4 | 4 | 200, 403 `PERMISSION_DENIED` |
| P3-API-18 Update policy | 11 | 11 | 200, 403 `PERMISSION_DENIED`, 409 `RESOURCE_CONFLICT`, 422 `VALIDATION_FAILED` |
| P3-API-19 Entity types | 2 | 2 | 200, 403 `PERMISSION_DENIED` |
| P3-API-20 Analyze text | 10 | 10 | 200, 403 `PERMISSION_DENIED`, 422 `VALIDATION_FAILED`, 503 `PII_DETECTION_UNAVAILABLE` |
| P3-API-21 Document report | 8 | 8 | 200, 403 `PERMISSION_DENIED`, 404 `DOCUMENT_NOT_FOUND`, 422 `VALIDATION_FAILED` |
| P3-API-22 Retrieve passages | 24 | 24 | 200, 403 `PERMISSION_DENIED`, 404 `KNOWLEDGE_BASE_NOT_FOUND`, 422 `VALIDATION_FAILED`, 503 `AI_SERVICE_UNAVAILABLE` |
| P3-API-23 Access scope | 6 | 6 | 200, 403 `PERMISSION_DENIED` |

## What the checks establish

- **Access model.** Four built-in roles and one custom role holding `clearance:restricted` were tested in one workspace, plus a second tenant. The run verified:
  - compartments (RESTRICTED bases invisible without a grant, with the owner bypassing them);
  - levels (WRITE cannot list grants: `{required: MANAGE, granted: WRITE}`);
  - clearance (CONFIDENTIAL and RESTRICTED documents absent from lists, detail, chunks, downloads, reports and retrieval for lower clearances);
  - automatic creator grants, self-lockout, upsert semantics, and revoked-subject grants disappearing;
  - cross-tenant IDs returning 404, and a non-member getting 404 `ORGANIZATION_NOT_FOUND`.
- **Uploads.** PDF (2 pages), DOCX, Markdown, TXT, a 6-chunk handbook and a UTF-8 Urdu filename were processed to READY. Every inspection refusal was produced: empty, unsupported or missing extension, image, executable disguised as PDF, ZIP disguised as DOCX, DOCX with macros, binary disguised as text. So were the 413 size limit, the multipart field errors, the validation errors, clearance and level refusals, hidden-base 404, and duplicate detection with and without disclosure. Client paths and unsafe filename characters are sanitized.
- **Processing.** Status transitions were traced live. Reindexing keeps the previous version searchable. A double reindex returns 409. A corrupt PDF fails permanently with `UNPARSEABLE_DOCUMENT`, a text-less PDF with `DOCUMENT_EMPTY`, and a retry of a permanent failure fails again.
- **Downloads.** SHA-256 identical to the uploaded bytes for PDF, DOCX, a Unicode-named TXT and a FAILED document. Headers: `attachment`, RFC 5987 `filename*`, `private, no-store`. CORS exposes `content-disposition`.
- **Retrieval.** Hybrid search with reranking ranked the leave policy first for the leave question. Narrowing to a hidden base returns 404; narrowing to a hidden document silently matches nothing. Dense `minScore` filtering works; `topK` is capped at 50; hybrid search has no relevance floor. Reclassification takes effect immediately; deleted bases drop out of results.
- **Privacy.** The default and workspace policy, deny-list visibility, `expectedVersion` conflict, `null` handling, CUSTOM and allow-list behavior, redaction switched off, reveal gating (403 without `pii:reveal`, values with it), length limits and document reports with pagination were all exercised.
- **Outage and recovery.** The harness stopped the AI service mid-run. The results:
  - retrieval returned 503 `AI_SERVICE_UNAVAILABLE`;
  - analysis under REFUSE returned 503 `PII_DETECTION_UNAVAILABLE`; under DEGRADE_TO_PATTERNS it returned 200 with `degraded: true`, the email masked and the name not;
  - chunks and downloads kept working;
  - an upload made during the outage was accepted (202) and showed visible retries.

  The harness then restarted the service. The upload made during the outage reached READY on its second attempt without user action, and retrieval worked again. During the outage, `/health` answered 200 with `ai_service` and `pii_detector` `degraded` ("The AI service could not be reached: fetch failed."), and `/health/ready` stayed 200.
- **Destruction.** Before deletion, the R2 object and the Qdrant vectors of each document were confirmed to exist. After its base was deleted they were gone: after the Finance base was deleted, both documents' R2 objects and Qdrant vectors were gone within 1.9 s, checked with R2 HEAD requests and Qdrant point counts. After every base was deleted, the workspace's R2 prefix and Qdrant collection were checked: 0 objects and 0 vectors remained after 7.9 s.

Selected observations used in the handoff are stored under `facts` in the results file: status traces, reindex trace, retry messages, ranking, download headers, rate-limit headers, the role/visibility matrix and processing metrics.

## Fixture method and cleanup

- Six accounts registered through the public API with `p3-<timestamp>-<role>@example.invalid` addresses and generated passwords held only in process memory.
- The owner created the workspace, a custom role and four invitations. Each invitation email was **read from the Ethereal inbox over IMAP** and redeemed through `POST /invitations/accept`. No database rows were written directly.
- Test documents were generated in the harness: a real PDF, a DOCX package, Markdown and text. They contain only synthetic data (fictional names, `acme.test` addresses, test card numbers). Revealed values are replaced with a placeholder before results are written.
- Cleanup through the API deleted every knowledge base, which purged its storage objects and vectors, then soft-deleted both workspaces, revoked the disposable API key, and signed out every fixture session. Synthetic accounts remain for audit traceability, as in Phase 2.

## Run history

Every attempt is recorded; none is hidden.

| Attempt | Outcome | Cause and resolution |
|---|---|---|
| 1 | 370/372 | Both failures were in the harness's purge probe: it ignored the backend's `daiap/` storage and `daiap_` collection prefix defaults. Afterwards the workspace's R2 prefix held 0 objects and its collection 0 points. The probe was fixed and now also confirms existence before deletion |
| 2 | Aborted at fixture setup | The backend runs under `nest start --watch`. The P3-G01 source fix triggered a recompile and restart mid-run. Two empty workspaces (`f5276e6f-3dbc-43ec-be5d-41bf4d2237ca`, `cd13d616-aaa2-4bd1-b91d-b6a0bf6fc579`) and six accounts could not be cleaned up because their credentials existed only in the aborted process (INT-04). They hold no content |
| 3 | 391/396 | All five failures came from restarting the AI service: the spawned process inherited the backend's `LOG_LEVEL=info`, which the AI service rejects. With the service down, the outage upload exhausted its 5 attempts and correctly became FAILED `AI_SERVICE_UNAVAILABLE`, which is useful evidence in itself. The run then stopped before deleting two bases. Their workspace (`31053b9d-d850-4fe1-bf11-94724a412164`) is soft-deleted, so its remaining objects and vectors are removed by the organization purge after `ORGANIZATION_PURGE_GRACE` (7 days by default). The harness now starts the AI service with a clean environment and always deletes the bases it created |
| 4 | 295/297, stopped | A dense retrieval query returned a transient 503 `VECTOR_STORE_UNAVAILABLE` from Qdrant Cloud, and the harness treated it as fatal. A separate probe then sent the same query 12 times alongside 24 other dense and hybrid queries: 36/36 succeeded. The harness now retries an unexpected 503 once and records it under `facts.transientRetries`; the final run needed none. The run's cleanup deleted its workspaces; the outage phase had not started |
| 5 (final) | 401/401 | Evidence in the results file. `transientRetries` is empty |

## Defect found and fixed

**P3-G01 — phone masking ate a bracket.** Analysing `Ayesha Raza (ayesha.raza@acme.test, +92 300 1234567) earns …` produced `[PHONE_NUMBER_1] earns`: the international phone pattern accepts optional brackets around each digit group, so it absorbed the sentence's closing `)`. Masking then deleted that character from the text a model would receive. The fix (`src/modules/privacy/domain/recognizers/contact.recognizers.ts`) trims brackets that have no partner inside the match. A regression test was added (`recognizers.spec.ts`, "leaves a bracket that belongs to the sentence outside the number"). The full unit suite passes (40 suites, 749 tests), `tsc --noEmit` is clean, and the live run asserts `[PHONE_NUMBER_1]) earns`.

## What remains unverified

This is an API contract run, not frontend acceptance. It does not cover:
- browser rendering, accessibility, polling behavior in a client, or clipboard/download UX;
- encrypted PDFs, OCR of scanned pages, `TOO_MANY_CHUNKS`, `INGESTION_TIMEOUT`/`INGESTION_STALLED`;
- storage-quota exhaustion, integrity failure on download (409/410);
- object-storage or vector-store outages (only the AI service was stopped), and rate-limit exhaustion (429);
- platform-admin break-glass access, and concurrency races.

Section 13 of the handoff lists the related decisions.

## Reproduction

The [opt-in harness](../../scripts/verify-phase3-live.cjs) creates fresh fixtures and performs real writes against the backend named by `.env` (`APP_PORT`) or `P3_BASE_URL`. It needs the backend's `.env`, including R2, Qdrant and SMTP credentials, for the purge probes and the IMAP inbox. The outage option stops and restarts the AI service in `ai-service/` on port 8000 (Windows).

```powershell
node scripts/verify-phase3-live.cjs --run                      # main run, ~20 minutes
node scripts/verify-phase3-live.cjs --run --inject-ai-outage   # adds outage and recovery
```

Do not edit backend sources while it runs against a watch-mode server, which restarts on change. Each run sends 4 invitation emails from its fresh owner account (the email policy allows 5 per hour per user) and overwrites the results file, so archive evidence first. Run it only against a development backend you are allowed to write to.
