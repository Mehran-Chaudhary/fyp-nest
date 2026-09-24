import { DocumentFileType } from '../domain/document-status';
import { FileInspectionError, inspectFile, type InspectionLimits } from './file-inspection';

/**
 * Upload inspection. The client's MIME type is never consulted, so these
 * tests construct real file bytes: minimal PDFs, genuine ZIP containers laid
 * out like Word documents, and the hostile variants the inspector exists to
 * refuse.
 */

const LIMITS: InspectionLimits = {
  allowedTypes: ['pdf', 'docx', 'txt', 'md'],
  maxUncompressedBytes: 10 * 1024 * 1024,
  maxCompressionRatio: 100,
};

/**
 * Builds a ZIP archive with STORED entries. The inspector reads only the
 * central directory, so CRCs are left zero; `declaredSize` lets a test lie
 * about an entry's uncompressed size, which is exactly what a zip bomb does.
 */
function zip(
  entries: Array<{ name: string; data?: string; declaredSize?: number }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? 'x', 'utf8');
    const uncompressed = entry.declaredSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const WORD_ENTRIES = [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: '_rels/.rels', data: '<Relationships/>' },
  { name: 'word/document.xml', data: '<w:document/>' },
];

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii');

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FileInspectionError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('file inspection', () => {
  describe('accepts genuine documents', () => {
    it('PDF', () => {
      expect(inspectFile(PDF, 'report.pdf', LIMITS)).toEqual({
        fileType: DocumentFileType.PDF,
        mimeType: 'application/pdf',
        extension: 'pdf',
      });
    });

    it('PDF with leading bytes before the header, as the specification allows', () => {
      const padded = Buffer.concat([Buffer.alloc(200, 0x20), PDF]);
      expect(inspectFile(padded, 'scan.pdf', LIMITS).fileType).toBe(DocumentFileType.PDF);
    });

    it('DOCX', () => {
      expect(inspectFile(zip(WORD_ENTRIES), 'policy.docx', LIMITS).fileType).toBe(
        DocumentFileType.DOCX,
      );
    });

    it('UTF-8 text, with or without a byte-order mark', () => {
      expect(
        inspectFile(Buffer.from('Leave policy — 25 days.\n'), 'a.txt', LIMITS).fileType,
      ).toBe(DocumentFileType.TXT);
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello')]);
      expect(inspectFile(bom, 'b.txt', LIMITS).fileType).toBe(DocumentFileType.TXT);
    });

    it('Markdown by extension', () => {
      expect(inspectFile(Buffer.from('# Title\n\nBody'), 'notes.md', LIMITS).fileType).toBe(
        DocumentFileType.MARKDOWN,
      );
    });

    it('non-Latin text', () => {
      expect(
        inspectFile(Buffer.from('ملازمین کی چھٹی کی پالیسی'), 'urdu.txt', LIMITS).fileType,
      ).toBe(DocumentFileType.TXT);
    });
  });

  describe('refuses disguised content', () => {
    it('an executable renamed .pdf', () => {
      const executable = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);
      expect(reasonOf(() => inspectFile(executable, 'invoice.pdf', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });

    it('a PDF renamed .docx', () => {
      expect(reasonOf(() => inspectFile(PDF, 'letter.docx', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });

    it('an arbitrary ZIP renamed .docx', () => {
      const archive = zip([{ name: 'payload.exe' }, { name: 'readme.txt' }]);
      expect(reasonOf(() => inspectFile(archive, 'contract.docx', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });

    it('a spreadsheet renamed .docx', () => {
      const xlsx = zip([{ name: '[Content_Types].xml' }, { name: 'xl/workbook.xml' }]);
      expect(reasonOf(() => inspectFile(xlsx, 'numbers.docx', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });

    it('binary data renamed .txt', () => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
      expect(reasonOf(() => inspectFile(binary, 'notes.txt', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });

    it('invalid UTF-8 renamed .txt', () => {
      const latin1 = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0xf6, 0x20, 0x57]);
      expect(reasonOf(() => inspectFile(latin1, 'notes.txt', LIMITS))).toBe(
        'CONTENT_MISMATCH',
      );
    });
  });

  describe('refuses hostile documents', () => {
    it('a Word document carrying macros', () => {
      const docm = zip([...WORD_ENTRIES, { name: 'word/vbaProject.bin' }]);
      expect(reasonOf(() => inspectFile(docm, 'harmless.docx', LIMITS))).toBe(
        'MACROS_PRESENT',
      );
    });

    it('a decompression bomb, by declared size', () => {
      const bomb = zip([
        ...WORD_ENTRIES,
        { name: 'word/media/huge.bin', declaredSize: 0xfffffff0 },
      ]);
      expect(reasonOf(() => inspectFile(bomb, 'bomb.docx', LIMITS))).toBe(
        'ARCHIVE_TOO_LARGE',
      );
    });

    it('a decompression bomb, by ratio', () => {
      const bomb = zip([
        ...WORD_ENTRIES,
        { name: 'word/media/ratio.bin', declaredSize: 5 * 1024 * 1024 },
      ]);
      expect(reasonOf(() => inspectFile(bomb, 'ratio.docx', LIMITS))).toBe(
        'ARCHIVE_TOO_LARGE',
      );
    });

    it('a truncated archive', () => {
      const truncated = zip(WORD_ENTRIES).subarray(0, 40);
      expect(reasonOf(() => inspectFile(truncated, 'cut.docx', LIMITS))).toBe('MALFORMED');
    });
  });

  describe('type policy', () => {
    it('refuses an empty file', () => {
      expect(reasonOf(() => inspectFile(Buffer.alloc(0), 'empty.pdf', LIMITS))).toBe(
        'EMPTY',
      );
    });

    it('refuses an unsupported extension even when the content is text', () => {
      expect(
        reasonOf(() => inspectFile(Buffer.from('<script>'), 'page.html', LIMITS)),
      ).toBe('TYPE_NOT_ALLOWED');
    });

    it('refuses a file with no extension', () => {
      expect(reasonOf(() => inspectFile(PDF, 'report', LIMITS))).toBe('TYPE_NOT_ALLOWED');
    });

    it('honours the configured allowlist', () => {
      const pdfOnly = { ...LIMITS, allowedTypes: ['pdf' as const] };
      expect(reasonOf(() => inspectFile(zip(WORD_ENTRIES), 'a.docx', pdfOnly))).toBe(
        'TYPE_NOT_ALLOWED',
      );
      expect(inspectFile(PDF, 'a.pdf', pdfOnly).fileType).toBe(DocumentFileType.PDF);
    });

    it('matches extensions case-insensitively', () => {
      expect(inspectFile(PDF, 'REPORT.PDF', LIMITS).fileType).toBe(DocumentFileType.PDF);
    });
  });
});
