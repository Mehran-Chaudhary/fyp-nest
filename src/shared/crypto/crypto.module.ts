import { Global, Module } from '@nestjs/common';
import { ContentEncryptionService } from './content-encryption.service';
import { EncryptionService } from './encryption.service';
import { PasswordHashingService } from './password-hashing.service';
import { TokenService } from './token.service';

/**
 * Cryptographic primitives, exposed globally.
 *
 * Marked `@Global` because nearly every feature module needs at least one of
 * these, and threading the import through a dozen module definitions adds noise
 * without adding isolation — these services are stateless and side-effect free.
 */
@Global()
@Module({
  providers: [
    PasswordHashingService,
    TokenService,
    EncryptionService,
    ContentEncryptionService,
  ],
  exports: [
    PasswordHashingService,
    TokenService,
    EncryptionService,
    ContentEncryptionService,
  ],
})
export class CryptoModule {}
