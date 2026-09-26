import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { Role } from '../rbac/entities/role.entity';
import { ToolsModule } from '../tools/tools.module';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { AgentVersion } from './entities/agent-version.entity';
import { Agent } from './entities/agent.entity';
import { ConversationMessage } from './entities/conversation-message.entity';
import { Conversation } from './entities/conversation.entity';
import { AgentTaskService } from './agent-task.service';
import { ToolLoopService } from './tool-loop.service';

/**
 * Agents, conversations and the turn runtime (proposal modules 6.8 and 6.10),
 * built on the knowledge layer (retrieval), the PII engine, the LLM gateway
 * and — since phase 4 — the Tool Execution Engine.
 *
 * `AgentTaskService` is exported for the workflow engine: an agent node runs
 * through the same retrieval, masking, tool loop and labelling as a turn.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Agent,
      AgentVersion,
      Conversation,
      ConversationMessage,
      Role,
    ]),
    KnowledgeModule,
    PrivacyModule,
    LlmModule,
    ToolsModule,
  ],
  controllers: [AgentsController, ConversationsController],
  providers: [
    AgentsService,
    ConversationsService,
    ToolLoopService,
    AgentRuntimeService,
    AgentTaskService,
  ],
  exports: [AgentsService, ConversationsService, AgentRuntimeService, AgentTaskService],
})
export class AgentsModule {}
