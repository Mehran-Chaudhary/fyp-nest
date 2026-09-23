import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JWT_CONFIG_KEY, type JwtConfig } from '../../config/jwt.config';
import { OrganizationsModule } from '../organizations/organizations.module';
import { RbacModule } from '../rbac/rbac.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { Session } from './entities/session.entity';
import { JwtTokenService } from './services/jwt-token.service';
import { SessionService } from './services/session.service';

/**
 * Authentication (proposal module 6.1).
 *
 * `JwtModule` is registered with no default signing secret on purpose. Access and
 * refresh tokens are signed with *different* keys, named explicitly at each call
 * site in `JwtTokenService`. A module-level default would make it possible to
 * sign a token without stating which key to use, and the resulting single-secret
 * setup would let a stolen refresh token be replayed as an access token —
 * defeating rotation and reuse detection entirely.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Session]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const jwt = configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY);
        return {
          // Verification defaults only; signing always names its own secret.
          verifyOptions: {
            issuer: jwt.issuer,
            audience: jwt.audience,
            algorithms: [jwt.algorithm],
            clockTolerance: jwt.clockToleranceSeconds,
          },
        };
      },
    }),
    UsersModule,
    OrganizationsModule,
    RbacModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionService, JwtTokenService],
  exports: [AuthService, JwtTokenService, SessionService],
})
export class AuthModule {}
