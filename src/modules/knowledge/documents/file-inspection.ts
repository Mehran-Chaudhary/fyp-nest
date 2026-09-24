import type { UploadFileType } from '../../../config/storage.config';
import { fileExtension } from '../../../common/utils/text.util';
import { DocumentFileType, FILE_TYPE_DETAILS } from '../domain/document-status';

/**
 * Upload content inspection.
 *
 * The client's `Content-Type` is ignored entirely: it is whatever the client
 * says it is, and forging it is a one-line change. The type is determined from
 * the bytes — magic numbers, container structure, text decodability — and then
 * required to agree with the filename's extension. Disagreement is refused
 * rather than resolved, because a file that *looks like* one type to the
 * platform and *is named* another is exactly how polyglot and
 * content-confusion attacks start.
 *
 * DOCX receives the most scrutiny, because a DOCX is a ZIP archive:
 *
 *  - The central directory is read (without decompressing anything) to confirm
 *    it really is a Word document and not an arbitrary archive named `.docx`.
 *  - A `vbaProject.bin` entry means embedded macros — a `.docm` in disguise —
 *    and is refused.
 *  - Declared uncompressed sizes are summed and the compression ratio checked,
 *    so a zip bomb is rejected here instead of being handed to the parser.
 */

export type FileInspectionFailure =
  | 'EMPTY'
  | 'TYPE_NOT_ALLOWED'
  | 'CONTENT_MISMATCH'
  | 'MALFORMED'
  | 'MACROS_PRESENT'
  | 'ARCHIVE_TOO_LARGE';

export class FileInspectionError extends Error {
  constructor(
    readonly reason: FileInspectionFailure,
    message: string,
    readonly detected?: string,
  ) {
    super(message);
    this.name = 'FileInspectionError';
  }
}

export interface FileInspection {
  fileType: DocumentFileType;
  mimeType: string;
  extension: string;
}

export interface InspectionLimits {
  allowedTypes: readonly UploadFileType[];
  /** Ceiling on the total declared uncompressed size of an archive. */
  maxUncompressedBytes: number;
  /** Ceiling on uncompressed/compressed ratio. Legitimate DOCX sits well under 20. */
  maxCompressionRatio: number;
}

type Detected = 'pdf' | 'docx' | 'text' | 'zip' | 'unknown';

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const MAX_ZIP_ENTRIES = 10_000;

export function inspectFile(
  content: Buffer,
  filename: string,
  limits: InspectionLimits,
): FileInspection {
  if (content.length === 0) {
    throw new FileInspectionError('EMPTY', 'The file is empty.');
  }

  const extension = fileExtension(filename);
  const declared = typeFromExtension(extension);

  if (!declared) {
    throw new FileInspectionError(
      'TYPE_NOT_ALLOWED',
      extension
        ? `Files with the .${extension} extension are not accepted.`
        : 'The file has no extension, so its type cannot be confirmed.',
    );
  }

  if (!limits.allowedTypes.includes(FILE_TYPE_DETAILS[declared].wire)) {
    throw new FileInspectionError(
      'TYPE_NOT_ALLOWED',
      `${declared} uploads are disabled on this deployment.`,
    );
  }

  const detected = sniff(content, limits);

  const agrees =
    (detected === 'pdf' && declared === DocumentFileType.PDF) ||
    (detected === 'docx' && declared === DocumentFileType.DOCX) ||
    (detected === 'text' &&
      (declared === DocumentFileType.TXT || declared === DocumentFileType.MARKDOWN));

  if (!agrees) {
    throw new FileInspectionError(
      'CONTENT_MISMATCH',
      detected === 'unknown'
        ? `The file is named .${extension} but its contents are not a recognised document.`
        : `The file is named .${extension} but its contents are ${describe(detected)}.`,
      detected,
    );
  }

  return {
    fileType: declared,
    mimeType: FILE_TYPE_DETAILS[declared].mimeType,
    extension,
  };
}

function typeFromExtension(extension: string): DocumentFileType | null {
  for (const [type, details] of Object.entries(FILE_TYPE_DETAILS)) {
    if (details.extensions.includes(extension)) return type as DocumentFileType;
  }
  return null;
}

function describe(detected: Detected): string {
  switch (detected) {
    case 'pdf':
      return 'a PDF';
    case 'docx':
      return 'a Word document';
    case 'zip':
      return 'an archive that is not a Word document';
    case 'text':
      return 'plain text';
    default:
      return 'unrecognised';
  }
}

function sniff(content: Buffer, limits: InspectionLimits): Detected {
  // The PDF specification tolerates bytes before the header; readers look in
  // the first kilobyte, so this does too.
  const head = content.subarray(0, 1024);
  if (head.indexOf(PDF_MAGIC) !== -1) return 'pdf';

  if (content.length >= 4 && content.readUInt32LE(0) === ZIP_LOCAL_HEADER) {
    return inspectOfficeArchive(content, limits);
  }

  return isText(content) ? 'text' : 'unknown';
}

/**
 * Reads a ZIP central directory — names and declared sizes only, nothing is
 * decompressed — and decides whether this is a macro-free Word document.
 */
function inspectOfficeArchive(content: Buffer, limits: InspectionLimits): Detected {
  const eocd = findEndOfCentralDirectory(content);
  if (eocd < 0) {
    throw new FileInspectionError('MALFORMED', 'The archive is truncated or corrupt.');
  }

  const entryCount = content.readUInt16LE(eocd + 10);
  const directorySize = content.readUInt32LE(eocd + 12);
  const directoryOffset = content.readUInt32LE(eocd + 16);

  if (
    entryCount === 0xffff ||
    directoryOffset === 0xffffffff ||
    entryCount > MAX_ZIP_ENTRIES ||
    directoryOffset + directorySize > content.length
  ) {
    throw new FileInspectionError('MALFORMED', 'The archive structure is not supported.');
  }

  const names = new Set<string>();
  let totalUncompressed = 0;
  let cursor = directoryOffset;

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (
      cursor + 46 > content.length ||
      content.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER
    ) {
      throw new FileInspectionError('MALFORMED', 'The archive directory is corrupt.');
    }

    const uncompressed = content.readUInt32LE(cursor + 24);
    const nameLength = content.readUInt16LE(cursor + 28);
    const extraLength = content.readUInt16LE(cursor + 30);
    const commentLength = content.readUInt16LE(cursor + 32);

    if (uncompressed === 0xffffffff) {
      throw new FileInspectionError('MALFORMED', 'ZIP64 archives are not supported.');
    }

    names.add(
      content.toString('utf8', cursor + 46, cursor + 46 + nameLength).toLowerCase(),
    );
    totalUncompressed += uncompressed;
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (
    totalUncompressed > limits.maxUncompressedBytes ||
    totalUncompressed / content.length > limits.maxCompressionRatio
  ) {
    throw new FileInspectionError(
      'ARCHIVE_TOO_LARGE',
      'The document expands to an implausible size and was refused as a possible decompression bomb.',
    );
  }

  const isWord = names.has('[content_types].xml') && names.has('word/document.xml');
  if (!isWord) return 'zip';

  if ([...names].some((name) => name.endsWith('vbaproject.bin'))) {
    throw new FileInspectionError(
      'MACROS_PRESENT',
      'The document contains macros. Save it as a macro-free .docx and upload again.',
      'docm',
    );
  }

  return 'docx';
}

function findEndOfCentralDirectory(content: Buffer): number {
  // The record is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const earliest = Math.max(0, content.length - 22 - 0xffff);
  for (let offset = content.length - 22; offset >= earliest; offset -= 1) {
    if (content.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/**
 * Valid UTF-8 with no NUL bytes and almost no other control characters.
 *
 * NUL never appears in genuine text and appears constantly in binary formats,
 * which makes it the single most reliable discriminator. Tab, newline,
 * carriage return and form feed are ordinary text.
 */
function isText(content: Buffer): boolean {
  let body = content;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }

  let controls = 0;
  for (const byte of body) {
    if (byte === 0x00) return false;
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) ||
      byte === 0x7f
    ) {
      controls += 1;
    }
  }

  if (controls > Math.max(1, body.length / 1000)) return false;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}
