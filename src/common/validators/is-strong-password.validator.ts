import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { SECURITY_CONFIG_KEY, type PasswordPolicy, type SecurityConfig } from '../../config/security.config';

/**
 * Passwords rejected outright regardless of whether they satisfy the character
 * rules.
 *
 * `Password123!` passes every "one uppercase, one number, one symbol" check ever
 * written and is among the first entries in any credential-stuffing list. A
 * small denylist of the patterns that composition rules systematically fail to
 * catch is disproportionately effective. This is a representative sample, not a
 * substitute for a full breached-password check — integrating one (for example
 * Have I Been Pwned's k-anonymity range API) is a phase 5 item, and is noted as
 * such because it requires an outbound network call the platform does not
 * otherwise make.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  'password123!',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword123',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'letmein',
  'letmein123',
  'welcome',
  'welcome1',
  'welcome123',
  'admin',
  'admin123',
  'administrator',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'trustno1',
  'abc123',
  'abcd1234',
  'changeme',
  'secret',
  'default',
  'test1234',
  'root',
  'toor',
]);

export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
  /** Coarse 0-4 score, surfaced to the frontend for a strength meter. */
  score: number;
}

/**
 * Evaluates a password against the configured policy.
 *
 * Exported as a plain function as well as a decorator so the auth service can
 * re-check on password *change* — where the value does not arrive through a DTO
 * that the validation pipe would process.
 */
export function evaluatePasswordStrength(
  password: string,
  policy: PasswordPolicy,
  personalData: readonly string[] = [],
): PasswordStrengthResult {
  const errors: string[] = [];

  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, errors: ['Password is required.'], score: 0 };
  }

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters long.`);
  }
  if (password.length > policy.maxLength) {
    errors.push(`Password must be no more than ${policy.maxLength} characters long.`);
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain a lowercase letter.');
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter.');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain a number.');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain a symbol.');
  }

  const normalised = password.toLowerCase();

  if (COMMON_PASSWORDS.has(normalised)) {
    errors.push('That password is too common. Please choose something less predictable.');
  }

  // Four or more identical characters in a row ("aaaa"), which composition rules
  // otherwise accept happily.
  if (/(.)\1{3,}/.test(password)) {
    errors.push('Password must not contain long runs of the same character.');
  }

  // Sequential runs, the other classic composition-rule blind spot.
  if (containsSequence(normalised, 5)) {
    errors.push('Password must not contain long sequences such as "12345" or "abcde".');
  }

  // A password containing the user's own email or name is trivially guessable by
  // anyone who knows them, which for an enterprise workspace is everyone.
  for (const value of personalData) {
    if (!value || value.length < 3) continue;
    if (normalised.includes(value.toLowerCase())) {
      errors.push('Password must not contain your name or email address.');
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    score: scorePassword(password),
  };
}

/** Detects an ascending or descending run of `length` consecutive characters. */
function containsSequence(value: string, length: number): boolean {
  if (value.length < length) return false;

  let ascending = 1;
  let descending = 1;

  for (let index = 1; index < value.length; index += 1) {
    const delta = value.charCodeAt(index) - value.charCodeAt(index - 1);

    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;

    if (ascending >= length || descending >= length) return true;
  }

  return false;
}

/**
 * A coarse strength score.
 *
 * Length-weighted on purpose: length contributes more entropy than character
 * variety, and a meter that rewards `P@s1` over `correct horse battery staple`
 * teaches users the wrong lesson.
 */
function scorePassword(password: string): number {
  let score = 0;

  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (password.length >= 20) score += 1;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes >= 3) score += 1;

  if (COMMON_PASSWORDS.has(password.toLowerCase())) score = 0;

  return Math.min(score, 4);
}

/**
 * class-validator constraint backing `@IsStrongPassword()`.
 *
 * Injectable so it can read the live policy from configuration; this requires
 * `useContainer(app.select(AppModule), { fallbackOnErrors: true })` during
 * bootstrap, which `main.ts` sets up.
 */
@ValidatorConstraint({ name: 'isStrongPassword', async: false })
@Injectable()
export class IsStrongPasswordConstraint implements ValidatorConstraintInterface {
  private lastErrors: string[] = [];

  constructor(private readonly configService: ConfigService) {}

  validate(password: string, args: ValidationArguments): boolean {
    const policy = this.configService.get<SecurityConfig>(SECURITY_CONFIG_KEY)?.passwordPolicy;

    if (!policy) {
      // Configuration is validated at boot, so this should be unreachable.
      // Failing closed is still the right call for a password check.
      this.lastErrors = ['Password policy is unavailable.'];
      return false;
    }

    // Pull the user's own identifying fields off the DTO so the password cannot
    // simply repeat them.
    const object = args.object as Record<string, unknown>;
    const personalData = ['email', 'firstName', 'lastName', 'displayName']
      .map((key) => object[key])
      .filter((value): value is string => typeof value === 'string');

    const result = evaluatePasswordStrength(password, policy, personalData);
    this.lastErrors = result.errors;

    return result.valid;
  }

  defaultMessage(): string {
    return this.lastErrors.length > 0
      ? this.lastErrors.join(' ')
      : 'Password does not meet the security policy.';
  }
}

/**
 * Validates a password against the configured policy.
 *
 * @example
 * ```ts
 * @IsStrongPassword()
 * password: string;
 * ```
 */
export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsStrongPasswordConstraint,
    });
  };
}
