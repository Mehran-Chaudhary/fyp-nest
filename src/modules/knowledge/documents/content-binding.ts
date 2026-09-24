/**
 * Associated-data strings binding each ciphertext to the thing it belongs to.
 *
 * AES-GCM authenticates associated data along with the ciphertext, so a value
 * sealed under one binding fails to open under any other. Copying a chunk's
 * ciphertext into another chunk's row, or swapping two documents' objects in
 * the bucket, therefore produces an authentication failure rather than a
 * silently wrong answer. These strings are part of the storage format: changing
 * one makes everything sealed under the old form unreadable.
 */

/** The original uploaded file in object storage. */
export const originalObjectAad = (documentId: string): string =>
  `document:${documentId}:original`;

/** One chunk of extracted text. */
export const chunkAad = (chunkId: string): string => `chunk:${chunkId}`;

/** The document's wrapped data key. */
export const dataKeyBinding = (documentId: string): string => `document:${documentId}`;
