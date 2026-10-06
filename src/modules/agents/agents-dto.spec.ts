import 'reflect-metadata';
import { AppException } from '../../common/exceptions/app.exception';
import { createValidationPipe } from '../../common/validation/validation-pipe';
import { UpdateLlmPolicyDto } from '../llm/dto/llm.dto';
import { CreateAgentDto, RestoreVersionDto, UpdateAgentDto } from './dto/agent.dto';
import { SendMessageDto, UpdateConversationDto } from './dto/conversation.dto';

async function validate(metatype: new () => object, body: unknown): Promise<unknown> {
  return createValidationPipe().transform(body, { type: 'body', metatype });
}

async function fieldsFor(
  metatype: new () => object,
  body: unknown,
): Promise<string[]> {
  try {
    await validate(metatype, body);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const fields = ((error as AppException).details as { fields: Record<string, string[]> })
      .fields;
    return Object.keys(fields).sort();
  }
  throw new Error('expected a validation failure');
}

describe('agent, conversation and model-policy bodies and null', () => {
  it('refuses null for agent fields that cannot be cleared', async () => {
    // name and accessMode reached the database (NOT NULL); allowedRoleIds: null
    // reached the role lookup and answered 500.
    expect(
      await fieldsFor(UpdateAgentDto, {
        name: null,
        accessMode: null,
        allowedRoleIds: null,
        instructions: null,
        grounding: null,
        citations: null,
        persona: null,
        parameters: null,
        retrieval: null,
        memory: null,
        tools: null,
        changeNote: null,
        expectedVersion: null,
      }),
    ).toEqual([
      'accessMode',
      'allowedRoleIds',
      'changeNote',
      'citations',
      'expectedVersion',
      'grounding',
      'instructions',
      'memory',
      'name',
      'parameters',
      'persona',
      'retrieval',
      'tools',
    ]);
  });

  it('refuses null inside configuration sections', async () => {
    // These were stored as null: a null tone reached the system prompt, a null
    // maxMessages silently disabled memory, a null topK reached retrieval.
    const fields = await fieldsFor(CreateAgentDto, {
      name: 'Agent',
      persona: { tone: null },
      parameters: { temperature: null, maxOutputTokens: null },
      retrieval: {
        enabled: null,
        knowledgeBaseIds: null,
        topK: null,
        mode: null,
        rerank: null,
        maxContextTokens: null,
      },
      memory: { maxMessages: null, maxHistoryTokens: null },
      tools: { toolIds: null, maxIterations: null },
    });
    expect(fields).toEqual(
      [
        'memory.maxHistoryTokens',
        'memory.maxMessages',
        'parameters.maxOutputTokens',
        'parameters.temperature',
        'persona.tone',
        'retrieval.enabled',
        'retrieval.knowledgeBaseIds',
        'retrieval.maxContextTokens',
        'retrieval.mode',
        'retrieval.rerank',
        'retrieval.topK',
        'tools.maxIterations',
        'tools.toolIds',
      ].sort(),
    );
  });

  it('accepts null where it means "clear", "inherit" or "the default"', async () => {
    await expect(
      validate(UpdateAgentDto, {
        description: null,
        model: null,
        contextWindow: null,
        persona: { role: null, language: null, greeting: null },
        retrieval: { minScore: null, maxClassification: null },
      }),
    ).resolves.toBeInstanceOf(UpdateAgentDto);
    await expect(
      validate(UpdateLlmPolicyDto, {
        defaultModel: null,
        maxOutputTokens: null,
        maxContextTokens: null,
      }),
    ).resolves.toBeInstanceOf(UpdateLlmPolicyDto);
  });

  it('refuses null for restore, conversation and policy fields', async () => {
    expect(await fieldsFor(RestoreVersionDto, { changeNote: null, expectedVersion: null })).toEqual([
      'changeNote',
      'expectedVersion',
    ]);
    // title: null reached the encryption of the title and answered 500.
    expect(await fieldsFor(UpdateConversationDto, { title: null, status: null })).toEqual([
      'status',
      'title',
    ]);
    expect(
      await fieldsFor(SendMessageDto, {
        content: 'hello',
        clientMessageId: null,
        parameters: { temperature: null },
        retrieval: { enabled: null },
      }),
    ).toEqual(['clientMessageId', 'parameters.temperature', 'retrieval.enabled']);
    expect(
      await fieldsFor(UpdateLlmPolicyDto, { allowedModels: null, expectedVersion: null }),
    ).toEqual(['allowedModels', 'expectedVersion']);
  });
});
