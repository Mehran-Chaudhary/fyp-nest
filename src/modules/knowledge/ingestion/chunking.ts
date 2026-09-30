/** A chunk size or overlap, in tokens, possibly unset at a given level. */
interface ChunkingLevel {
  chunkSize?: number | null;
  chunkOverlap?: number | null;
}

/**
 * Chunk size and overlap as configured, each taken from the most specific
 * level that sets it: the knowledge base, then the workspace's defaults
 * (`settings.defaultChunkSize` / `defaultChunkOverlap`), then the platform's
 * (CHUNK_SIZE_DEFAULT / CHUNK_OVERLAP_DEFAULT).
 *
 * Not corrected: this is what a knowledge-base edit is validated against, so
 * that an overlap is refused when it does not fit the size that will actually
 * apply, not the platform's.
 */
export function effectiveChunking(
  knowledgeBase: ChunkingLevel,
  workspaceSettings: Record<string, unknown> | null | undefined,
  platform: { chunkSize: number; chunkOverlap: number },
): { size: number; overlap: number } {
  return {
    size:
      knowledgeBase.chunkSize ??
      numberOrNull(workspaceSettings?.defaultChunkSize) ??
      platform.chunkSize,
    overlap:
      knowledgeBase.chunkOverlap ??
      numberOrNull(workspaceSettings?.defaultChunkOverlap) ??
      platform.chunkOverlap,
  };
}

/**
 * Chunk size and overlap for a document: {@link effectiveChunking}, corrected.
 *
 * Size and overlap can come from different levels, and a workspace default can
 * change after a knowledge base was validated against it, so a combination with
 * the overlap at or above the size is still possible. The overlap is then
 * reduced to a quarter of the size rather than sending the AI service a request
 * it must reject.
 */
export function resolveChunking(
  knowledgeBase: ChunkingLevel,
  workspaceSettings: Record<string, unknown> | null | undefined,
  platform: { chunkSize: number; chunkOverlap: number },
): { size: number; overlap: number } {
  const { size, overlap } = effectiveChunking(knowledgeBase, workspaceSettings, platform);
  return { size, overlap: overlap < size ? overlap : Math.floor(size / 4) };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
