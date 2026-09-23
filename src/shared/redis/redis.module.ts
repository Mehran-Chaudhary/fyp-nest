import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global Redis access.
 *
 * Global because caching, rate limiting, token revocation and (from phase 4)
 * queueing all need the same connection, and opening a second client per feature
 * module would multiply connections for no benefit.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
