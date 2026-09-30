import { effectiveChunking, resolveChunking } from './chunking';

const platform = { chunkSize: 512, chunkOverlap: 64 };

describe('resolveChunking', () => {
  it('uses the platform defaults when nothing else is set', () => {
    expect(resolveChunking({}, {}, platform)).toEqual({ size: 512, overlap: 64 });
  });

  it('applies the workspace defaults to knowledge bases without their own', () => {
    expect(
      resolveChunking(
        { chunkSize: null, chunkOverlap: null },
        { defaultChunkSize: 256, defaultChunkOverlap: 32 },
        platform,
      ),
    ).toEqual({ size: 256, overlap: 32 });
  });

  it('lets the knowledge base override the workspace, field by field', () => {
    expect(
      resolveChunking(
        { chunkSize: 1024, chunkOverlap: null },
        { defaultChunkSize: 256, defaultChunkOverlap: 32 },
        platform,
      ),
    ).toEqual({ size: 1024, overlap: 32 });
  });

  it('ignores workspace values that are not numbers', () => {
    expect(
      resolveChunking({}, { defaultChunkSize: '256', defaultChunkOverlap: null }, platform),
    ).toEqual({ size: 512, overlap: 64 });
  });

  it('keeps the overlap below the size when levels combine badly', () => {
    // Workspace shrinks the size; the knowledge base's own overlap was valid for 512.
    expect(
      resolveChunking({ chunkOverlap: 200 }, { defaultChunkSize: 128 }, platform),
    ).toEqual({ size: 128, overlap: 32 });
  });
});

describe('effectiveChunking', () => {
  it('reports the configured pair without correcting it', () => {
    // What a knowledge-base edit is validated against: 300 does not fit 256.
    expect(
      effectiveChunking({ chunkOverlap: 300 }, { defaultChunkSize: 256 }, platform),
    ).toEqual({ size: 256, overlap: 300 });
  });

  it('falls back level by level, like resolveChunking', () => {
    expect(
      effectiveChunking(
        { chunkSize: 128, chunkOverlap: null },
        { defaultChunkOverlap: 32 },
        platform,
      ),
    ).toEqual({ size: 128, overlap: 32 });
  });
});
