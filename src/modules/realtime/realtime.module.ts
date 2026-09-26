import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { RealtimeAuthService } from './realtime-auth.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeSecurityListener } from './realtime-security.listener';

/**
 * The real-time notification and WebSocket engine (proposal module 6.16).
 *
 * The gateway binds only in a process with an HTTP server (the API); the
 * worker publishes events through the shared event bus and never opens a
 * socket. `RealtimeIoAdapter` (installed in `main.ts`) configures the server.
 */
@Module({
  imports: [AuthModule, UsersModule, ApiKeysModule, OrganizationsModule],
  providers: [RealtimeAuthService, RealtimeGateway, RealtimeSecurityListener],
  exports: [RealtimeAuthService, RealtimeGateway],
})
export class RealtimeModule {}
