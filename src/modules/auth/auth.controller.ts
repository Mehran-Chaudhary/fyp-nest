import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { THROTTLE_POLICY } from '../../config/throttle.config';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import {
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  OptionalOrganizationContext,
  Public,
  SkipOrganizationContext,
  ThrottlePolicy,
} from '../../common/decorators/auth.decorators';
import { Audit } from '../../common/decorators/audit.decorator';
import {
  ClientIp,
  CurrentOrganizationId,
  CurrentPermissions,
  CurrentUser,
  UserAgent,
} from '../../common/decorators/param.decorators';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { UnauthorizedError } from '../../common/exceptions/app.exception';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/interfaces/authenticated-request.interface';
import type { TokenPair } from '../../common/interfaces/jwt-payload.interface';
import { TokenType } from '../../common/interfaces/jwt-payload.interface';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../rbac/rbac.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  AuthResponseDto,
  BeginMfaSetupDto,
  ChangePasswordDto,
  CurrentUserDto,
  DisableMfaDto,
  EnableMfaDto,
  EnableMfaResponseDto,
  ForgotPasswordDto,
  LoginDto,
  MfaRequiredResponseDto,
  MfaSetupResponseDto,
  MfaStatusDto,
  RecoveryCodesDto,
  RefreshTokenDto,
  RegenerateRecoveryCodesDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SessionDto,
  TokenPairDto,
  UpdateProfileDto,
  VerifyEmailDto,
  VerifyMfaDto,
} from './dto/auth.dto';
import { MfaService } from './mfa/mfa.service';
import { JwtTokenService } from './services/jwt-token.service';

/**
 * Authentication endpoints (proposal module 6.1).
 *
 * ## Where the refresh token lives
 *
 * Refresh tokens are returned as an httpOnly, SameSite cookie by default and are
 * also included in the response body. That combination is deliberate:
 *
 *  - The **cookie** is what a browser client should use. httpOnly means script
 *    cannot read it, so an XSS flaw in the React app cannot exfiltrate a
 *    thirty-day credential — which is the single highest-value token the
 *    platform issues.
 *  - The **body** copy is what non-browser clients need: the Python AI service,
 *    mobile clients, integration tests and `curl`, none of which have a cookie
 *    jar tied to this origin.
 *
 * Deployments that serve only browsers should set
 * `REFRESH_TOKEN_COOKIE_ENABLED=true` and treat the body field as legacy;
 * `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=strict` are the right production
 * settings behind HTTPS.
 *
 * ## Rate limiting
 *
 * Every credential-handling route carries the strict `auth` policy, and the
 * email-sending routes carry `email` on top of it. Sign-in buckets are keyed by
 * IP *and* attempted address, so one address cannot be sprayed from a single
 * budget and one account cannot be cheaply locked out from many addresses.
 */
@ApiTags('Authentication')
@ApiExtraModels(MfaRequiredResponseDto)
@Controller({ path: 'auth', version: '1' })
@SkipOrganizationContext()
export class AuthController {
  private readonly security: SecurityConfig;

  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly rbacService: RbacService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly configService: ConfigService,
    private readonly mfaService: MfaService,
  ) {
    this.security = this.configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
  }

  // ── Registration & sign-in ────────────────────────────────────────────────

  @Post('register')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Registers a user and signs them in immediately. A verification email is sent; ' +
      'whether verification gates further access depends on REQUIRE_EMAIL_VERIFICATION.',
  })
  @ApiEnvelopedResponse(AuthResponseDto, 'Account created and signed in')
  @ApiErrorResponse(409, [ErrorCode.ACCOUNT_ALREADY_EXISTS])
  @ApiErrorResponse(422, [ErrorCode.VALIDATION_FAILED, ErrorCode.AUTH_PASSWORD_BREACHED])
  async register(
    @Body() dto: RegisterDto,
    @ClientIp() ip: string,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.register(dto, { ip, userAgent });
    return this.withRefreshCookie(response, result);
  }

  @Post('login')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Exchanges credentials for an access/refresh pair. Repeated failures lock the ' +
      'account for ACCOUNT_LOCKOUT_DURATION. On an account with two-step verification, ' +
      'a correct password returns `{ mfaRequired: true, challenge }` instead of tokens: ' +
      'finish with POST /auth/mfa/verify.',
  })
  @ApiEnvelopedResponse(AuthResponseDto, 'Signed in')
  @ApiErrorResponse(401, [ErrorCode.AUTH_INVALID_CREDENTIALS])
  @ApiErrorResponse(403, [
    ErrorCode.ACCOUNT_LOCKED,
    ErrorCode.ACCOUNT_SUSPENDED,
    ErrorCode.ACCOUNT_DEACTIVATED,
  ])
  @ApiErrorResponse(429, [ErrorCode.RATE_LIMIT_EXCEEDED])
  async login(
    @Body() dto: LoginDto,
    @ClientIp() ip: string,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto | MfaRequiredResponseDto> {
    const outcome = await this.authService.login(dto, { ip, userAgent });
    if (outcome.kind === 'mfa') return { mfaRequired: true, challenge: outcome.challenge };
    return this.withRefreshCookie(response, outcome.result);
  }

  // ── Two-step verification (phase 5) ───────────────────────────────────────

  @Post('mfa/verify')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish signing in with a code',
    description:
      'Exchanges the challenge from POST /auth/login and a current authenticator code (or a ' +
      'recovery code) for a session. Wrong codes count towards the account lockout.',
  })
  @ApiEnvelopedResponse(AuthResponseDto, 'Signed in')
  @ApiErrorResponse(401, [ErrorCode.MFA_CODE_INVALID, ErrorCode.MFA_CHALLENGE_INVALID])
  @ApiErrorResponse(403, [ErrorCode.ACCOUNT_LOCKED, ErrorCode.ACCOUNT_SUSPENDED])
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @ClientIp() ip: string,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.completeMfaLogin(
      dto.challengeToken,
      { code: dto.code, recoveryCode: dto.recoveryCode },
      { ip, userAgent },
    );
    return this.withRefreshCookie(response, result);
  }

  @Get('mfa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Your two-step verification status' })
  @ApiEnvelopedResponse(MfaStatusDto)
  @ApiStandardErrors()
  async mfaStatus(@CurrentUser() user: AuthenticatedUser): Promise<MfaStatusDto> {
    const status = await this.mfaService.status(user.id);
    return { ...status, sessionVerified: user.mfaVerified === true };
  }

  @Post('mfa/setup')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start two-step verification setup',
    description:
      'Returns a new secret and an otpauth:// URI for the authenticator app (render it as a ' +
      'QR code). Requires your password. Nothing changes until POST /auth/mfa/enable ' +
      'confirms a code.',
  })
  @ApiEnvelopedResponse(MfaSetupResponseDto)
  @ApiErrorResponse(401, [ErrorCode.AUTH_PASSWORD_MISMATCH])
  @ApiErrorResponse(409, [ErrorCode.MFA_ALREADY_ENABLED])
  @ApiStandardErrors()
  beginMfaSetup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BeginMfaSetupDto,
  ): Promise<MfaSetupResponseDto> {
    return this.mfaService.beginEnrollment(user.id, dto.password);
  }

  @Post('mfa/enable')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Turn two-step verification on',
    description:
      'Confirms a first code from the authenticator. Returns single-use recovery codes ' +
      '(shown once) and an access token for this session that carries the second factor. ' +
      'Other devices are signed out.',
  })
  @ApiEnvelopedResponse(EnableMfaResponseDto)
  @ApiErrorResponse(401, [ErrorCode.MFA_CODE_INVALID])
  @ApiErrorResponse(409, [ErrorCode.MFA_ALREADY_ENABLED, ErrorCode.MFA_NOT_ENROLLING])
  @ApiStandardErrors()
  enableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EnableMfaDto,
  ): Promise<EnableMfaResponseDto> {
    return this.authService.enableMfa(user.id, dto.code, user.sessionId);
  }

  @Post('mfa/disable')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Turn two-step verification off',
    description:
      'Requires your password and a current code (or a recovery code). Audited as CRITICAL ' +
      'and notified by email.',
  })
  @ApiErrorResponse(401, [ErrorCode.AUTH_PASSWORD_MISMATCH, ErrorCode.MFA_CODE_INVALID])
  @ApiErrorResponse(409, [ErrorCode.MFA_NOT_ENABLED])
  @ApiStandardErrors()
  async disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DisableMfaDto,
  ): Promise<{ disabled: true }> {
    await this.mfaService.disable(user.id, dto.password, {
      code: dto.code,
      recoveryCode: dto.recoveryCode,
    });
    return { disabled: true };
  }

  @Post('mfa/recovery-codes')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Replace your recovery codes',
    description:
      'Invalidates every unused code and returns a new set. Requires password and code.',
  })
  @ApiEnvelopedResponse(RecoveryCodesDto)
  @ApiErrorResponse(401, [ErrorCode.AUTH_PASSWORD_MISMATCH, ErrorCode.MFA_CODE_INVALID])
  @ApiStandardErrors()
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegenerateRecoveryCodesDto,
  ): Promise<RecoveryCodesDto> {
    return {
      recoveryCodes: await this.mfaService.regenerateRecoveryCodes(
        user.id,
        dto.password,
        dto.code,
      ),
    };
  }

  @Post('refresh')
  @Public()
  // Its own budget, per session: renewing a token is not guessing a
  // credential, and a browser renews on every page load.
  @ThrottlePolicy(THROTTLE_POLICY.REFRESH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the token pair',
    description:
      'Exchanges a refresh token for a new pair and invalidates the old one. ' +
      'Presenting an already-rotated token is treated as evidence of compromise: ' +
      'every session in that family is revoked and the owner is notified.',
  })
  @ApiEnvelopedResponse(TokenPairDto, 'New token pair issued')
  @ApiErrorResponse(401, [
    ErrorCode.AUTH_REFRESH_TOKEN_INVALID,
    ErrorCode.AUTH_REFRESH_TOKEN_REUSED,
    ErrorCode.AUTH_TOKEN_EXPIRED,
    ErrorCode.AUTH_TOKEN_REVOKED,
  ])
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: AuthenticatedRequest,
    @ClientIp() ip: string,
    @UserAgent() userAgent: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TokenPairDto> {
    const refreshToken = dto.refreshToken ?? this.readRefreshCookie(request);

    if (!refreshToken) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_MISSING, {
        message: 'No refresh token supplied. Send it in the body or as the refresh cookie.',
      });
    }

    const tokens = await this.authService.refresh(refreshToken, { ip, userAgent });

    this.setRefreshCookie(response, tokens.refreshToken);

    return this.presentTokens(tokens);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign out of this device',
    description:
      'Revokes the current session family and denylists the presented access token. ' +
      'Other devices stay signed in.',
  })
  @ApiStandardErrors()
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revokedSessions: number }> {
    const claims = this.requireAccessClaims(request);
    const refreshToken = dto.refreshToken ?? this.readRefreshCookie(request);

    const result = await this.authService.logout(claims, refreshToken);

    this.clearRefreshCookie(response);

    return result;
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign out everywhere',
    description:
      'Revokes every session on every device, including this one. Use after a ' +
      'suspected compromise.',
  })
  @ApiStandardErrors()
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ revokedSessions: number }> {
    const result = await this.authService.logoutAll(user.id);
    this.clearRefreshCookie(response);
    return result;
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  @Get('me')
  @OptionalOrganizationContext()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The signed-in user',
    description:
      'Profile, workspace memberships and — when a workspace is selected via ' +
      'X-Organization-Id — the effective permissions in it, with wildcards expanded ' +
      'to concrete keys so the frontend can drive per-control visibility directly. ' +
      'Naming a workspace applies the same checks as any workspace route (membership, ' +
      'suspension, IP allowlist, MFA and email requirements).',
  })
  @ApiEnvelopedResponse(CurrentUserDto)
  @ApiStandardErrors()
  async me(
    @CurrentUser() authUser: AuthenticatedUser,
    @CurrentOrganizationId() organizationId: string | undefined,
    @CurrentPermissions() permissions: string[],
  ): Promise<CurrentUserDto> {
    const user = await this.usersService.findByIdOrFail(authUser.id);
    const memberships = await this.organizationsService.listForUser(user.id, 1, 100);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.preferredName,
      emailVerified: user.isEmailVerified,
      isPlatformAdmin: user.isPlatformAdmin,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      avatarUrl: user.avatarUrl,
      memberships: memberships.items.map((entry) => ({
        organizationId: entry.organization.id,
        organizationName: entry.organization.name,
        organizationSlug: entry.organization.slug,
        roleSlugs: (entry.membership.roles ?? []).map((role) => role.slug),
        isOwner: entry.organization.ownerId === user.id,
      })),
      permissions:
        permissions.length > 0
          ? this.rbacService.expandToConcretePermissions(permissions)
          : undefined,
      activeOrganizationId: organizationId,
    };
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update your profile' })
  @Audit({ action: AuditAction.USER_PROFILE_UPDATED, resourceType: 'user' })
  @ApiStandardErrors()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<{ id: string; displayName: string }> {
    const updated = await this.usersService.updateProfile(user.id, dto);
    return { id: updated.id, displayName: updated.preferredName };
  }

  // ── Email verification ────────────────────────────────────────────────────

  @Post('verify-email')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address' })
  @ApiErrorResponse(401, [
    ErrorCode.TOKEN_NOT_FOUND,
    ErrorCode.TOKEN_EXPIRED,
    ErrorCode.TOKEN_ALREADY_USED,
  ])
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @ClientIp() ip: string,
  ): Promise<{ verified: boolean }> {
    return this.authService.verifyEmail(dto.token, { ip });
  }

  @Post('resend-verification')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.EMAIL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-send the verification email',
    description:
      'Always reports success, whether or not the address is registered. ' +
      'Reporting otherwise would make this endpoint an address oracle — and an ' +
      'easier one to script than sign-in, since it needs no password guesses.',
  })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @ClientIp() ip: string,
  ): Promise<{ sent: true }> {
    return this.authService.resendVerification(dto.email, { ip });
  }

  // ── Password ──────────────────────────────────────────────────────────────

  @Post('forgot-password')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.EMAIL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset',
    description: 'Always reports success, for the same reason as resend-verification.',
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @ClientIp() ip: string,
  ): Promise<{ sent: true }> {
    return this.authService.requestPasswordReset(dto.email, { ip });
  }

  @Post('reset-password')
  @Public()
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a password reset',
    description:
      'Sets a new password and revokes every outstanding session, so whoever ' +
      'requested the reset is the only party left with access.',
  })
  @ApiErrorResponse(401, [
    ErrorCode.TOKEN_NOT_FOUND,
    ErrorCode.TOKEN_EXPIRED,
    ErrorCode.TOKEN_ALREADY_USED,
  ])
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @ClientIp() ip: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ reset: true }> {
    const result = await this.authService.resetPassword(dto.token, dto.password, { ip });
    this.clearRefreshCookie(response);
    return result;
  }

  @Post('change-password')
  @ThrottlePolicy(THROTTLE_POLICY.AUTH)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Requires the current password even though you are signed in — an unattended ' +
      'session must not be enough to take permanent ownership of an account. ' +
      'Signs out every other device.',
  })
  @ApiErrorResponse(401, [ErrorCode.AUTH_PASSWORD_MISMATCH])
  @ApiStandardErrors()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() request: AuthenticatedRequest,
    @ClientIp() ip: string,
  ): Promise<{ changed: true; revokedSessions: number }> {
    const refreshToken = this.readRefreshCookie(request);
    const familyId = refreshToken
      ? this.jwtTokenService.decodeUnsafe<{ fam?: string }>(refreshToken)?.fam
      : undefined;

    return this.authService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      familyId,
      { ip },
    );
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List your active devices',
    description:
      'One entry per device. Rotated tokens are collapsed into their family, so a ' +
      'month-old session shows as one device rather than hundreds of rows.',
  })
  @ApiEnvelopedResponse(SessionDto)
  @ApiStandardErrors()
  async listSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionDto[]> {
    return this.authService.listSessions(user.id, user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out a specific device' })
  @ApiErrorResponse(404, [ErrorCode.AUTH_SESSION_NOT_FOUND])
  @ApiStandardErrors()
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): Promise<{ revoked: number }> {
    return this.authService.revokeSession(user.id, sessionId);
  }

  // ── Cookie helpers ────────────────────────────────────────────────────────

  private withRefreshCookie(
    response: Response,
    result: { user: AuthResponseDto['user']; tokens: TokenPair },
  ): AuthResponseDto {
    this.setRefreshCookie(response, result.tokens.refreshToken);

    return { user: result.user, tokens: this.presentTokens(result.tokens) };
  }

  /**
   * Shapes the token pair for the response body.
   *
   * When the cookie is enabled the refresh token is omitted from the body: a
   * browser client does not need it there, and every copy of a long-lived
   * credential is another place it can leak from — a logged response body, a
   * client-side error report, a proxy access log.
   */
  private presentTokens(tokens: TokenPair): TokenPairDto {
    return {
      accessToken: tokens.accessToken,
      ...(this.security.refreshCookie.enabled ? {} : { refreshToken: tokens.refreshToken }),
      tokenType: tokens.tokenType,
      expiresIn: tokens.expiresIn,
      expiresAt: tokens.expiresAt,
      refreshExpiresIn: tokens.refreshExpiresIn,
    };
  }

  private setRefreshCookie(response: Response, refreshToken: string): void {
    if (!this.security.refreshCookie.enabled) return;

    response.cookie(this.security.refreshCookie.name, refreshToken, {
      httpOnly: true,
      secure: this.security.refreshCookie.secure,
      sameSite: this.security.refreshCookie.sameSite,
      domain: this.security.refreshCookie.domain,
      // Scoped to the auth routes, so the cookie is not attached to every
      // request the frontend makes and cannot be read by unrelated handlers.
      path: '/api/v1/auth',
      maxAge: this.jwtTokenService.refreshTokenTtlMs,
      signed: false,
    });
  }

  private clearRefreshCookie(response: Response): void {
    if (!this.security.refreshCookie.enabled) return;

    response.clearCookie(this.security.refreshCookie.name, {
      httpOnly: true,
      secure: this.security.refreshCookie.secure,
      sameSite: this.security.refreshCookie.sameSite,
      domain: this.security.refreshCookie.domain,
      path: '/api/v1/auth',
    });
  }

  private readRefreshCookie(request: AuthenticatedRequest): string | undefined {
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    return cookies?.[this.security.refreshCookie.name];
  }

  /**
   * Re-derives the access token's claims for sign-out.
   *
   * The guard keeps only a narrow projection on the request, but revoking a
   * token needs its `jti` and `exp` so the denylist entry can be given exactly
   * the token's remaining lifetime.
   */
  private requireAccessClaims(request: AuthenticatedRequest) {
    const header = request.headers.authorization ?? '';
    const token = header.slice('Bearer '.length).trim();

    const claims = this.jwtTokenService.decodeUnsafe<{
      sub: string;
      jti: string;
      sid: string;
      email: string;
      exp: number;
      isPlatformAdmin: boolean;
    }>(token);

    if (!claims?.jti || !claims.sid) {
      throw new UnauthorizedError(ErrorCode.AUTH_TOKEN_INVALID);
    }

    // Safe to decode without re-verifying: the authentication guard has already
    // verified this exact token's signature, expiry and revocation state before
    // the request reached this handler.
    return { ...claims, type: TokenType.ACCESS as const };
  }
}
