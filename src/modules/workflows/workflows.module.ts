import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentsModule } from '../agents/agents.module';
import { Agent } from '../agents/entities/agent.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { ToolsModule } from '../tools/tools.module';
import { CompiledGraphsService } from './engine/compiled-graphs.service';
import { StepExecutorService } from './engine/step-executor.service';
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { WorkflowJobsService } from './engine/workflow-jobs.service';
import { WorkflowMaintenanceService } from './engine/workflow-maintenance.service';
import { WorkflowWorkersService } from './engine/workflow-workers.service';
import { Workflow } from './entities/workflow.entity';
import { WorkflowRun } from './entities/workflow-run.entity';
import { WorkflowStep } from './entities/workflow-step.entity';
import { WorkflowVersion } from './entities/workflow-version.entity';
import { RunCryptoService } from './run-crypto.service';
import { RunPrincipalService } from './run-principal.service';
import { WorkflowRunsController } from './workflow-runs.controller';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * The multi-agent workflow engine (proposal module 6.9) and the backend of the
 * workflow canvas (6.13): definitions, runs, the step engine on BullMQ, and
 * the reconciliation sweep.
 *
 * Every agent step runs through `AgentTaskService` and every tool call through
 * `ToolExecutorService`, so a workflow inherits — rather than re-implements —
 * delegation, masking, information-flow checks and the ledgers.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, Agent]),
    AgentsModule,
    ToolsModule,
    KnowledgeModule,
    PrivacyModule,
    LlmModule,
  ],
  controllers: [WorkflowsController, WorkflowRunsController],
  providers: [
    RunCryptoService,
    RunPrincipalService,
    CompiledGraphsService,
    WorkflowJobsService,
    StepExecutorService,
    WorkflowEngineService,
    WorkflowMaintenanceService,
    WorkflowWorkersService,
    WorkflowsService,
    WorkflowRunsService,
  ],
  exports: [
    WorkflowRunsService,
    WorkflowEngineService,
    WorkflowMaintenanceService,
    // Phase 5: a person's export decrypts the inputs and outputs of their own runs.
    RunCryptoService,
  ],
})
export class WorkflowsModule {}
