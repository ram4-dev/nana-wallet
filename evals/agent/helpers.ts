import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel, ModelMessage } from 'ai';
import { handleMessage, type HandleMessageOptions } from '../../src/agent/wallet-agent.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';
import {
  setPendingTransfer,
  setSelectedRecipient,
  type ConversationSession,
} from '../../src/conversations/session-state.js';
import type { RecipientMemoryRuntime } from '../../src/memory/runtime.js';
import type { RecipientMemoryService } from '../../src/memory/service.js';
import type { WalletProvider, TransferRequest } from '../../src/wallet/provider.js';
import type {
  AgentEvalOutput,
  AgentExpected,
  AgentScenario,
  RecipientMemoryStub,
} from './scenarios/types.js';
import type { ConversationTurnResult } from '../../src/contracts/http.js';

/**
 * Serializes env-sensitive scenario execution. Evalite runs data points with
 * `maxConcurrency` (default 5), but our scenarios mutate `process.env` and the
 * WDK fixture cache, so the env-mutating portion must run one at a time.
 */
let lockChain: Promise<void> = Promise.resolve();

export function withLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = lockChain;
  let release!: () => void;
  lockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(work).finally(release);
}

/** Env vars that affect the agent config, WDK source, or policy. */
const MANAGED_ENV = [
  'WDK_TOOLS_SOURCE',
  'WDK_MAX_TRANSFER_AMOUNT',
  'WDK_ALLOWED_RECIPIENTS',
  'WDK_TOKEN',
  'WDK_NETWORK',
  'WDK_WALLET_NAME',
  'AGENT_RUNTIME',
  'RECIPIENT_MEMORY_ENABLED',
] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of MANAGED_ENV) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyDefaultEnv(): void {
  // Deterministic agent config; recipient memory off so the configured runtime
  // never reaches for a database. Scenarios that need recipient memory pass an
  // explicit runtime and never read the configured one.
  process.env.WDK_TOKEN = 'USDT';
  process.env.WDK_NETWORK = 'sepolia';
  process.env.WDK_WALLET_NAME = 'agent-demo';
  process.env.WDK_TOOLS_SOURCE = 'fixture';
  process.env.RECIPIENT_MEMORY_ENABLED = 'false';
  delete process.env.AGENT_RUNTIME;
}

function applyScenarioEnv(scenario: AgentScenario): void {
  applyDefaultEnv();
  if (!scenario.env) return;
  for (const [key, value] of Object.entries(scenario.env)) {
    process.env[key] = value;
  }
}

function buildRecipientMemoryRuntime(
  stub: RecipientMemoryStub,
): RecipientMemoryRuntime {
  const service: Partial<RecipientMemoryService> = {};
  if (stub.searchRecipients) service.searchRecipients = stub.searchRecipients as RecipientMemoryService['searchRecipients'];
  if (stub.searchUserMemory) service.searchUserMemory = stub.searchUserMemory as RecipientMemoryService['searchUserMemory'];
  if (stub.getRecipientForVersion) service.getRecipientForVersion = stub.getRecipientForVersion as RecipientMemoryService['getRecipientForVersion'];
  return {
    userId: stub.userId,
    service: service as RecipientMemoryService,
  };
}

    /**
     * Runs a scenario through `handleMessage` with a real (network-backed) model
     * instead of a mock. The caller is responsible for serializing this through
     * `withLock`, because it mutates `process.env` and the WDK fixture cache the
     * same way `runAgentScenario` does. The returned message is the agent's final
     * turn text, which is what the conversational-quality judge evaluates.
     */
    export async function runRealAgent(
      scenario: AgentScenario,
      model: LanguageModel,
      language: 'es' | 'en' = 'es',
    ): Promise<{ message: string; turnResult: ConversationTurnResult }> {
      const saved = saveEnv();
      try {
        applyScenarioEnv(scenario);
        const session: ConversationSession = { id: randomUUID(), messages: [] };
        if (scenario.preload?.selectedRecipient) {
          setSelectedRecipient(session, scenario.preload.selectedRecipient);
        }
        if (scenario.preload?.pendingTransfer) {
          setPendingTransfer(session, scenario.preload.pendingTransfer);
        }
        const walletProvider = new RecordingWalletProvider(new FixtureWalletProvider());
        const options: HandleMessageOptions = {
          walletProvider,
          model,
          ...(scenario.recipientMemory
            ? { recipientMemory: buildRecipientMemoryRuntime(scenario.recipientMemory) }
            : {}),
        };

        let lastResult: ConversationTurnResult | undefined;
        for (const turn of scenario.turns) {
          lastResult = await handleMessage(session, turn.userText, {
            ...options,
            language: turn.language ?? language,
          });
        }
        if (!lastResult) throw new Error(`Scenario "${scenario.name}" produced no turn result.`);
        return { message: lastResult.message, turnResult: lastResult };
      } finally {
        restoreEnv(saved);
      }
    }

    /**
     * Wraps the fixture provider so a scenario can observe whether a preview or a
     * broadcast reached the wallet layer. The confirm/broadcast path inside
     * `handleMessage` actually routes through the WDK fixture tools, so
     * `broadcastReached` is computed from the final turn status as the
     * authoritative signal; this records the wallet-provider side for scenarios
     * that reach a broadcast through the provider.
     */
class RecordingWalletProvider implements WalletProvider {
  readonly id = 'fixture';
  readonly mode = 'fixture' as const;
  previewCalls: TransferRequest[] = [];
  broadcastCalls: TransferRequest[] = [];

  constructor(private readonly inner: FixtureWalletProvider) {}

  health(context: Parameters<WalletProvider['health']>[0]) {
    return this.inner.health(context);
  }
  listNetworks() {
    return this.inner.listNetworks();
  }
  listTokens(network?: string) {
    return this.inner.listTokens(network);
  }
  getAddress(context: Parameters<WalletProvider['getAddress']>[0]) {
    return this.inner.getAddress(context);
  }
  getBalance(query: Parameters<WalletProvider['getBalance']>[0]) {
    return this.inner.getBalance(query);
  }
  getHistory(query: Parameters<WalletProvider['getHistory']>[0]) {
    return this.inner.getHistory(query);
  }
  async previewTransfer(request: TransferRequest) {
    this.previewCalls.push(request);
    return this.inner.previewTransfer(request);
  }
  async broadcastTransfer(request: TransferRequest) {
    this.broadcastCalls.push(request);
    return this.inner.broadcastTransfer(request);
  }
  waitForFinality(request: Parameters<WalletProvider['waitForFinality']>[0], signal?: AbortSignal) {
    return this.inner.waitForFinality(request, signal);
  }
  close() {
    return this.inner.close();
  }
}

function extractToolCalls(
  model: MockLanguageModelV3 | undefined,
): Array<{ toolName: string; args: Record<string, unknown> }> {
  if (!model) return [];
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const call of model.doGenerateCalls) {
    const prompt = call.prompt as unknown as Array<ModelMessage> | { messages?: ModelMessage[] };
    const messages = Array.isArray(prompt) ? prompt : (prompt?.messages ?? []);
    for (const message of messages) {
      if (typeof message.content === 'string') continue;
      for (const part of message.content ?? []) {
        if (part.type !== 'tool-call') continue;
        const partAny = part as unknown as {
          toolCallId: string;
          toolName: string;
          args?: unknown;
          input?: unknown;
        };
        if (seen.has(partAny.toolCallId)) continue;
        seen.add(partAny.toolCallId);
        const raw = partAny.args ?? partAny.input;
        let args: Record<string, unknown> = {};
        if (typeof raw === 'string') {
          try {
            args = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            args = {};
          }
        } else if (raw && typeof raw === 'object') {
          args = raw as Record<string, unknown>;
        }
        calls.push({ toolName: partAny.toolName, args });
      }
    }
  }
  return calls;
}

function buildModel(scenario: AgentScenario): MockLanguageModelV3 | undefined {
  const steps = scenario.turns.flatMap((turn) => turn.modelSteps ?? []);
  if (steps.length === 0) return undefined;
  return new MockLanguageModelV3({ doGenerate: steps });
}

/**
 * Runs a scenario through `handleMessage`. Each turn shares the same session so
 * multi-turn flows (preview then confirm) accumulate state. The output carries
 * the final turn result plus the machine-checkable evidence the scorers need.
 */
export async function runAgentScenario(
  scenario: AgentScenario,
): Promise<AgentEvalOutput> {
  return withLock(async () => {
    const saved = saveEnv();
    try {
      applyScenarioEnv(scenario);
      const session: ConversationSession = { id: randomUUID(), messages: [] };
      if (scenario.preload?.selectedRecipient) {
        setSelectedRecipient(session, scenario.preload.selectedRecipient);
      }
      if (scenario.preload?.pendingTransfer) {
        setPendingTransfer(session, scenario.preload.pendingTransfer);
      }
      const walletProvider = new RecordingWalletProvider(new FixtureWalletProvider());
      const model = buildModel(scenario);
      const options: HandleMessageOptions = {
        walletProvider,
        ...(model ? { model } : {}),
        ...(scenario.recipientMemory
          ? { recipientMemory: buildRecipientMemoryRuntime(scenario.recipientMemory) }
          : {}),
      };

      let lastResult: AgentEvalOutput['turnResult'] | undefined;
      for (const turn of scenario.turns) {
        lastResult = await handleMessage(session, turn.userText, {
          ...options,
          ...(turn.language ? { language: turn.language } : {}),
        });
      }
      if (!lastResult) throw new Error(`Scenario "${scenario.name}" produced no turn result.`);

      return {
        turnResult: lastResult,
        toolCalls: extractToolCalls(model),
        broadcastReached: lastResult.status === 'sent',
        previewRequested: walletProvider.previewCalls.length > 0,
        recipientSelected: session.recipientMemory?.selectedRecipient,
        pendingTransfer: Boolean(session.pendingTransfer),
        clarificationAsked: lastResult.status === 'clarification_required',
      };
    } finally {
      restoreEnv(saved);
    }
  });
}

function anyToolCallMatches(
  toolCalls: AgentEvalOutput['toolCalls'],
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== toolName) return false;
    return Object.entries(args).every(([key, value]) => call.args[key] === value);
  });
}

export const agentScorers = [
  {
    name: 'tool_selected',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      const names = expected?.toolNames;
      if (!names?.length) return { score: 1 };
      const actual = new Set(output.toolCalls.map((call) => call.toolName));
      return { score: names.every((name) => actual.has(name)) ? 1 : 0 };
    },
  },
  {
    name: 'args_valid',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      const call = expected?.toolCall;
      if (!call) return { score: 1 };
      return { score: anyToolCallMatches(output.toolCalls, call.toolName, call.args) ? 1 : 0 };
    },
  },
  {
    name: 'guard_error_type',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (!expected?.code) return { score: 1 };
      return { score: output.turnResult.code === expected.code ? 1 : 0 };
    },
  },
  {
    name: 'broadcast_gated',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (expected?.broadcastReached === undefined) return { score: 1 };
      return { score: output.broadcastReached === expected.broadcastReached ? 1 : 0 };
    },
  },
  {
    name: 'recipient_resolved',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (!expected?.recipientSelected) return { score: 1 };
      const actual = output.recipientSelected;
      const exp = expected.recipientSelected;
      return { score: actual?.recipientId === exp.recipientId && actual.version === exp.version ? 1 : 0 };
    },
  },
  {
    name: 'turn_status',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (!expected?.status) return { score: 1 };
      return { score: output.turnResult.status === expected.status ? 1 : 0 };
    },
  },
  {
    name: 'preview_requested',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (expected?.previewRequested === undefined) return { score: 1 };
      return { score: output.previewRequested === expected.previewRequested ? 1 : 0 };
    },
  },
  {
    name: 'pending_transfer',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (expected?.pendingTransfer === undefined) return { score: 1 };
      return { score: output.pendingTransfer === expected.pendingTransfer ? 1 : 0 };
    },
  },
  {
    name: 'clarification_asked',
    scorer: ({ output, expected }: { output: AgentEvalOutput; expected?: AgentExpected }) => {
      if (expected?.clarificationAsked === undefined) return { score: 1 };
      return { score: output.clarificationAsked === expected.clarificationAsked ? 1 : 0 };
    },
  },
];
