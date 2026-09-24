/**
 * The document ingestion lifecycle.
 *
 *     UPLOADED ─▶ PARSING ─▶ CHUNKING ─▶ EMBEDDING ─▶ READY
 *         │          │           │           │
 *         └──────────┴───────────┴───────────┴──▶ FAILED
 *
 *     READY ──(reindex)──▶ UPLOADED        FAILED ──(retry)──▶ UPLOADED
 *
 * The status is the *latest run's* progress, not whether the document is
 * searchable: during a reindex a document reads EMBEDDING while its previous
 * version keeps serving queries (`activeIndexVersion`). Re-processing never
 * takes a document offline.
 *
 * Self-transitions and the CHUNKING → PARSING edge exist for crash recovery. A
 * worker that dies mid-parse leaves PARSING, and the retry parses again; one
 * that dies mid-embedding leaves EMBEDDING, and the retry resumes from the last
 * embedded chunk rather than starting over. Chunks are persisted in the same
 * transaction that moves CHUNKING → EMBEDDING, so a crash while CHUNKING means
 * no chunks were written and parsing must be redone.
 */
export enum DocumentStatus {
  UPLOADED = 'UPLOADED',
  PARSING = 'PARSING',
  CHUNKING = 'CHUNKING',
  EMBEDDING = 'EMBEDDING',
  READY = 'READY',
  FAILED = 'FAILED',
}

const TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  [DocumentStatus.UPLOADED]: [DocumentStatus.PARSING, DocumentStatus.FAILED],
  [DocumentStatus.PARSING]: [
    DocumentStatus.PARSING,
    DocumentStatus.CHUNKING,
    DocumentStatus.FAILED,
  ],
  [DocumentStatus.CHUNKING]: [
    DocumentStatus.PARSING,
    DocumentStatus.EMBEDDING,
    DocumentStatus.FAILED,
  ],
  [DocumentStatus.EMBEDDING]: [
    DocumentStatus.EMBEDDING,
    DocumentStatus.READY,
    DocumentStatus.FAILED,
  ],
  [DocumentStatus.READY]: [DocumentStatus.UPLOADED],
  [DocumentStatus.FAILED]: [DocumentStatus.UPLOADED],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses from which `to` may be entered. Used to build compare-and-set updates. */
export function sourcesOf(to: DocumentStatus): DocumentStatus[] {
  return (Object.keys(TRANSITIONS) as DocumentStatus[]).filter((from) =>
    TRANSITIONS[from].includes(to),
  );
}

/** A run is in progress (or waiting to start). */
export const IN_FLIGHT_STATUSES: readonly DocumentStatus[] = [
  DocumentStatus.UPLOADED,
  DocumentStatus.PARSING,
  DocumentStatus.CHUNKING,
  DocumentStatus.EMBEDDING,
];

export function isInFlight(status: DocumentStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

/** Supported upload formats, as stored. */
export enum DocumentFileType {
  PDF = 'PDF',
  DOCX = 'DOCX',
  TXT = 'TXT',
  MARKDOWN = 'MARKDOWN',
}

export const FILE_TYPE_DETAILS: Readonly<
  Record<
    DocumentFileType,
    { mimeType: string; wire: 'pdf' | 'docx' | 'txt' | 'md'; extensions: string[] }
  >
> = {
  [DocumentFileType.PDF]: { mimeType: 'application/pdf', wire: 'pdf', extensions: ['pdf'] },
  [DocumentFileType.DOCX]: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    wire: 'docx',
    extensions: ['docx'],
  },
  [DocumentFileType.TXT]: {
    mimeType: 'text/plain',
    wire: 'txt',
    extensions: ['txt', 'text'],
  },
  [DocumentFileType.MARKDOWN]: {
    mimeType: 'text/markdown',
    wire: 'md',
    extensions: ['md', 'markdown'],
  },
};
