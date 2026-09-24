import { registerAs } from '@nestjs/config';
import { parseByteSize } from '../common/utils/byte-size.util';

export type UploadFileType = 'pdf' | 'docx' | 'txt' | 'md';

export interface StorageConfig {
  /** True once a bucket is named. Uploads are refused with a clear error until then. */
  configured: boolean;
  s3: {
    bucket: string;
    endpoint?: string;
    region: string;
    /** Empty means the SDK's default credential chain (an IAM role on AWS). */
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    serverSideEncryption?: 'AES256' | 'aws:kms';
  };
  keyPrefix: string;
  uploads: {
    maxFileSizeBytes: number;
    allowedTypes: UploadFileType[];
  };
  /** Zero means unlimited. */
  quotaBytesPerOrganization: number;
}

export const STORAGE_CONFIG_KEY = 'storage';

export default registerAs(STORAGE_CONFIG_KEY, (): StorageConfig => {
  const bucket = process.env.STORAGE_S3_BUCKET ?? '';
  const prefix = process.env.STORAGE_KEY_PREFIX ?? '';

  return {
    configured: bucket.length > 0,
    s3: {
      bucket,
      endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
      region: process.env.STORAGE_S3_REGION as string,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
      serverSideEncryption:
        (process.env.STORAGE_S3_SERVER_SIDE_ENCRYPTION as 'AES256' | 'aws:kms' | '') ||
        undefined,
    },
    // Normalised to "" or "something/" so key construction never produces
    // "prefixorgs/..." or "prefix//orgs/...".
    keyPrefix: prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/` : '',
    uploads: {
      maxFileSizeBytes: parseByteSize(process.env.UPLOAD_MAX_FILE_SIZE as string),
      allowedTypes: (process.env.UPLOAD_ALLOWED_TYPES as string)
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean) as UploadFileType[],
    },
    quotaBytesPerOrganization: parseByteSize(
      process.env.STORAGE_QUOTA_PER_ORGANIZATION as string,
    ),
  };
});
