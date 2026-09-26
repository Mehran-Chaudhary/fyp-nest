import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { BUILTIN_TOOLS, type BuiltinTool } from './builtins/builtin-tool';
import { CalculatorTool } from './builtins/calculator.tool';
import { CurrentDateTimeTool } from './builtins/current-datetime.tool';
import { KnowledgeSearchTool } from './builtins/knowledge-search.tool';
import { SendEmailTool } from './builtins/send-email.tool';
import { ToolExecution } from './entities/tool-execution.entity';
import { Tool } from './entities/tool.entity';
import { HttpToolRunner } from './http/http-tool.runner';
import { ToolExecutorService } from './tool-executor.service';
import { ToolRegistryService } from './tool-registry.service';
import { ToolsController } from './tools.controller';

/**
 * The Tool Execution Engine (proposal module 6.11).
 *
 * `ToolExecutorService` is exported: the agent runtime's reason → act loop and
 * the workflow engine's tool nodes both run tools through it, and so through
 * the same authorisation, information-flow and ledger path.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Tool, ToolExecution]),
    KnowledgeModule,
    PrivacyModule,
  ],
  controllers: [ToolsController],
  providers: [
    CalculatorTool,
    CurrentDateTimeTool,
    KnowledgeSearchTool,
    SendEmailTool,
    {
      provide: BUILTIN_TOOLS,
      inject: [CalculatorTool, CurrentDateTimeTool, KnowledgeSearchTool, SendEmailTool],
      useFactory: (...tools: BuiltinTool[]): BuiltinTool[] => tools,
    },
    HttpToolRunner,
    ToolRegistryService,
    ToolExecutorService,
  ],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class ToolsModule {}
