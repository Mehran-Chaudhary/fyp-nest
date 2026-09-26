import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { TOOLS_CONFIG_KEY, type ToolsConfig } from '../../../config/tools.config';
import {
  WORKFLOWS_CONFIG_KEY,
  type WorkflowsConfig,
} from '../../../config/workflows.config';
import {
  validateGraph,
  type CompiledGraph,
  type GraphLimits,
} from '../domain/graph-validation';
import { WorkflowVersion } from '../entities/workflow-version.entity';

const CACHE_SIZE = 200;

/**
 * Compiled workflow graphs, by version.
 *
 * Versions are immutable (a trigger forbids UPDATE), so a compiled graph can
 * be cached for as long as the process lives — every step of every run needs
 * one, and compiling means validating the whole definition again.
 */
@Injectable()
export class CompiledGraphsService {
  private readonly cache = new Map<string, CompiledGraph>();
  readonly limits: GraphLimits;

  constructor(
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    configService: ConfigService,
  ) {
    const workflows = configService.getOrThrow<WorkflowsConfig>(WORKFLOWS_CONFIG_KEY);
    const tools = configService.getOrThrow<ToolsConfig>(TOOLS_CONFIG_KEY);
    this.limits = {
      maxNodes: workflows.maxNodes,
      maxEdges: workflows.maxEdges,
      maxLoopIterations: workflows.maxLoopIterations,
      maxSupervisorRounds: workflows.maxSupervisorRounds,
      maxSteps: workflows.maxSteps,
      maxToolIterations: tools.maxIterations,
      maxStepTimeoutMs: workflows.stepTimeoutMs,
      maxStepAttempts: Math.max(workflows.stepMaxAttempts, 10),
    };
  }

  async get(
    organizationId: string,
    workflowId: string,
    version: number,
  ): Promise<CompiledGraph> {
    const key = `${workflowId}:${version}`;
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const row = await this.versions.findOne({
      where: { workflowId, version, organizationId },
    });
    if (!row)
      throw new AppException(ErrorCode.WORKFLOW_VERSION_NOT_FOUND, HttpStatus.NOT_FOUND);

    // Validated again under today's limits: a ceiling lowered since the version
    // was saved applies to it too.
    const report = validateGraph(row.graph, this.limits);
    if (!report.valid || !report.compiled) {
      throw new AppException(ErrorCode.WORKFLOW_INVALID, HttpStatus.UNPROCESSABLE_ENTITY, {
        details: { errors: report.errors.slice(0, 20) },
      });
    }

    this.cache.set(key, report.compiled);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return report.compiled;
  }
}
