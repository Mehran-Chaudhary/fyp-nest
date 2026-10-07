import 'reflect-metadata';
import { AppException } from '../../common/exceptions/app.exception';
import { createValidationPipe } from '../../common/validation/validation-pipe';
import { ExportAuditLogsQueryDto } from '../audit/dto/audit.dto';
import { EraseAccountDto } from '../lifecycle/personal-data.controller';
import { CreateQuotaDto, UpdateQuotaDto } from '../quotas/dto/quota.dto';
import { builtinToolId } from '../tools/domain/tool-definition';
import {
  CreateToolDto,
  ListToolExecutionsQueryDto,
  UpdateToolDto,
} from '../tools/dto/tool.dto';
import {
  ApprovalDecisionDto,
  CreateWorkflowDto,
  ListRunsQueryDto,
  PublishWorkflowDto,
  RestoreWorkflowVersionDto,
  SaveDefinitionDto,
  StartRunDto,
  UpdateWorkflowDto,
} from './dto/workflow.dto';

type Metatype = new () => object;

function validate(metatype: Metatype, value: unknown, type: 'body' | 'query' = 'body') {
  return createValidationPipe().transform(value, { type, metatype });
}

async function fieldsFor(
  metatype: Metatype,
  value: unknown,
  type: 'body' | 'query' = 'body',
): Promise<string[]> {
  try {
    await validate(metatype, value, type);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const fields = ((error as AppException).details as { fields: Record<string, string[]> })
      .fields;
    return Object.keys(fields).sort();
  }
  throw new Error('expected a validation failure');
}

const parameters = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
};
const http = {
  method: 'GET',
  url: 'https://api.example.com/search',
  auth: { type: 'none' },
};
const tool = {
  name: 'lookup_order',
  displayName: 'Lookup order',
  description: 'Looks an order up by its number.',
  parameters,
  http,
};

describe('Phase 5 request bodies: required fields and null', () => {
  it('requires the fields a tool cannot be created without', async () => {
    // Each of these reached the registry: a missing http or parameters answered
    // 500 (the service dereferenced them), a missing displayName or description
    // a 422 naming no field (the database's NOT NULL).
    expect(await fieldsFor(CreateToolDto, { name: 'lookup_order' })).toEqual([
      'description',
      'displayName',
      'http',
      'parameters',
    ]);
    await expect(validate(CreateToolDto, tool)).resolves.toBeDefined();
  });

  it('refuses null for tool fields that cannot be cleared', async () => {
    expect(
      await fieldsFor(CreateToolDto, {
        ...tool,
        displayName: null,
        description: null,
        parameters: null,
        http: null,
        dataPolicy: null,
        requiresApproval: null,
        timeoutMs: null,
        enabled: null,
        secret: null,
      }),
    ).toEqual([
      'dataPolicy',
      'description',
      'displayName',
      'enabled',
      'http',
      'parameters',
      'requiresApproval',
      'secret',
      'timeoutMs',
    ]);
    // timeoutMs: null silently reset the timeout; expectedVersion: null answered 409.
    expect(
      await fieldsFor(UpdateToolDto, {
        displayName: null,
        description: null,
        parameters: null,
        http: null,
        dataPolicy: null,
        requiresApproval: null,
        timeoutMs: null,
        enabled: null,
        expectedVersion: null,
      }),
    ).toEqual([
      'dataPolicy',
      'description',
      'displayName',
      'enabled',
      'expectedVersion',
      'http',
      'parameters',
      'requiresApproval',
      'timeoutMs',
    ]);
    expect(
      await fieldsFor(UpdateToolDto, {
        http: {
          ...http,
          query: null,
          headers: null,
          body: null,
          responsePath: null,
          auth: { type: 'header', headerName: null },
        },
        dataPolicy: { maxClassification: null, sideEffects: null },
      }),
    ).toEqual([
      'dataPolicy.maxClassification',
      'dataPolicy.sideEffects',
      'http.auth.headerName',
      'http.body',
      'http.headers',
      'http.query',
      'http.responsePath',
    ]);
  });

  it('still lets null remove a tool credential', async () => {
    await expect(validate(UpdateToolDto, { secret: null })).resolves.toEqual(
      expect.objectContaining({ secret: null }),
    );
  });

  it('checks the tool ledger filters are ids, accepting built-in tool ids', async () => {
    // A malformed id reached PostgreSQL's uuid cast: 500.
    expect(
      await fieldsFor(ListToolExecutionsQueryDto, { toolId: 'abc', runId: 'x' }, 'query'),
    ).toEqual(['runId', 'toolId']);
    await expect(
      validate(
        ListToolExecutionsQueryDto,
        {
          toolId: builtinToolId('calculator'),
          runId: '0b6f1f0e-8f3a-4b6e-9a51-6c2d1c7e9a10',
        },
        'query',
      ),
    ).resolves.toBeDefined();
  });

  it('refuses null for workflow fields that cannot be cleared', async () => {
    // settings: { runTimeoutMs: null } was stored as 0, so every run of the
    // workflow timed out at once; maxSteps: null was stored as 0.
    expect(
      await fieldsFor(CreateWorkflowDto, {
        name: 'Pipeline',
        graph: null,
        settings: { maxSteps: null, maxTokens: null, runTimeoutMs: null },
      }),
    ).toEqual([
      'graph',
      'settings.maxSteps',
      'settings.maxTokens',
      'settings.runTimeoutMs',
    ]);
    expect(
      await fieldsFor(SaveDefinitionDto, {
        graph: { schemaVersion: 1, nodes: [], edges: [] },
        settings: null,
        changeNote: null,
        expectedVersion: null,
      }),
    ).toEqual(['changeNote', 'expectedVersion', 'settings']);
    expect(await fieldsFor(UpdateWorkflowDto, { name: null })).toEqual(['name']);
    // version: null reached a database lookup that refuses null: 500.
    expect(
      await fieldsFor(StartRunDto, {
        input: { input: 'x' },
        version: null,
        idempotencyKey: null,
      }),
    ).toEqual(['idempotencyKey', 'version']);
    expect(await fieldsFor(PublishWorkflowDto, { version: null })).toEqual(['version']);
    expect(await fieldsFor(RestoreWorkflowVersionDto, { changeNote: null })).toEqual([
      'changeNote',
    ]);
    expect(
      await fieldsFor(ApprovalDecisionDto, { decision: 'approve', comment: null }),
    ).toEqual(['comment']);
  });

  it('keeps null where it clears a workflow description', async () => {
    await expect(validate(UpdateWorkflowDto, { description: null })).resolves.toEqual(
      expect.objectContaining({ description: null }),
    );
    await expect(validate(CreateWorkflowDto, { name: 'Pipeline' })).resolves.toBeDefined();
  });

  it('checks the run list workflow filter is an id', async () => {
    // It was ignored when malformed, so the list came back unfiltered.
    expect(await fieldsFor(ListRunsQueryDto, { workflowId: 'abc' }, 'query')).toEqual([
      'workflowId',
    ]);
  });

  it('refuses null for quota fields that cannot be cleared, but not for the label', async () => {
    expect(
      await fieldsFor(UpdateQuotaDto, {
        tokenLimit: null,
        enforcement: null,
        alertThreshold: null,
      }),
    ).toEqual(['alertThreshold', 'enforcement', 'tokenLimit']);
    await expect(validate(UpdateQuotaDto, { label: null })).resolves.toEqual(
      expect.objectContaining({ label: null }),
    );
    expect(
      await fieldsFor(CreateQuotaDto, {
        scope: 'ORGANIZATION',
        period: 'DAY',
        tokenLimit: 1000,
        enforcement: null,
        alertThreshold: null,
      }),
    ).toEqual(['alertThreshold', 'enforcement']);
  });

  it('validates the audit export window before the stream opens', async () => {
    // An unparseable date reached PostgreSQL inside the stream, which answered
    // a bare 400 carrying the driver's message.
    expect(await fieldsFor(ExportAuditLogsQueryDto, { from: 'garbage' }, 'query')).toEqual([
      'from',
    ]);
    const window = (await validate(
      ExportAuditLogsQueryDto,
      { from: '2026-10-01T00:00:00Z', to: '2026-10-07T00:00:00Z' },
      'query',
    )) as ExportAuditLogsQueryDto;
    expect(window.from).toBeInstanceOf(Date);
    expect(window.to?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('refuses null second factors on account erasure', async () => {
    expect(
      await fieldsFor(EraseAccountDto, {
        password: 'secret',
        confirmation: 'ERASE MY ACCOUNT',
        code: null,
        recoveryCode: null,
      }),
    ).toEqual(['code', 'recoveryCode']);
  });
});
