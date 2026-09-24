// Must stay first: configures the gateway and disables queue workers before
// configuration is read.
import '../../testing/agents-e2e.env';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { AiServiceClient } from '../../shared/ai-service/ai-service.client';
import { RequestContextService } from '../../shared/context/request-context.service';
import { ObjectStorageService } from '../../shared/storage/object-storage.service';
import { VectorStoreService } from '../../shared/vector-store/vector-store.service';
import {
  FakeAiService,
  FakeOllama,
  ingestionJob,
  MemoryObjectStorage,
  MemoryVectorStore,
  RecordingJobs,
} from '../../testing/cloud-stand-ins';
import { AuditService } from '../audit/audit.service';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { Classification } from '../knowledge/domain/classification';
import { DocumentsService } from '../knowledge/documents/documents.service';
import { IngestionPipeline } from '../knowledge/ingestion/ingestion.pipeline';
import { KnowledgeJobsService } from '../knowledge/ingestion/knowledge-jobs.service';
import { DirectChatService } from '../llm/direct-chat.service';
import { LLM_FETCH } from '../llm/providers/provider.types';
import { UsageService } from '../llm/usage.service';
import { PiiPolicyService } from '../privacy/pii-policy.service';
import { PrivacyService } from '../privacy/privacy.service';
import { RedactionService } from '../privacy/redaction.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentsService } from './agents.service';
import { ConversationsService } from './conversations.service';
import { ListConversationsQueryDto, ListMessagesQueryDto } from './dto/conversation.dto';
import { ListAgentsQueryDto } from './dto/agent.dto';
import { MessageRole, MessageStatus } from './entities/conversation-message.entity';

/**
 * End-to-end verification of phase 3 against real PostgreSQL.
 *
 * The real application module graph — agents, conversations, the PII engine,
 * the LLM gateway and its Ollama provider, retrieval, encryption, the audit
 * chain — with only the cloud endpoints replaced by stand-ins. The model is a
 * scripted Ollama installed as the gateway's HTTP transport: it records every
 * request, which is exactly what left the platform. That is where the
 * implementation plan's exit criterion is checked: the prompt captured at the
 * gateway boundary contains none of the names, salaries or card numbers.
 *
 * Run against a DISPOSABLE database, migrated and seeded with demo data:
 *
 *   DB_HOST=… DB_NAME=… npm run migration:run
 *   DB_HOST=… DB_NAME=… SEED_DEMO_DATA=true npm run seed
 *   DB_HOST=… DB_NAME=… AGENTS_E2E=true npm run test:e2e:agents
 */

const SENSITIVE = [
  'Ayesha Raza',
  'Bilal Qureshi',
  '950,000',
  '420,000',
  '4111 1111 1111 1111',
  '4111111111111111',
  '5555 5555 5555 4444',
  'PK36SCBL0000001123456702',
  '35202-1234567-1',
  'ayesha.raza@acme.test',
  '0300-1234567',
];

const PLACEHOLDER_LEFT =
  /\[(PERSON|SALARY|CREDIT_CARD|IBAN_CODE|PK_CNIC|EMAIL_ADDRESS|PHONE_NUMBER)[ _-]?\d+\]/i;

async function main(): Promise<void> {
  if (process.env.AGENTS_E2E !== 'true') {
    console.log(
      'Skipped: set AGENTS_E2E=true and point DB_* at a disposable, seeded database.',
    );
    return;
  }

  const model = new FakeOllama();
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ObjectStorageService)
    .useFactory({
      factory: (config: ConfigService) => new MemoryObjectStorage(config),
      inject: [ConfigService],
    })
    .overrideProvider(VectorStoreService)
    .useFactory({
      factory: (config: ConfigService) => new MemoryVectorStore(config),
      inject: [ConfigService],
    })
    .overrideProvider(AiServiceClient)
    .useFactory({
      factory: (config: ConfigService, context: RequestContextService) =>
        new FakeAiService(config, context),
      inject: [ConfigService, RequestContextService],
    })
    .overrideProvider(KnowledgeJobsService)
    .useValue(new RecordingJobs())
    .overrideProvider(LLM_FETCH)
    .useValue(model.fetch)
    .compile();
  await moduleRef.init();

  const dataSource = moduleRef.get(DataSource);
  const ai = moduleRef.get<FakeAiService>(AiServiceClient);
  const documents = moduleRef.get(DocumentsService);
  const pipeline = moduleRef.get(IngestionPipeline);
  const agents = moduleRef.get(AgentsService);
  const conversations = moduleRef.get(ConversationsService);
  const runtime = moduleRef.get(AgentRuntimeService);
  const redaction = moduleRef.get(RedactionService);
  const policies = moduleRef.get(PiiPolicyService);
  const privacy = moduleRef.get(PrivacyService);
  const directChat = moduleRef.get(DirectChatService);
  const usage = moduleRef.get(UsageService);
  const requestContext = moduleRef.get(RequestContextService);

  // ── The demo workspace ──────────────────────────────────────────────────
  const [{ id: organizationId }]: Array<{ id: string }> = await dataSource.query(
    `SELECT id FROM organizations WHERE slug = 'acme-corp'`,
  );
  const principals: Record<string, AccessPrincipal> = {};
  const members: Array<{
    email: string;
    member_id: string;
    user_id: string;
    permissions: string[];
  }> = await dataSource.query(
    `SELECT u.email, m.id AS member_id, u.id AS user_id, m.effective_permissions AS permissions
         FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.deleted_at IS NULL`,
    [organizationId],
  );
  for (const member of members) {
    principals[member.email.split('@')[0]] = {
      organizationId,
      kind: 'user',
      userId: member.user_id,
      membershipId: member.member_id,
      permissions: member.permissions,
    };
  }
  const { owner, admin, hr, employee, auditor } = principals;

  const ids = async (sql: string): Promise<Map<string, string>> => {
    const rows: Array<{ name: string; id: string }> = await dataSource.query(sql, [
      organizationId,
    ]);
    return new Map(rows.map((row) => [row.name, row.id]));
  };
  const bases = await ids(
    `SELECT id, name FROM knowledge_bases WHERE organization_id = $1 AND deleted_at IS NULL`,
  );
  const agentIds = await ids(
    `SELECT id, name FROM agents WHERE organization_id = $1 AND deleted_at IS NULL`,
  );
  const handbook = bases.get('Company Handbook') as string;
  const hrBase = bases.get('HR Policies') as string;
  const hrAgent = agentIds.get('HR Assistant') as string;
  const helpdesk = agentIds.get('Company Helpdesk') as string;
  assert.ok(
    handbook && hrBase && hrAgent && helpdesk,
    'the demo seed (with phase 3) has run',
  );

  const run = <T>(label: string, fn: () => Promise<T>) =>
    requestContext.run(
      {
        requestId: `e2e-${label}-${randomUUID().slice(0, 8)}`,
        startTime: Date.now(),
        ip: '127.0.0.1',
        actorLabel: label,
      },
      fn,
    );
  const step = (message: string) => console.log(`  ✔ ${message}`);
  const suffix = Date.now().toString(36);
  const code = (expected: string) => (error: unknown) => {
    assert.equal((error as { code?: string }).code, expected);
    return true;
  };

  console.log('Phase 3 end-to-end verification');

  // Deterministic starting policy: defaults, fail closed.
  await run('owner', () =>
    policies.update(organizationId, owner.userId, {
      enabled: true,
      onDetectorFailure: 'REFUSE',
      allowList: ['Acme Corporation'],
      denyList: ['Project Falcon'],
    }),
  );
  ai.knownNames = ['Ayesha Raza', 'Bilal Qureshi'];
  ai.nerDown = false;

  // ── 1. A synthetic HR document ──────────────────────────────────────────
  const payrollText = [
    `Payroll register ${suffix}.`,
    'Ayesha Raza, Head of Finance, earns a salary of PKR 950,000 per year. Her corporate card ' +
      'is 4111 1111 1111 1111 and her salary is paid to PK36SCBL0000001123456702. CNIC ' +
      '35202-1234567-1. Email ayesha.raza@acme.test, mobile 0300-1234567.',
    'Bilal Qureshi, Analyst, earns a salary of PKR 420,000 per year. Card 5555 5555 5555 4444.',
  ].join('\n\n');
  const payroll = await run('hr', () =>
    documents.upload(
      hr,
      hrBase,
      {
        originalname: `payroll-${suffix}.txt`,
        mimetype: 'text/plain',
        size: 0,
        buffer: Buffer.from(payrollText),
      },
      { classification: Classification.RESTRICTED },
    ),
  );
  const leave = await run('employee', () =>
    documents.upload(
      employee,
      handbook,
      {
        originalname: `leave-${suffix}.txt`,
        mimetype: 'text/plain',
        size: 0,
        buffer: Buffer.from(
          `Leave policy ${suffix}.\n\nEvery employee receives twenty five days of annual leave.`,
        ),
      },
      {},
    ),
  );
  for (const document of [payroll, leave]) {
    const outcome = await pipeline.process(
      ingestionJob({ organizationId, documentId: document.id, indexVersion: 1 }),
    );
    assert.equal(outcome.outcome, 'ready');
  }
  step('synthetic HR document (names, salaries, cards, IBAN, CNIC, email, phone) ingested');

  // ── 2. A restricted agent is invisible to everyone else ────────────────
  await assert.rejects(
    run('employee', () => agents.resolveForExecution(employee, hrAgent)),
    code('AGENT_NOT_FOUND'),
  );
  const employeeAgents = await run('employee', () =>
    agents.list(employee, Object.assign(new ListAgentsQueryDto(), { limit: 100 })),
  );
  assert.ok(!employeeAgents.items.some((agent) => agent.id === hrAgent));
  assert.ok(employeeAgents.items.some((agent) => agent.id === helpdesk));
  step('HR Assistant (restricted to HR Manager) is 404 and unlisted for an employee');

  // ── 3. The exit criterion: nothing sensitive reaches the model ─────────
  const conversation = await run('hr', () =>
    conversations.create(hr, { agentId: hrAgent }),
  );
  let sent = model.captured.length;
  const first = await run('hr', () =>
    runtime.runTurn(hr, conversation.id, {
      content: `What does Ayesha Raza earn, and which card is on file? (${suffix})`,
      clientMessageId: randomUUID(),
    }),
  );
  assert.equal(model.captured.length, sent + 1, 'exactly one request reached the model');
  const prompt = model.lastPrompt();
  for (const value of SENSITIVE) {
    assert.ok(!prompt.includes(value), `the model must never see "${value}"`);
  }
  for (const placeholder of [
    /\[PERSON_1\]/,
    /\[SALARY_\d+\]/,
    /\[CREDIT_CARD_\d+\]/,
    /\[IBAN_CODE_1\]/,
    /\[PK_CNIC_1\]/,
  ]) {
    assert.match(prompt, placeholder);
  }
  assert.match(prompt, /<source tag="S1"/);
  step('prompt captured at the gateway boundary contains none of the 11 sensitive values');

  const answer = first.assistantMessage.content ?? '';
  assert.ok(
    /Ayesha Raza|Bilal Qureshi/.test(answer),
    'names restored for the authorised user',
  );
  assert.ok(/PKR (950|420),000/.test(answer), 'salary restored');
  assert.ok(
    !PLACEHOLDER_LEFT.test(answer),
    'no placeholder left — including the mangled "[person 1]"',
  );
  assert.equal(first.assistantMessage.classification, Classification.RESTRICTED);
  assert.ok(first.retrieval.passagesProvided >= 1 && first.retrieval.passagesCited >= 1);
  step(
    `answer unmasked for HR: "${answer.slice(0, 70)}…"; labelled RESTRICTED; cites [S1]`,
  );

  const stored: Array<{ content_ciphertext: string }> = await dataSource.query(
    `SELECT content_ciphertext FROM conversation_messages WHERE conversation_id = $1`,
    [conversation.id],
  );
  assert.ok(
    stored.every(
      (row) =>
        !Buffer.from(row.content_ciphertext, 'base64')
          .toString('latin1')
          .includes('Ayesha'),
    ),
  );
  const [invocation]: Array<{
    status: string;
    entities_masked: number;
    redaction_ms: string;
    prompt_tokens: number;
  }> = await dataSource.query(
    `SELECT status, entities_masked, redaction_ms, prompt_tokens FROM llm_invocations
        WHERE id = (SELECT invocation_id FROM conversation_messages WHERE id = $1)`,
    [first.assistantMessage.id],
  );
  assert.equal(invocation.status, 'COMPLETED');
  assert.ok(
    invocation.entities_masked >= 7 &&
      Number(invocation.redaction_ms) > 0 &&
      invocation.prompt_tokens > 0,
  );
  const auditRows: Array<{ action: string; metadata: unknown }> = await dataSource.query(
    `SELECT action, metadata FROM audit_logs WHERE organization_id = $1
        AND action IN ('agent.invoked', 'pii.redacted', 'rag.query.executed')
        AND created_at > now() - interval '5 minutes'`,
    [organizationId],
  );
  assert.ok(auditRows.some((row) => row.action === 'agent.invoked'));
  assert.ok(auditRows.some((row) => row.action === 'pii.redacted'));
  assert.ok(
    !JSON.stringify(auditRows).includes('Ayesha'),
    'no personal data in the audit log',
  );
  step(
    `messages stored as ciphertext; usage ledger: ${invocation.entities_masked} entities, redaction ${invocation.redaction_ms} ms; audit has no PII`,
  );

  // ── 4. Streaming, with memory ───────────────────────────────────────────
  const deltas: string[] = [];
  const stages: string[] = [];
  const second = await run('hr', () =>
    runtime.runTurn(
      hr,
      conversation.id,
      { content: 'And what does Bilal Qureshi earn?' },
      { onStatus: (stage) => stages.push(stage), onDelta: (text) => deltas.push(text) },
    ),
  );
  assert.equal(
    deltas.join(''),
    second.assistantMessage.content,
    'the stream is the stored answer',
  );
  assert.ok(
    deltas.every((delta) => !/\[[A-Za-z_ ]*\d*$/.test(delta)),
    'no delta ends mid-placeholder',
  );
  assert.deepEqual(
    ['retrieving', 'redacting', 'queued', 'generating'].filter((stage) =>
      stages.includes(stage),
    ),
    ['retrieving', 'redacting', 'queued', 'generating'],
  );
  const withHistory = model.captured[model.captured.length - 1];
  assert.equal(
    withHistory.messages.length,
    4,
    'system, previous question, previous answer, new question',
  );
  for (const value of SENSITIVE) assert.ok(!model.lastPrompt().includes(value));
  step(
    `streamed turn: ${deltas.length} deltas, placeholders never split; history re-masked in the prompt`,
  );

  // ── 5. The confused deputy ──────────────────────────────────────────────
  const helpdeskConfig = await run('owner', () => agents.get(owner, helpdesk));
  await run('owner', () =>
    agents.update(owner, helpdesk, {
      retrieval: {
        knowledgeBaseIds: [...helpdeskConfig.config.retrieval.knowledgeBaseIds, hrBase],
      },
      changeNote: 'Also consult HR',
    }),
  );
  const adminView = await run('admin', () => agents.get(admin, helpdesk));
  assert.ok(!adminView.config.retrieval.knowledgeBaseIds.includes(hrBase));
  assert.equal(adminView.config.retrieval.hiddenKnowledgeBases, 1);
  await run('admin', () =>
    agents.update(admin, helpdesk, {
      persona: { tone: 'concise' },
      retrieval: { knowledgeBaseIds: adminView.config.retrieval.knowledgeBaseIds },
    }),
  );
  assert.ok(
    (
      await run('owner', () => agents.get(owner, helpdesk))
    ).config.retrieval.knowledgeBaseIds.includes(hrBase),
  );
  await assert.rejects(
    run('admin', () =>
      agents.update(admin, helpdesk, { retrieval: { knowledgeBaseIds: [hrBase] } }),
    ),
    code('KNOWLEDGE_BASE_NOT_FOUND'),
  );
  step(
    'an editor sees only the bases they can read; hidden ones survive their edits; cannot attach HR',
  );

  const employeeConversation = await run('employee', () =>
    conversations.create(employee, { agentId: helpdesk }),
  );
  const deputy = await run('employee', () =>
    runtime.runTurn(employee, employeeConversation.id, {
      content: `What does Ayesha Raza earn? ${suffix}`,
    }),
  );
  const deputyPrompt = model.lastPrompt();
  assert.ok(
    !deputyPrompt.includes('Payroll register') && !deputyPrompt.includes('[SALARY_'),
  );
  assert.ok(
    deputy.assistantMessage.citations.every(
      (citation) => citation.knowledgeBaseId !== hrBase,
    ),
  );
  assert.notEqual(deputy.assistantMessage.classification, Classification.RESTRICTED);
  step(
    'the Helpdesk now has HR attached, yet an employee using it retrieves nothing from HR',
  );

  // ── 6. Prompt preview and direct chat ───────────────────────────────────
  sent = model.captured.length;
  const preview = await run('hr', () =>
    runtime.preview(hr, hrAgent, {
      content: 'What does Bilal Qureshi earn?',
      conversationId: conversation.id,
    }),
  );
  assert.equal(model.captured.length, sent, 'a preview never calls the model');
  const previewed = preview.messages.map((message) => message.content).join('\n');
  for (const value of SENSITIVE) assert.ok(!previewed.includes(value));
  assert.deepEqual(preview.redaction.egressFindings, []);
  const direct = await run('employee', () =>
    directChat.chat(employee, {
      messages: [
        {
          role: 'user',
          content: 'My card is 4111 1111 1111 1111; mail sara.khan@acme.test.',
        },
      ],
    }),
  );
  assert.ok(
    !model.lastPrompt().includes('4111') && !model.lastPrompt().includes('sara.khan'),
  );
  assert.ok(direct.redaction.entitiesMasked >= 2);
  step(
    'prompt preview is masked and egress-clean without a model call; direct chat is masked too',
  );

  // ── 7. Document redaction report ────────────────────────────────────────
  const report = await run('hr', () =>
    privacy.documentReport(hr, payroll.id, Object.assign({ page: 1, limit: 10 }, {})),
  );
  assert.ok(
    report.entityCount >= 7 &&
      report.chunks.every((chunk) => !chunk.maskedText.includes('Ayesha')),
  );
  assert.ok(
    report.chunks.every((chunk) =>
      chunk.entities.every((entity) => entity.value === undefined),
    ),
  );
  await assert.rejects(
    run('hr', () =>
      privacy.documentReport(hr, payroll.id, { page: 1, limit: 10, reveal: true }),
    ),
    code('PERMISSION_DENIED'),
  );
  const revealed = await run('owner', () =>
    privacy.documentReport(owner, payroll.id, { page: 1, limit: 10, reveal: true }),
  );
  assert.ok(
    revealed.chunks.some((chunk) =>
      chunk.entities.some((entity) => entity.value === 'Ayesha Raza'),
    ),
  );
  step(
    `document report: ${report.entityCount} entities masked; values only with pii:reveal (HR refused, owner allowed)`,
  );

  // ── 8. Supervision ──────────────────────────────────────────────────────
  const listed = await run('auditor', () =>
    conversations.list(
      auditor,
      Object.assign(new ListConversationsQueryDto(), { scope: 'all', limit: 100 }),
    ),
  );
  const supervisedEntry = listed.items.find((item) => item.id === conversation.id);
  assert.ok(supervisedEntry && !supervisedEntry.isOwner);
  assert.ok(
    supervisedEntry.title &&
      !supervisedEntry.title.includes('Ayesha') &&
      supervisedEntry.title.includes('[PERSON_'),
  );
  const supervised = await run('auditor', () =>
    conversations.messages(
      auditor,
      conversation.id,
      Object.assign(new ListMessagesQueryDto(), { limit: 50 }),
    ),
  );
  const [firstQuestion, firstAnswer, secondQuestion] = supervised.messages;
  assert.equal(firstQuestion.contentState, 'MASKED');
  assert.ok(
    firstQuestion.content?.includes('[PERSON_') &&
      !firstQuestion.content.includes('Ayesha'),
  );
  assert.equal(firstAnswer.contentState, 'WITHHELD');
  assert.equal(firstAnswer.withheldReason, 'CLEARANCE');
  assert.equal(
    secondQuestion.contentState,
    'WITHHELD',
    'written after a RESTRICTED answer: high-water mark',
  );
  await assert.rejects(
    run('auditor', () =>
      conversations.messages(
        auditor,
        conversation.id,
        Object.assign(new ListMessagesQueryDto(), { limit: 50, reveal: true }),
      ),
    ),
    code('PERMISSION_DENIED'),
  );
  const ownerMasked = await run('owner', () =>
    conversations.messages(
      owner,
      conversation.id,
      Object.assign(new ListMessagesQueryDto(), { limit: 50 }),
    ),
  );
  assert.ok(
    ownerMasked.masked &&
      ownerMasked.messages.every((message) => !message.content?.includes('Ayesha')),
  );
  const ownerRevealed = await run('owner', () =>
    conversations.messages(
      owner,
      conversation.id,
      Object.assign(new ListMessagesQueryDto(), { limit: 50, reveal: true }),
    ),
  );
  assert.ok(
    ownerRevealed.revealed &&
      ownerRevealed.messages.some((message) => message.content?.includes('Ayesha Raza')),
  );
  const [{ count: unmaskedAudits }]: Array<{ count: number }> = await dataSource.query(
    `SELECT count(*)::int AS count FROM audit_logs
      WHERE organization_id = $1 AND action = 'pii.unmasked' AND resource_id = $2 AND severity = 'CRITICAL'`,
    [organizationId, conversation.id],
  );
  assert.equal(unmaskedAudits, 1);
  step(
    'auditor: question masked, RESTRICTED answers withheld, reveal refused; owner reveal audited CRITICAL',
  );

  // ── 9. Fail closed, then degrade ────────────────────────────────────────
  ai.nerDown = true;
  sent = model.captured.length;
  await assert.rejects(
    run('hr', () =>
      runtime.runTurn(hr, conversation.id, { content: 'Summarise Ayesha Raza’s pay.' }),
    ),
    code('PII_DETECTION_UNAVAILABLE'),
  );
  assert.equal(model.captured.length, sent, 'nothing reached the model');
  const [{ refused }]: Array<{ refused: number }> = await dataSource.query(
    `SELECT count(*)::int AS refused FROM llm_invocations WHERE conversation_id = $1 AND status = 'REFUSED'`,
    [conversation.id],
  );
  assert.equal(refused, 1);
  await run('owner', () =>
    policies.update(organizationId, owner.userId, {
      onDetectorFailure: 'DEGRADE_TO_PATTERNS',
    }),
  );
  const degraded = await run('hr', () =>
    runtime.runTurn(hr, conversation.id, {
      content: 'Which card is on file for the finance head?',
    }),
  );
  assert.equal(degraded.assistantMessage.redaction?.degraded, true);
  for (const value of [
    '4111 1111 1111 1111',
    '5555 5555 5555 4444',
    'PK36SCBL0000001123456702',
  ]) {
    assert.ok(
      !model.lastPrompt().includes(value),
      'validated patterns still mask without NER',
    );
  }
  ai.nerDown = false;
  step(
    'NER down + REFUSE: 503 and nothing sent (REFUSED in ledger); DEGRADE: proceeds, cards still masked',
  );

  // ── 10. The egress guard ────────────────────────────────────────────────
  const originalRedact = redaction.redact.bind(redaction);
  redaction.redact = async (request) => {
    const outcome = await originalRedact(request);
    const question = outcome.segments.find((segment) => segment.id === 'question');
    if (question) question.text += ' (card 4111 1111 1111 1111)'; // a simulated masking bug
    return outcome;
  };
  sent = model.captured.length;
  await assert.rejects(
    run('hr', () =>
      runtime.runTurn(hr, conversation.id, { content: 'Anything else I should know?' }),
    ),
    code('PII_EGRESS_BLOCKED'),
  );
  redaction.redact = originalRedact;
  assert.equal(model.captured.length, sent, 'the gateway sent nothing');
  const [{ blocked }]: Array<{ blocked: number }> = await dataSource.query(
    `SELECT count(*)::int AS blocked FROM audit_logs
      WHERE organization_id = $1 AND action = 'pii.egress.blocked' AND severity = 'CRITICAL'
        AND created_at > now() - interval '5 minutes'`,
    [organizationId],
  );
  assert.ok(blocked >= 1);
  step(
    'a simulated masking bug is caught by the gateway egress check: blocked, audited CRITICAL',
  );

  // ── 11. Versions: append-only, reversible ───────────────────────────────
  const before = await run('owner', () => agents.get(owner, hrAgent));
  const version = before.currentVersion;
  await run('owner', () =>
    agents.update(owner, hrAgent, {
      instructions: `${before.instructions}\nAlways answer in bullet points.`,
      changeNote: 'Formatting',
      expectedVersion: version,
    }),
  );
  await assert.rejects(
    run('owner', () =>
      agents.update(owner, hrAgent, { instructions: 'x', expectedVersion: version }),
    ),
    code('AGENT_VERSION_CONFLICT'),
  );
  const restored = await run('owner', () =>
    agents.restoreVersion(owner, hrAgent, version, {}),
  );
  assert.equal(restored.currentVersion, version + 2);
  assert.equal(restored.instructions, before.instructions);
  const [{ same }]: Array<{ same: boolean }> = await dataSource.query(
    `SELECT (SELECT config_digest FROM agent_versions WHERE agent_id = $1 AND version = $2)
          = (SELECT config_digest FROM agent_versions WHERE agent_id = $1 AND version = $3) AS same`,
    [hrAgent, version, version + 2],
  );
  assert.equal(same, true);
  await assert.rejects(
    dataSource.query(
      `UPDATE agent_versions SET change_note = 'tampered' WHERE agent_id = $1`,
      [hrAgent],
    ),
    /append-only/,
  );
  const [{ versions }]: Array<{ versions: number[] }> = await dataSource.query(
    `SELECT array_agg(DISTINCT agent_version) AS versions FROM conversation_messages WHERE conversation_id = $1`,
    [conversation.id],
  );
  assert.ok(
    versions.includes(version),
    'every message records the version that produced it',
  );
  step(
    `versions: v${version} → v${version + 1} → restore → v${version + 2} (same digest); UPDATE blocked by trigger`,
  );

  // ── 12. Deleting the source withdraws the answers built on it ───────────
  await run('hr', () => documents.remove(hr, payroll.id));
  const afterDelete = await run('hr', () =>
    conversations.messages(
      hr,
      conversation.id,
      Object.assign(new ListMessagesQueryDto(), { limit: 50 }),
    ),
  );
  const answers = afterDelete.messages.filter(
    (message) =>
      message.role === MessageRole.ASSISTANT && message.status === MessageStatus.COMPLETE,
  );
  assert.ok(
    answers.length >= 2 &&
      answers.every((message) => message.withheldReason === 'SOURCE_DELETED'),
  );
  assert.ok(
    afterDelete.messages
      .filter((message) => message.role === MessageRole.USER)
      .every((message) => message.contentState === 'VISIBLE'),
  );
  step(
    'deleting the payroll document withdraws every answer derived from it, even from its owner',
  );

  // ── 13. The benchmark numbers ───────────────────────────────────────────
  const summary = await usage.summary(
    organizationId,
    new Date(Date.now() - 3_600_000),
    new Date(Date.now() + 60_000),
  );
  assert.ok(
    summary.totals.completed >= 5 &&
      summary.totals.refused >= 1 &&
      summary.totals.blocked >= 1,
  );
  assert.ok(summary.redactionOverhead.p50Ms !== null);
  step(
    `usage: ${summary.totals.invocations} invocations, redaction overhead p50 ${summary.redactionOverhead.p50Ms} ms ` +
      `/ p95 ${summary.redactionOverhead.p95Ms} ms, ${summary.totals.entitiesMasked} entities masked`,
  );

  // ── 14. Crypto-shredding a conversation ─────────────────────────────────
  await run('hr', () => conversations.remove(hr, conversation.id));
  const [shredded]: Array<{ wrapped_data_key: string | null; messages: number }> =
    await dataSource.query(
      `SELECT c.wrapped_data_key,
            (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id) AS messages
       FROM conversations c WHERE c.id = $1`,
      [conversation.id],
    );
  assert.equal(shredded.wrapped_data_key, null);
  assert.equal(shredded.messages, 0);
  await assert.rejects(
    run('hr', () => conversations.get(hr, conversation.id)),
    code('CONVERSATION_NOT_FOUND'),
  );
  step('conversation delete: key destroyed and messages gone in one transaction');

  // ── 15. The audit chain survived all of it ──────────────────────────────
  const verification = await moduleRef.get(AuditService).verifyChain(organizationId);
  assert.equal(verification.valid, true);
  step(`audit chain verified (${verification.recordsChecked} records)`);

  // Tidy up.
  await run('owner', () => documents.remove(owner, leave.id));
  await run('employee', () => conversations.remove(employee, employeeConversation.id));
  await run('owner', () =>
    agents.update(owner, helpdesk, {
      retrieval: { knowledgeBaseIds: [handbook] },
      changeNote: 'Reset after e2e',
    }),
  );

  await moduleRef.close();
  console.log('All phase 3 checks passed.');
}

main().catch((error) => {
  console.error('E2E verification FAILED:', error);
  process.exit(1);
});
