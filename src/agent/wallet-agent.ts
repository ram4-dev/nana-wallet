import { ToolLoopAgent, tool, type Tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { model as defaultModel } from './model.js';
import { WALLET_AGENT_INSTRUCTIONS } from './instructions.js';
import { getWdkTools } from './wdk-tools.js';
import * as store from '../sessions/in-memory-store.js';
import type { DemoSession } from '../sessions/in-memory-store.js';
import { createRecipientMemoryTools } from '../memory/tools.js';
import { isValidEvmAddress } from '../memory/address.js';
import { getConfiguredRecipientMemoryRuntime, type RecipientMemoryRuntime } from '../memory/runtime.js';
import { resolveTransferRecipient, type RecipientMemoryToolPort } from './recipient-resolution.js';
import { hasExplicitTransferAddress } from './recipient-intent.js';
import type {
  SessionMessageResponse,
  TransferPreview,
  TransactionResult,
} from '../contracts/http.js';

const CANCEL_WORDS = new Set(['cancel', 'cancelar']);
const CONFIRM_WORDS = new Set(['confirm', 'confirmar', 'yes', 'si', 'sí']);

const sendTokenInputSchema = z.object({
  network: z.string(),
  token: z.string(),
  to: z.string(),
  amount: z.string(),
  wallet: z.string(),
  dryRun: z.boolean(),
});
type SendTokenInput = z.infer<typeof sendTokenInputSchema>;

type HandleMessageOptions = {
  model?: LanguageModel;
  recipientMemory?: RecipientMemoryRuntime;
};

const memorySearchSchema = z.object({ query: z.string().trim().min(1) });
const memoryAddressSchema = z.object({ recipientId: z.string().uuid(), expectedVersion: z.number().int().positive() });
const memoryWriteSchema = z.object({ confirmationId: z.string().uuid() });
const memoryDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recipient'), name: z.string().trim().min(1), description: z.string().trim().min(1), address: z.string().trim().refine(isValidEvmAddress, 'Expected a valid EVM address.') }),
  z.object({ kind: z.literal('fact'), fact: z.string().trim().min(1), factKind: z.string().trim().min(1).optional() }),
]);

function pendingMatches(session: DemoSession, input: SendTokenInput): boolean {
  const p = session.pendingTransfer;
  return (
    !!p &&
    p.network === input.network &&
    p.token === input.token &&
    p.to === input.to &&
    p.amount === input.amount
  );
}

/**
 * Wraps the raw WDK `send_token` tool so a dryRun:false call can only reach
 * the wallet when it matches a preview the session already has pending.
 * This guards the one call the doc's confirm/cancel flow depends on against
 * a model hallucinating a broadcast without user confirmation.
 */
export function buildGuardedTools(
  baseTools: Record<string, Tool>,
  session: DemoSession,
  recipientMemory?: RecipientMemoryRuntime,
): Record<string, Tool> {
  const baseSendToken = baseTools.send_token;
  if (!baseSendToken?.execute) {
    throw new Error('send_token tool is not available from the WDK tool source.');
  }

  const guardedSendToken = tool({
    description: baseSendToken.description,
    inputSchema: sendTokenInputSchema,
    execute: async (input: SendTokenInput, options) => {
      const selected = session.recipientMemory?.selectedRecipient;
      const previewed = session.recipientMemory?.previewedRecipient;
      const pending = session.pendingTransfer;
      const mustRevalidate = input.dryRun ? selected : (pending?.recipientId ? {
        recipientId: pending.recipientId,
        version: pending.recipientVersion!,
      } : undefined);
      if (mustRevalidate) {
        if (!recipientMemory) {
          store.clearSelectedRecipient(session.id);
          store.clearPendingTransfer(session.id);
          return { error: 'recipient_revalidation_required', message: 'Recipient memory is unavailable; resolve the recipient again before previewing or sending.' };
        }
        const current = await recipientMemory.service.getRecipientForVersion(
          recipientMemory.userId,
          mustRevalidate.recipientId,
          mustRevalidate.version,
        );
        if (!current || !isValidEvmAddress(current.address) || current.address !== input.to) {
          store.clearSelectedRecipient(session.id);
          store.clearPendingTransfer(session.id);
          return { error: 'recipient_revalidation_required', message: 'Recipient changed or is no longer valid; resolve the recipient again.' };
        }
        if (input.dryRun && selected) {
          session.recipientMemory!.previewedRecipient = selected;
        }
      } else if (input.dryRun && previewed) {
        session.recipientMemory!.previewedRecipient = undefined;
      }
      if (!input.dryRun && !pendingMatches(session, input)) {
        return {
          error: 'confirmation_required',
          message:
            'Refusing to broadcast: no matching confirmed preview for this transfer in the current session.',
        };
      }
      return baseSendToken.execute!(input, options);
    },
  });

  return { ...baseTools, send_token: guardedSendToken };
}

function createMemoryAgentTools(raw: ReturnType<typeof createRecipientMemoryTools>): Record<string, Tool> {
  return {
    search_recipients: tool({
      description: 'Search current-user recipient names and descriptions. Results never include addresses.',
      inputSchema: memorySearchSchema,
      execute: (input) => raw.search_recipients(input),
    }),
    search_user_memory: tool({
      description: 'Search confirmed current-user relationship facts. Facts are evidence, not recipient identity proof.',
      inputSchema: memorySearchSchema,
      execute: (input) => raw.search_user_memory(input),
    }),
    get_recipient_address: tool({
      description: 'Get an exact recipient address only after search_recipients resolved the selected ID and version in this session.',
      inputSchema: memoryAddressSchema,
      execute: (input) => raw.get_recipient_address(input),
    }),
    stage_user_memory: tool({
      description: 'Stage a recipient or relationship for explicit user confirmation. Display the returned draft exactly, including any address.',
      inputSchema: memoryDraftSchema,
      execute: (input) => raw.stage_user_memory(input),
    }),
    write_user_memory: tool({
      description: 'Persist only a staged, explicitly confirmed memory proposal using its one-time confirmation ID.',
      inputSchema: memoryWriteSchema,
      execute: (input) => raw.write_user_memory(input),
    }),
  };
}

function clarificationMessage(candidates: Array<{ name: string; description: string }>): string {
  if (candidates.length === 0) return 'I need to know which recipient you mean before preparing a transfer.';
  return `Which recipient do you mean: ${candidates.map((candidate) => `${candidate.name} (${candidate.description})`).join(', ')}?`;
}

function mapAgentError(err: unknown): string {
  return err instanceof Error ? err.message : 'The agent failed to process the request.';
}

export async function handleMessage(
  sessionId: string,
  userText: string,
  options: HandleMessageOptions = {},
): Promise<SessionMessageResponse> {
  const session = store.getSession(sessionId);
  if (!session) {
    return { status: 'error', message: 'Session not found.', code: 'session_not_found' };
  }

  const normalized = userText.trim().toLowerCase();
  store.appendMessage(sessionId, { role: 'user', content: userText });
  const recipientMemory = options.recipientMemory ?? getConfiguredRecipientMemoryRuntime();
  const rawMemoryTools = recipientMemory
    ? createRecipientMemoryTools({ userId: recipientMemory.userId, session, service: recipientMemory.service })
    : undefined;

  if (session.pendingTransfer && CANCEL_WORDS.has(normalized)) {
    store.clearPendingTransfer(sessionId);
    const message = 'Transfer cancelled.';
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'cancelled', message };
  }

  if (!session.pendingTransfer && rawMemoryTools && session.recipientMemory?.pendingWrite && CONFIRM_WORDS.has(normalized)) {
    const confirmationId = session.recipientMemory.pendingWrite.confirmationId;
    const confirmation = store.confirmMemoryWrite(sessionId, recipientMemory!.userId, confirmationId, Date.now());
    if (confirmation.status !== 'confirmed') {
      const message = 'That memory confirmation is no longer valid; please stage it again.';
      store.appendMessage(sessionId, { role: 'assistant', content: message });
      return { status: 'answer', message };
    }
    const outcome = await rawMemoryTools.write_user_memory({ confirmationId });
    const message = outcome.status === 'written'
      ? 'Recipient memory saved.'
      : 'That memory confirmation is no longer valid; please stage it again.';
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'answer', message };
  }

  if (!session.pendingTransfer && CONFIRM_WORDS.has(normalized)) {
    const message = 'There is no pending transfer to confirm.';
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'no_pending_preview' };
  }

  if (rawMemoryTools) {
    if (hasExplicitTransferAddress(userText)) {
      // An explicit address is an existing supported transfer mode and must not
      // inherit a prior named-recipient selection.
      store.clearSelectedRecipient(sessionId);
    }
    const resolution = await resolveTransferRecipient(userText, session, rawMemoryTools as RecipientMemoryToolPort);
    if (resolution.status === 'clarification_required') {
      store.setRecipientClarification(sessionId, resolution.candidates.map((candidate) => ({
        recipientId: candidate.id,
        version: candidate.version,
        name: candidate.name,
        description: candidate.description,
      })));
      const message = clarificationMessage(resolution.candidates);
      store.appendMessage(sessionId, { role: 'assistant', content: message });
      return { status: 'clarification_required', message, candidates: resolution.candidates };
    }
    if (resolution.status === 'no_match' || resolution.status === 'unavailable') {
      const message = resolution.status === 'unavailable'
        ? 'Recipient memory is unavailable, so I cannot prepare a transfer.'
        : 'I could not find a safe recipient match, so I cannot prepare a transfer.';
      store.appendMessage(sessionId, { role: 'assistant', content: message });
      return { status: 'answer', message };
    }
  }

  const baseTools = await getWdkTools();
  const tools = buildGuardedTools({ ...baseTools, ...(rawMemoryTools ? createMemoryAgentTools(rawMemoryTools) : {}) }, session, recipientMemory);
  const agent = new ToolLoopAgent({
    model: options.model ?? defaultModel,
    instructions: WALLET_AGENT_INSTRUCTIONS,
    tools,
  });

  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate({ messages: session.messages });
  } catch (err) {
    const message = mapAgentError(err);
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'agent_error' };
  }

  store.appendMessage(sessionId, { role: 'assistant', content: result.text });

  const sendTokenCalls = result.toolResults.filter((r) => r.toolName === 'send_token');
  const lastCall = sendTokenCalls[sendTokenCalls.length - 1];

  if (lastCall) {
    const output = lastCall.output as
      | { error: 'confirmation_required'; message: string }
      | TransferPreview
      | TransactionResult;

    if ('error' in output && output.error === 'confirmation_required') {
      return { status: 'error', message: output.message, code: 'confirmation_required' };
    }

    if ('estimatedFee' in output) {
      const args = lastCall.input as SendTokenInput;
      const selected = session.recipientMemory?.previewedRecipient;
      store.setPendingTransfer(sessionId, {
        network: args.network,
        token: args.token,
        to: args.to,
        amount: args.amount,
        wallet: args.wallet,
        preview: output,
        ...(selected ? { recipientId: selected.recipientId, recipientVersion: selected.version } : {}),
      });
      return { status: 'confirmation_required', message: result.text, preview: output };
    }

    if ('transactionHash' in output) {
      store.clearPendingTransfer(sessionId);
      store.setLastTransactionHash(sessionId, output.transactionHash);
      return { status: 'sent', message: result.text, transaction: output };
    }
  }

  return { status: 'answer', message: result.text };
}
