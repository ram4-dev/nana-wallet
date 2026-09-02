import { describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { resolveTransferRecipient, type RecipientMemoryToolPort } from '../../src/agent/recipient-resolution.js';
import { buildGuardedTools, handleMessage } from '../../src/agent/wallet-agent.js';
import { createRecipientMemoryTools } from '../../src/memory/tools.js';
import { RecipientMemoryService, type RecipientMemoryRepositoryPort } from '../../src/memory/service.js';
import { appendMessageById as appendMessage, confirmMemoryWrite, createSession, getSession, resetSessionStore, setPendingTransferById as setPendingTransfer } from '../../src/conversations/test-fixtures.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const GRANDSON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ELECTRICIAN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANDSON_ADDRESS = '0x1234567890123456789012345678901234567890';
const ELECTRICIAN_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const modelUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function modelStep(
  content: Array<
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
    | { type: 'text'; text: string }
  >,
) {
  return {
    content,
    finishReason: {
      unified: content.some((part) => part.type === 'tool-call') ? 'tool-calls' as const : 'stop' as const,
      raw: undefined,
    },
    usage: modelUsage,
    warnings: [],
  };
}

const toolOptions = {
  toolCallId: 'recipient-memory-release',
  messages: [],
  abortSignal: new AbortController().signal,
} as never;

function candidate(
  id: string,
  name: string,
  description: string,
  score = 0.95,
) {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    description,
    version: 1,
    status: 'active' as const,
    embeddingModelRevision: 'release-test',
    evidence: description,
    score,
  };
}

function memoryService(overrides: Partial<RecipientMemoryService> = {}): RecipientMemoryService {
  const grandson = candidate(GRANDSON_ID, 'Lucas', 'mi nieto');
  const electrician = candidate(ELECTRICIAN_ID, 'Lucas', 'el electricista');
  return {
    searchRecipients: vi.fn(async (_userId: string, query: string) => {
      if (query.toLowerCase() === 'lucas el electricista') {
        return { status: 'resolved' as const, candidates: [electrician], recipient: electrician };
      }
      return { status: 'resolved' as const, candidates: [grandson], recipient: grandson };
    }),
    searchUserMemory: vi.fn().mockResolvedValue({
      status: 'ok',
      facts: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', fact: 'Lucas is my grandson', kind: 'relationship', version: 1, evidence: 'Lucas is my grandson', score: 0.96 }],
    }),
    getRecipientForVersion: vi.fn(async (_userId: string, recipientId: string) => {
      if (recipientId === GRANDSON_ID) return { id: GRANDSON_ID, version: 1, address: GRANDSON_ADDRESS };
      if (recipientId === ELECTRICIAN_ID) return { id: ELECTRICIAN_ID, version: 1, address: ELECTRICIAN_ADDRESS };
      return undefined;
    }),
    writeConfirmed: vi.fn().mockResolvedValue({ kind: 'recipient', id: GRANDSON_ID, version: 1, name: 'Lucas' }),
    ...overrides,
  } as unknown as RecipientMemoryService;
}

function recordingWdk() {
  const sendToken = vi.fn(async (input: { network: string; token: string; to: string; amount: string; dryRun: boolean }) => input.dryRun
    ? { preview: true, network: input.network, token: input.token, to: input.to, amount: input.amount, estimatedFee: '0.0003 ETH' }
    : { network: input.network, transactionHash: '0xfixture', explorerUrl: 'https://sepolia.etherscan.io/tx/0xfixture' });
  return {
    sendToken,
    tools: {
      send_token: tool({
        description: 'Preview or execute a transfer.',
        inputSchema: z.object({ network: z.string(), token: z.string(), to: z.string(), amount: z.string(), wallet: z.string(), dryRun: z.boolean() }),
        execute: sendToken,
      }),
    },
  };
}

describe('recipient-memory release flow', () => {
  it('resolves my grandson through handleMessage and previews only the selected address', async () => {
    resetSessionStore();
    const previousToken = process.env.WDK_TOKEN;
    const previousNetwork = process.env.WDK_NETWORK;
    const previousWallet = process.env.WDK_WALLET_NAME;
    const previousToolsSource = process.env.WDK_TOOLS_SOURCE;
    process.env.WDK_TOKEN = 'usdt-test';
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_WALLET_NAME = 'agent-demo';
    process.env.WDK_TOOLS_SOURCE = 'fixture';

    try {
      const session = createSession();
      const service = memoryService();
      const model = new MockLanguageModelV3({
        doGenerate: [
          modelStep([{
            type: 'tool-call',
            toolCallId: 'selected-address',
            toolName: 'get_selected_recipient_address',
            input: '{}',
          }]),
          modelStep([{
            type: 'tool-call',
            toolCallId: 'preview-transfer',
            toolName: 'send_token',
            input: JSON.stringify({
              network: 'sepolia',
              token: 'usdt-test',
              to: GRANDSON_ADDRESS,
              amount: '0.01',
              wallet: 'agent-demo',
              dryRun: true,
            }),
          }]),
          modelStep([{ type: 'text', text: 'Previsualización lista para Lucas. ¿Confirmás?' }]),
        ],
      });

      const result = await handleMessage(session, 'Enviá 0.01 USDT a mi nieto', {
        model,
        recipientMemory: { userId: USER_A, service },
      });

      expect(result).toMatchObject({
        status: 'confirmation_required',
        message: 'Previsualización lista para Lucas. ¿Confirmás?',
        preview: {
          network: 'sepolia',
          token: 'usdt-test',
          recipient: GRANDSON_ADDRESS,
          amount: '0.01',
        },
      });
      expect(result.message).not.toContain(GRANDSON_ADDRESS);
      expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toEqual({
        recipientId: GRANDSON_ID,
        version: 1,
      });
      expect(getSession(session.id)?.pendingTransfer).toMatchObject({
        to: GRANDSON_ADDRESS,
        recipientId: GRANDSON_ID,
        recipientVersion: 1,
      });
      expect(getSession(session.id)?.lastTransactionHash).toBeUndefined();
      expect(JSON.stringify(model.doGenerateCalls[0])).not.toContain(GRANDSON_ADDRESS);
      expect(JSON.stringify(model.doGenerateCalls[0])).toContain('get_selected_recipient_address');
      expect(JSON.stringify(model.doGenerateCalls[0])).not.toContain('"get_recipient_address"');
    } finally {
      if (previousToken === undefined) delete process.env.WDK_TOKEN;
      else process.env.WDK_TOKEN = previousToken;
      if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
      else process.env.WDK_NETWORK = previousNetwork;
      if (previousWallet === undefined) delete process.env.WDK_WALLET_NAME;
      else process.env.WDK_WALLET_NAME = previousWallet;
      if (previousToolsSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
      else process.env.WDK_TOOLS_SOURCE = previousToolsSource;
      resetSessionStore();
    }
  });

  it('RED: preserves conflicting relationship clarification from service through tools and resolver despite the real 0.138724 score gap', async () => {
    resetSessionStore();
    const searchRecipients = vi.fn();
    const repository: RecipientMemoryRepositoryPort = {
      searchFacts: vi.fn().mockResolvedValue([
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', fact: 'Lucas es mi nieto', kind: 'relationship', version: 1, evidence: 'Lucas es mi nieto', score: 0.955022 },
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fact: 'Mateo es mi nieto', kind: 'relationship', version: 1, evidence: 'Mateo es mi nieto', score: 0.816298 },
      ]),
      searchRecipients,
      getRecipientForVersion: vi.fn(),
      insertRecipient: vi.fn(),
      insertFact: vi.fn(),
    };
    const service = new RecipientMemoryService(repository, { embed: vi.fn().mockResolvedValue(Array(384).fill(0)) }, {
      scoreThreshold: 0.7,
      scoreMargin: 0.2,
    });
    const session = createSession();
    const tools = createRecipientMemoryTools({ userId: USER_A, session, service });

    await expect(tools.search_user_memory({ query: 'mi nieto' })).resolves.toEqual({ status: 'clarification_required', facts: [] });
    await expect(resolveTransferRecipient('Mandale plata a mi nieto', session, tools as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'clarification_required', candidates: [],
    });
    expect(searchRecipients).not.toHaveBeenCalled();
  });

  it('resolves Lucas, a qualified description, and my grandson without exposing an address during retrieval', async () => {
    resetSessionStore();
    const session = createSession();
    const service = memoryService();
    const tools = createRecipientMemoryTools({ userId: USER_A, session, service });

    await expect(resolveTransferRecipient('Mandale plata a Lucas', session, tools as unknown as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: GRANDSON_ID, version: 1 },
    });
    const named = await tools.search_recipients({ query: 'Lucas' });
    expect(JSON.stringify(named)).not.toContain(GRANDSON_ADDRESS);

    await expect(resolveTransferRecipient('Mandale plata a Lucas el electricista', session, tools as unknown as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: ELECTRICIAN_ID, version: 1 },
    });
    await expect(resolveTransferRecipient('Send money to my grandson', session, tools as unknown as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: GRANDSON_ID, version: 1 },
    });
    expect(service.searchUserMemory).toHaveBeenCalledWith(USER_A, 'my grandson');
    expect(service.searchRecipients).toHaveBeenCalledWith(USER_A, 'Lucas');
  });

  it('RED: resolves a contextual pronoun only after a prior recipient search selected a stable record, without retrieving an address', async () => {
    resetSessionStore();
    const session = createSession();
    const service = memoryService();
    const tools = createRecipientMemoryTools({ userId: USER_A, session, service });

    await expect(resolveTransferRecipient('Mandale plata a Lucas', session, tools as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: GRANDSON_ID, version: 1 },
    });
    expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toEqual({ recipientId: GRANDSON_ID, version: 1 });
    await expect(resolveTransferRecipient('Send him money', session, tools as RecipientMemoryToolPort)).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: GRANDSON_ID, version: 1 },
    });
    expect(service.searchRecipients).toHaveBeenCalledTimes(1);
    expect(service.getRecipientForVersion).not.toHaveBeenCalled();
  });

  it('contains ambiguity, tenant data, and unavailable memory before address lookup or preview', async () => {
    resetSessionStore();
    const sessionA = createSession();
    const ambiguous = memoryService({
      searchRecipients: vi.fn().mockResolvedValue({
        status: 'clarification_required',
        candidates: [candidate(GRANDSON_ID, 'Lucas', 'mi nieto'), candidate(ELECTRICIAN_ID, 'Lucas', 'el electricista')],
      }),
    });
    const toolsA = createRecipientMemoryTools({ userId: USER_A, session: sessionA, service: ambiguous });
    await expect(resolveTransferRecipient('Mandale plata a Lucas', sessionA, toolsA as unknown as RecipientMemoryToolPort)).resolves.toMatchObject({ status: 'clarification_required' });
    await expect(toolsA.get_recipient_address({ recipientId: GRANDSON_ID, expectedVersion: 1 })).resolves.toEqual({ status: 'selection_required' });

    const sessionB = createSession();
    const serviceB = memoryService({
      searchRecipients: vi.fn().mockResolvedValue({
        status: 'resolved', candidates: [candidate(ELECTRICIAN_ID, 'Lucas', 'compañero de trabajo')], recipient: candidate(ELECTRICIAN_ID, 'Lucas', 'compañero de trabajo'),
      }),
    });
    const toolsB = createRecipientMemoryTools({ userId: USER_B, session: sessionB, service: serviceB });
    const foreign = await toolsB.search_recipients({ query: 'Lucas' });
    expect(foreign).toMatchObject({ status: 'resolved', recipient: { description: 'compañero de trabajo' } });
    expect(JSON.stringify(foreign)).not.toContain(GRANDSON_ADDRESS);
    expect(serviceB.searchRecipients).toHaveBeenCalledWith(USER_B, 'Lucas');
    expect(ambiguous.searchRecipients).not.toHaveBeenCalledWith(USER_B, expect.any(String));

    const unavailableSession = createSession();
    const unavailableTools = createRecipientMemoryTools({
      userId: USER_A,
      session: unavailableSession,
      service: memoryService({ searchRecipients: vi.fn().mockResolvedValue({ status: 'unavailable', candidates: [] }) }),
    });
    await expect(resolveTransferRecipient('Mandale plata a Lucas', unavailableSession, unavailableTools as unknown as RecipientMemoryToolPort)).resolves.toEqual({ status: 'unavailable', candidates: [] });
    await expect(unavailableTools.get_recipient_address({ recipientId: GRANDSON_ID, expectedVersion: 1 })).resolves.toEqual({ status: 'selection_required' });
    expect(getSession(unavailableSession.id)?.pendingTransfer).toBeUndefined();
  });

  it('requires a confirmed write, invalidates stale records, and hands the exact persisted address to WDK', async () => {
    resetSessionStore();
    const session = createSession();
    const service = memoryService();
    const tools = createRecipientMemoryTools({ userId: USER_A, session, service });

    const staged = await tools.stage_user_memory({ kind: 'recipient', name: 'Lucas', description: 'mi nieto', address: GRANDSON_ADDRESS });
    expect(service.writeConfirmed).not.toHaveBeenCalled();
    if (staged.status !== 'confirmation_required') throw new Error('Expected a staged write.');
    await expect(tools.write_user_memory({ confirmationId: staged.confirmationId })).resolves.toEqual({ status: 'confirmation_required' });
    appendMessage(session.id, { role: 'user', content: 'confirm' });
    expect(confirmMemoryWrite(session.id, USER_A, staged.confirmationId, Date.now())).toEqual({ status: 'confirmed' });
    await expect(tools.write_user_memory({ confirmationId: staged.confirmationId })).resolves.toMatchObject({ status: 'written', id: GRANDSON_ID });
    expect(service.writeConfirmed).toHaveBeenCalledWith(USER_A, staged.draft);

    await tools.search_recipients({ query: 'Lucas' });
    await expect(tools.get_recipient_address({ recipientId: GRANDSON_ID, expectedVersion: 1 })).resolves.toEqual({
      status: 'resolved', recipientId: GRANDSON_ID, version: 1, address: GRANDSON_ADDRESS,
    });
    const wdk = recordingWdk();
    const guarded = buildGuardedTools(
      wdk.tools,
      session,
      { userId: USER_A, service },
      { network: 'sepolia', token: 'USDT', wallet: 'agent-demo' },
    );
    const preview = await guarded.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: GRANDSON_ADDRESS, amount: '1', wallet: 'agent-demo', dryRun: true },
      toolOptions,
    );
    expect(preview).toMatchObject({ to: GRANDSON_ADDRESS, preview: true });
    expect(wdk.sendToken).toHaveBeenLastCalledWith(expect.objectContaining({ to: GRANDSON_ADDRESS, dryRun: true }), expect.anything());

    setPendingTransfer(session.id, {
      network: 'sepolia', token: 'USDT', to: GRANDSON_ADDRESS, amount: '1', wallet: 'agent-demo',
      preview: { network: 'sepolia', token: 'USDT', recipient: GRANDSON_ADDRESS, amount: '1', estimatedFee: '0.0003 ETH' },
      recipientId: GRANDSON_ID, recipientVersion: 1,
    });
    await guarded.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: GRANDSON_ADDRESS, amount: '1', wallet: 'agent-demo', dryRun: false },
      toolOptions,
    );
    expect(wdk.sendToken).toHaveBeenLastCalledWith(expect.objectContaining({ to: GRANDSON_ADDRESS, dryRun: false }), expect.anything());

    const staleSession = createSession();
    const staleService = memoryService({ getRecipientForVersion: vi.fn().mockResolvedValue(undefined) });
    const staleTools = createRecipientMemoryTools({ userId: USER_A, session: staleSession, service: staleService });
    await staleTools.search_recipients({ query: 'Lucas' });
    await expect(staleTools.get_recipient_address({ recipientId: GRANDSON_ID, expectedVersion: 1 })).resolves.toEqual({ status: 'stale_selection' });
  });
});
