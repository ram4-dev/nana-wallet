import { ToolLoopAgent, tool, type Tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { model as defaultModel } from './model.js';
import { WALLET_AGENT_INSTRUCTIONS } from './instructions.js';
import { getWdkTools } from './wdk-tools.js';
import * as store from '../sessions/in-memory-store.js';
import type { DemoSession } from '../sessions/in-memory-store.js';
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
): Record<string, Tool> {
  const baseSendToken = baseTools.send_token;
  if (!baseSendToken?.execute) {
    throw new Error('send_token tool is not available from the WDK tool source.');
  }

  const guardedSendToken = tool({
    description: baseSendToken.description,
    inputSchema: sendTokenInputSchema,
    execute: async (input: SendTokenInput, options) => {
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

function mapAgentError(err: unknown): string {
  return err instanceof Error ? err.message : 'The agent failed to process the request.';
}

export async function handleMessage(
  sessionId: string,
  userText: string,
  options: { model?: LanguageModel } = {},
): Promise<SessionMessageResponse> {
  const session = store.getSession(sessionId);
  if (!session) {
    return { status: 'error', message: 'Session not found.', code: 'session_not_found' };
  }

  const normalized = userText.trim().toLowerCase();
  store.appendMessage(sessionId, { role: 'user', content: userText });

  if (session.pendingTransfer && CANCEL_WORDS.has(normalized)) {
    store.clearPendingTransfer(sessionId);
    const message = 'Transfer cancelled.';
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'cancelled', message };
  }

  if (!session.pendingTransfer && CONFIRM_WORDS.has(normalized)) {
    const message = 'There is no pending transfer to confirm.';
    store.appendMessage(sessionId, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'no_pending_preview' };
  }

  const baseTools = await getWdkTools();
  const tools = buildGuardedTools(baseTools, session);
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
      store.setPendingTransfer(sessionId, {
        network: args.network,
        token: args.token,
        to: args.to,
        amount: args.amount,
        wallet: args.wallet,
        preview: output,
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
