import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { STORAGE_CONFIG_KEY, type StorageConfig } from '../../config/storage.config';

/**
 * A failure talking to object storage.
 *
 * `retryable` separates "the provider is having a bad minute" (throttling, 5xx,
 * a dropped connection), which a queue retry will fix, from "that object does
 * not exist", which no amount of retrying will.
 */
export class ObjectStorageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly notFound = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ObjectStorageError';
  }
}

/**
 * S3-compatible object storage.
 *
 * One client covers every provider the platform is likely to be deployed
 * against — AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage, Wasabi and
 * MinIO — because they all speak the S3 API. Choosing between them is a
 * configuration change (`STORAGE_S3_ENDPOINT`), not a code change.
 *
 * Objects written here are already encrypted by `ContentEncryptionService`
 * before they leave the process. The provider stores ciphertext; provider-side
 * encryption (`STORAGE_S3_SERVER_SIDE_ENCRYPTION`) is an optional second layer,
 * not the one the platform relies on.
 */
@Injectable()
export class ObjectStorageService implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly config: StorageConfig;
  private client?: S3Client;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<StorageConfig>(STORAGE_CONFIG_KEY);
  }

  get isConfigured(): boolean {
    return this.config.configured;
  }

  onApplicationShutdown(): void {
    this.client?.destroy();
  }

  /**
   * Builds a namespaced object key.
   *
   * Segments are validated rather than escaped: every segment the platform
   * passes is a UUID or a fixed word, so anything else indicates a bug, and a
   * key built from an unexpected `../` is exactly the kind of bug that must
   * fail loudly.
   */
  key(...segments: string[]): string {
    for (const segment of segments) {
      if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..') {
        throw new Error(`Refusing to build an object key from segment "${segment}".`);
      }
    }
    return `${this.config.keyPrefix}${segments.join('/')}`;
  }

  /** Key prefix under which everything belonging to a workspace is stored. */
  organizationPrefix(organizationId: string): string {
    return `${this.key('orgs', organizationId)}/`;
  }

  async put(
    key: string,
    body: Buffer,
    options: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<{ etag?: string }> {
    const result = await this.run('put', () =>
      this.getClient().send(
        new PutObjectCommand({
          Bucket: this.config.s3.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: options.contentType ?? 'application/octet-stream',
          Metadata: options.metadata,
          ...(this.config.s3.serverSideEncryption
            ? { ServerSideEncryption: this.config.s3.serverSideEncryption }
            : {}),
        }),
      ),
    );

    return { etag: result.ETag?.replace(/"/g, '') };
  }

  /**
   * Reads a whole object into memory.
   *
   * Objects are bounded by the upload ceiling, so buffering is safe, and it is
   * required anyway: content is authenticated with AES-GCM, whose tag can only
   * be checked once every byte has been read.
   */
  async get(key: string, maxBytes?: number): Promise<Buffer> {
    const result = await this.run('get', () =>
      this.getClient().send(
        new GetObjectCommand({ Bucket: this.config.s3.bucket, Key: key }),
      ),
    );

    if (maxBytes !== undefined && (result.ContentLength ?? 0) > maxBytes) {
      throw new ObjectStorageError(
        `Object ${key} is ${result.ContentLength} bytes, above the ${maxBytes} byte ceiling.`,
        false,
      );
    }

    if (!result.Body) {
      throw new ObjectStorageError(`Object ${key} has no body.`, true);
    }

    return Buffer.from(await result.Body.transformToByteArray());
  }

  /** Idempotent: deleting a missing object succeeds, as S3 itself specifies. */
  async delete(key: string): Promise<void> {
    await this.run('delete', () =>
      this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.config.s3.bucket, Key: key }),
      ),
    );
  }

  /** Deletes every object under a prefix, in batches of the S3 maximum (1000). */
  async deletePrefix(prefix: string): Promise<number> {
    if (
      !prefix.startsWith(this.config.keyPrefix) ||
      prefix.length <= this.config.keyPrefix.length
    ) {
      // A bare or foreign prefix would empty far more than one workspace.
      throw new Error(`Refusing to delete by unscoped prefix "${prefix}".`);
    }

    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const page = await this.run('list', () =>
        this.getClient().send(
          new ListObjectsV2Command({
            Bucket: this.config.s3.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        ),
      );

      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length > 0) {
        await this.run('delete-batch', () =>
          this.getClient().send(
            new DeleteObjectsCommand({
              Bucket: this.config.s3.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          ),
        );
        deleted += keys.length;
      }

      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }

  /** Readiness probe: the bucket exists and these credentials can reach it. */
  async ping(): Promise<boolean> {
    try {
      await this.getClient().send(new HeadBucketCommand({ Bucket: this.config.s3.bucket }));
      return true;
    } catch (error) {
      this.logger.debug(`Object storage ping failed: ${(error as Error).message}`);
      return false;
    }
  }

  private getClient(): S3Client {
    if (!this.config.configured) {
      throw new ObjectStorageError(
        'Object storage is not configured. Set STORAGE_S3_BUCKET and its credentials.',
        false,
      );
    }

    if (!this.client) {
      const { s3 } = this.config;

      this.client = new S3Client({
        region: s3.region,
        endpoint: s3.endpoint,
        forcePathStyle: s3.forcePathStyle,
        credentials:
          s3.accessKeyId && s3.secretAccessKey
            ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
            : undefined,
        // Recent SDK versions attach CRC checksums to every request by default,
        // which several S3-compatible providers (R2, B2, older MinIO) reject.
        // Content integrity is already guaranteed end to end by the AES-GCM tag
        // on every object, so the SDK-level checksum adds nothing here.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        // The SDK's own retry with backoff for transient failures.
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 120_000 },
      });
    }

    return this.client;
  }

  private async run<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error;

      const status =
        error instanceof S3ServiceException ? error.$metadata?.httpStatusCode : undefined;
      const name = (error as Error)?.name;
      const notFound = status === 404 || name === 'NoSuchKey' || name === 'NotFound';
      const retryable =
        !notFound &&
        (status === undefined || status === 408 || status === 429 || status >= 500);

      throw new ObjectStorageError(
        `Object storage ${operation} failed: ${name ?? 'error'}${status ? ` (HTTP ${status})` : ''}.`,
        retryable,
        notFound,
        { cause: error },
      );
    }
  }
}
