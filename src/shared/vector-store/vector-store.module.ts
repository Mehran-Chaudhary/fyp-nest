import { Global, Module } from '@nestjs/common';
import { VectorStoreService } from './vector-store.service';

/** The vector store client. Global: one connection pool per process. */
@Global()
@Module({
  providers: [VectorStoreService],
  exports: [VectorStoreService],
})
export class VectorStoreModule {}
