import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { AppException } from '../../../common/exceptions/app.exception';
import { LLM_CONFIG_KEY, type LlmConfig } from '../../../config/llm.config';
import { joinLabels } from '../../agents/domain/labels';
import { dominates } from '../../knowledge/domain/classification';
import { KnowledgeReadinessService } from '../../knowledge/knowledge-readiness.service';
import { RetrievalService } from '../../knowledge/retrieval/retrieval.service';
import { defaultDataPolicy, Integrity } from '../domain/information-flow';
import { escapeToolText } from '../domain/tool-call-protocol';
import {
  ToolRuntimeError,
  type BuiltinTool,
  type BuiltinToolContext,
  type BuiltinToolDefinition,
  type ToolOutput,
} from './builtin-tool';

/**
 * Agentic retrieval: the model decides *when* to search and *what for*, which
 * lets it answer questions that need several lookups ("compare the leave
 * policy with last year's").
 *
 * It searches through `RetrievalService` exactly as an agent turn does — as
 * the delegating user, narrowed to the agent's knowledge bases and to the
 * lower of the agent's and the model endpoint's classification ceilings. It
 * can therefore never return anything the user could not retrieve directly,
 * nor anything above what the model may be shown. The passages are labelled,
 * so whatever the agent says afterwards carries their sensitivity.
 */
@Injectable()
export class KnowledgeSearchTool implements BuiltinTool {
  private readonly llmConfig: LlmConfig;

  readonly definition: BuiltinToolDefinition = {
    name: 'knowledge_search',
    displayName: 'Knowledge search',
    description:
      'Searches the organisation’s knowledge bases you have access to and returns the most ' +
      'relevant passages with their document titles. Use a focused query; search again with ' +
      'different words if the first results do not answer the question.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          maxLength: 1000,
          description: 'What to search for, in natural language.',
        },
        topK: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 5,
          description: 'How many passages to return.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    dataPolicy: defaultDataPolicy({ external: false, sideEffects: false }),
    resultIntegrity: Integrity.INTERNAL,
    requiresApproval: false,
    requiredPermissions: ['rag:query'],
    timeoutMs: 30_000,
  };

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly readiness: KnowledgeReadinessService,
    configService: ConfigService,
  ) {
    this.llmConfig = configService.getOrThrow<LlmConfig>(LLM_CONFIG_KEY);
  }

  isAvailable(): boolean {
    return this.readiness.missing('retrieval').length === 0;
  }

  async execute(
    args: Record<string, unknown>,
    context: BuiltinToolContext,
  ): Promise<ToolOutput> {
    const endpointCeiling = this.llmConfig.maxClassification;
    const ceiling = context.agent ? context.agent.maxClassification : endpointCeiling;
    const bases = context.agent ? [...context.agent.knowledgeBaseIds] : undefined;

    if (bases && bases.length === 0) {
      throw new ToolRuntimeError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        'No knowledge bases are attached to this agent, so there is nothing to search.',
      );
    }

    let response;
    try {
      response = await this.retrieval.retrieve(context.principal, {
        query: String(args.query).replace(/\s+/g, ' ').trim(),
        topK: typeof args.topK === 'number' ? args.topK : 5,
        restrictToKnowledgeBaseIds: bases,
        maxClassification: dominates(ceiling, endpointCeiling) ? endpointCeiling : ceiling,
        origin: {
          tool: 'knowledge_search',
          ...(context.agent
            ? { agentId: context.agent.id, agentVersion: context.agent.version }
            : {}),
          ...(context.origin.conversationId
            ? { conversationId: context.origin.conversationId }
            : {}),
          ...(context.origin.runId ? { workflowRunId: context.origin.runId } : {}),
          ...(context.origin.stepId ? { workflowStepId: context.origin.stepId } : {}),
        },
      });
    } catch (error) {
      if (error instanceof AppException) {
        const status = error.getStatus();
        throw new ToolRuntimeError(
          error.code,
          status === 503 || status === 502
            ? 'Search is temporarily unavailable.'
            : 'The search could not be run.',
          { retryable: status === 503 || status === 502 },
        );
      }
      throw error;
    }

    const passages = response.results;
    if (passages.length === 0) {
      return {
        content:
          'No passages matched. Try different words, or tell the user nothing was found.',
        data: { passages: [] },
        metadata: { passages: 0, retrievalId: response.retrievalId },
      };
    }

    const content = passages
      .map(
        (passage, index) =>
          `[${index + 1}] "${escapeToolText(passage.documentTitle).replace(/"/g, "'")}" ` +
          `(${passage.classification})\n${escapeToolText(passage.text)}`,
      )
      .join('\n\n');

    return {
      content,
      data: {
        passages: passages.map((passage) => ({
          documentId: passage.documentId,
          documentTitle: passage.documentTitle,
          knowledgeBaseId: passage.knowledgeBaseId,
          classification: passage.classification,
          score: passage.score,
          text: passage.text,
        })),
      },
      label: joinLabels(
        ...passages.map((passage) => ({
          classification: passage.classification,
          knowledgeBaseIds: [passage.knowledgeBaseId],
          documentIds: [passage.documentId],
        })),
      ),
      metadata: {
        passages: passages.length,
        documents: new Set(passages.map((passage) => passage.documentId)).size,
        retrievalId: response.retrievalId,
      },
    };
  }
}
