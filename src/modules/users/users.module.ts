import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserToken } from './entities/user-token.entity';
import { UsersService } from './users.service';

/**
 * Platform identities and their one-time tokens.
 *
 * Exports `UsersService` because the authentication guard resolves the request
 * principal through it on every authenticated request, and because the auth and
 * invitation flows both need account lookups.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserToken])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
