import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { Role } from '../rbac/entities/role.entity';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { AgentVersion } from './entities/agent-version.entity';
import { Agent } from './entities/agent.entity';
import { ConversationMessage } from './entities/conversation-message.entity';
import { Conversation } from './entities/conversation.entity';

/**
 * Agents, conversations and the turn runtime (proposal modules 6.8 and 6.10),
 * built on the knowledge layer (retrieval), the PII engine and the LLM gateway.
 *
 * `AgentRuntimeService` is exported for phase 4: a workflow step runs an agent
 * turn through exactly this code, with the same delegation, masking and
 * labelling guarantees.
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
  ],
  controllers: [AgentsController, ConversationsController],
  providers: [AgentsService, ConversationsService, AgentRuntimeService],
  exports: [AgentsService, ConversationsService, AgentRuntimeService],
})
export class AgentsModule {}
