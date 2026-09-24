import { Global, Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';

/**
 * S3-compatible object storage, exposed globally.
 *
 * Global for the same reason as Redis: one client and one connection pool per
 * process, shared by the upload path, the ingestion worker and the purge jobs.
 */
@Global()
@Module({
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class StorageModule {}
