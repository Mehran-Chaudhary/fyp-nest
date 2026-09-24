import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { NER_DETECTOR, type NerDetector } from '../../privacy/detection/ner-detector';

/**
 * Probes for the phase 3 dependencies: the model endpoint and the NER detector.
 *
 * Like the knowledge-layer probes, both report **degraded**, never **down**:
 * sign-in, documents and retrieval all work without a model, and taking the
 * API out of rotation because a GPU host is restarting would turn a partial
 * outage into a total one.
 */
@Injectable()
export class InferenceDependenciesHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly gateway: LlmGatewayService,
    @Inject(NER_DETECTOR) private readonly ner: NerDetector,
  ) {}

  llm(key: string): Promise<HealthIndicatorResult> {
    return this.probe(key, this.gateway.isConfigured, () => this.gateway.ping(), {
      provider: this.gateway.providerKind,
      circuit: this.gateway.circuit.state,
      ...this.gateway.load,
    });
  }

  piiDetector(key: string): Promise<HealthIndicatorResult> {
    return this.probe(key, this.ner.isConfigured, () => this.ner.ping(), {
      kind: this.ner.kind,
      ...(this.ner.circuitState ? { circuit: this.ner.circuitState } : {}),
    });
  }

  private async probe(
    key: string,
    configured: boolean,
    check: () => Promise<boolean>,
    extra: Record<string, unknown>,
  ): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    if (!configured) return indicator.degraded({ configured: false, ...extra });

    const startedAt = Date.now();
    try {
      const healthy = await Promise.race([
        check(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      const responseTimeMs = Date.now() - startedAt;
      return healthy
        ? indicator.up({ configured: true, responseTimeMs, ...extra })
        : indicator.degraded({ configured: true, responseTimeMs, ...extra });
    } catch (error) {
      return indicator.degraded({
        configured: true,
        message: (error as Error).message,
        responseTimeMs: Date.now() - startedAt,
        ...extra,
      });
    }
  }
}
