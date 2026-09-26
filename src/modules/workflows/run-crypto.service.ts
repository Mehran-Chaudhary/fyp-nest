import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { SECURITY_CONFIG_KEY, type SecurityConfig } from '../../config/security.config';
import {
  ContentEncryptionService,
  type DataKey,
} from '../../shared/crypto/content-encryption.service';

/** Where a sealed value belongs; bound into the ciphertext as associated data. */
export const RunAad = {
  runInput: (runId: string) => `workflow-run:${runId}:input`,
  runOutput: (runId: string) => `workflow-run:${runId}:output`,
  stepInput: (runId: string, stepId: string) =>
    `workflow-run:${runId}:step:${stepId}:input`,
  stepOutput: (runId: string, stepId: string) =>
    `workflow-run:${runId}:step:${stepId}:output`,
  approvalComment: (runId: string, stepId: string) =>
    `workflow-run:${runId}:step:${stepId}:approval-comment`,
} as const;

const keyBinding = (runId: string) => `workflow-run:${runId}`;

/**
 * Envelope encryption for workflow runs: the "encrypted inter-agent payloads"
 * of the proposal (module 6.9).
 *
 * Each run has a random data key, stored only wrapped by the master key.
 * Every inter-agent message — a step's input and output — is sealed under it
 * with AES-256-GCM and bound to its exact location, so ciphertext copied into
 * another step or another run does not decrypt. Destroying the wrapped key
 * (run deletion) makes all of it, and every backup of it, unreadable.
 */
@Injectable()
export class RunCryptoService {
  private readonly fingerprintKey: Buffer;

  constructor(
    private readonly content: ContentEncryptionService,
    configService: ConfigService,
  ) {
    const security = configService.getOrThrow<SecurityConfig>(SECURITY_CONFIG_KEY);
    this.fingerprintKey = Buffer.from(
      hkdfSync(
        'sha256',
        security.encryptionKey,
        'daiap-workflow-fingerprint',
        'daiap/workflow-dlq-fingerprint/v1',
        32,
      ),
    );
  }

  createKey(runId: string): DataKey {
    return this.content.generateDataKey(keyBinding(runId));
  }

  unwrap(runId: string, wrapped: string): Buffer {
    return this.content.unwrapDataKey(wrapped, keyBinding(runId));
  }

  destroy(key: Buffer): void {
    this.content.destroy(key);
  }

  seal(key: Buffer, value: unknown, aad: string): { ciphertext: string; bytes: number } {
    const json = JSON.stringify(value ?? null);
    return {
      ciphertext: this.content.encryptText(key, json, aad),
      bytes: Buffer.byteLength(json, 'utf8'),
    };
  }

  open<T = unknown>(key: Buffer, ciphertext: string, aad: string): T {
    return JSON.parse(this.content.decryptText(key, ciphertext, aad)) as T;
  }

  /**
   * A keyed fingerprint of a step's input, for the dead-letter queue: equal
   * inputs have equal fingerprints, and nothing about the input can be
   * learned from one.
   */
  fingerprint(value: unknown): string {
    return createHmac('sha256', this.fingerprintKey)
      .update(JSON.stringify(value ?? null))
      .digest('hex');
  }

  /** Unkeyed digest of a definition, for audit records. */
  static digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
