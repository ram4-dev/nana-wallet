import type { ModelMessage } from 'ai';
import type { PendingTransfer, ConversationTurnResult } from '../../../src/contracts/http.js';
import type { RecipientSelection } from '../../../src/conversations/types.js';

/**
 * One model response step for a `MockLanguageModelV3` `doGenerate` sequence.
 * The ToolLoopAgent consumes these steps in order: a step may request tool
 * calls (executed by the agent) or produce a final text response that ends
 * the loop. The number of steps must cover every tool round plus the final
 * text, otherwise the mock runs out of steps.
 */
export type ModelStep = {
  content: Array<
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
    | { type: 'text'; text: string }
  >;
};

/**
 * Builds a single model step. The `input` field on a tool-call is the JSON
 * string the mock emits; the AI SDK parses it into the tool args.
 */
const modelUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export function modelStep(
  content: Array<
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
    | { type: 'text'; text: string }
  >,
): ModelStep {
  return {
    content,
    finishReason: {
      unified: content.some((part) => part.type === 'tool-call')
        ? ('tool-calls' as const)
        : ('stop' as const),
      raw: undefined,
    },
    usage: modelUsage,
    warnings: [],
  };
}

export type AgentTurn = {
  userText: string;
  modelSteps?: ModelStep[];
  language?: 'es' | 'en';
};

/**
 * Minimal recipient-memory service stub. Only the methods a scenario needs
 * are supplied; the task wraps these into a `RecipientMemoryRuntime`.
 */
export type RecipientMemoryStub = {
  userId: string;
  searchRecipients?: (userId: string, query: string) => Promise<unknown>;
  searchUserMemory?: (userId: string, query: string) => Promise<unknown>;
  getRecipientForVersion?: (
    userId: string,
    recipientId: string,
    version: number,
  ) => Promise<unknown>;
};

export type AgentScenario = {
  name: string;
  turns: AgentTurn[];
  env?: Record<string, string>;
  recipientMemory?: RecipientMemoryStub;
  preload?: {
    pendingTransfer?: PendingTransfer;
    selectedRecipient?: RecipientSelection;
  };
  expected: AgentExpected;
};

export type AgentExpected = {
  status: string;
  code?: string;
  toolNames?: string[];
  toolCall?: { toolName: string; args: Record<string, unknown> };
  broadcastReached?: boolean;
  previewRequested?: boolean;
  recipientSelected?: RecipientSelection;
  pendingTransfer?: boolean;
  clarificationAsked?: boolean;
};

export type AgentEvalOutput = {
  turnResult: ConversationTurnResult;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  broadcastReached: boolean;
  previewRequested: boolean;
  recipientSelected?: RecipientSelection;
  pendingTransfer: boolean;
  clarificationAsked: boolean;
};

export type AgentModelMessage = ModelMessage;
