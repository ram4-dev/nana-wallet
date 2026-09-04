import { ToolLoopAgent, tool, type Tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { model as defaultModel } from './model.js';
import {
  buildWalletAgentInstructions,
  getWalletAgentConfig,
  type WalletAgentConfig,
} from './instructions.js';
import { toAiSdkTools } from './ai-sdk-adapter.js';
import {
  balanceInputSchema,
  canonicalizeTransferPreview,
  createWalletAgentDefinition,
  memoryDraftSchema,
  memorySearchSchema,
  memoryWriteSchema,
  normalizeBroadcastResult,
  normalizeWalletToken as normalizeCanonicalWalletToken,
  sendTokenInputSchema,
  type SendTokenInput,
} from './definition.js';
import { getWdkTools } from './wdk-tools.js';
import type { WalletProvider } from '../wallet/provider.js';
import {
  defaultTransactionReceiptWaiter,
  type TransactionReceiptWaiter,
} from '../wdk/transaction-receipt.js';
import { isDeterministicAgentRuntime, parseDeterministicIntent } from './deterministic-intent.js';
import {
  appendMessage,
  claimPendingTransfer,
  clearPendingTransfer,
  clearSelectedRecipient,
  confirmMemoryWrite,
  invalidateSelectedRecipient,
  markPendingTransferUncertain,
  releasePendingTransferClaim,
  setLastTransactionHash,
  setPendingTransfer,
  setRecipientClarification,
  setSelectedRecipient,
  type ConversationSession,
} from '../conversations/session-state.js';
import { createRecipientMemoryTools } from '../memory/tools.js';
import { isValidEvmAddress } from '../memory/address.js';
import { getConfiguredRecipientMemoryRuntime, type RecipientMemoryRuntime } from '../memory/runtime.js';
import { resolveTransferRecipient, type RecipientMemoryToolPort } from './recipient-resolution.js';
import { hasExplicitTransferAddress } from './recipient-intent.js';
import type { ConversationTurnResult, PendingTransfer } from '../contracts/http.js';
import type { ConversationLanguage } from '../conversations/language.js';

export { canonicalizeTransferPreview } from './definition.js';

const toolCallOptions = {
  toolCallId: 'session-send-token',
  messages: [],
  abortSignal: new AbortController().signal,
} as never;

const CANCEL_PHRASES = new Set([
  'cancel',
  'cancel transfer',
  'cancel the transfer',
  'cancel it',
  'no, cancel',
  'cancelar',
  'cancelo',
  'cancelar transferencia',
  'cancelar la transferencia',
  'cancelo la transferencia',
]);
const CONFIRM_PHRASES = new Set([
  'confirm',
  'i confirm',
  'yes confirm',
  'yes, confirm',
  'yes i confirm',
  'yes, i confirm',
  'confirm transfer',
  'confirm the transfer',
  'confirmar',
  'confirmo',
  'sí confirmo',
  'sí, confirmo',
  'si confirmo',
  'si, confirmo',
  'confirmar transferencia',
  'confirmar la transferencia',
  'confirmo la transferencia',
]);

function normalizeResolutionText(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase('es-AR')
    .normalize('NFC')
    .replace(/[.!]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

type BalanceInput = z.infer<typeof balanceInputSchema>;

const GENERIC_USDT_NAMES = new Set(['usdt', 'usd₮', 'tether']);

export function normalizeWalletToken(token: string, configuredToken: string): string {
  return normalizeCanonicalWalletToken(token, configuredToken);
}

function normalizeSendTokenInput(input: SendTokenInput, configuredToken: string): SendTokenInput {
  const token = normalizeWalletToken(input.token, configuredToken);
  return token === input.token ? input : { ...input, token };
}

const guardedSendTokenErrorSchema = z.object({
  error: z.enum(['confirmation_required', 'recipient_revalidation_required', 'policy_rejected']),
  message: z.string().trim().min(1),
});

const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/u;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

type ParsedDecimal = {
  integer: string;
  fraction: string;
};

function parsePositiveDecimal(value: string): ParsedDecimal | null {
  const normalized = value.trim();
  if (!DECIMAL_AMOUNT.test(normalized)) return null;
  const [rawInteger, fraction = ''] = normalized.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/u, '');
  if (!/[1-9]/u.test(`${integer}${fraction}`)) return null;
  return { integer, fraction };
}

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1;
  }
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1;
  const fractionLength = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(fractionLength, '0');
  const rightFraction = right.fraction.padEnd(fractionLength, '0');
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

function isBurnAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase('en-US');
  return normalized === ZERO_ADDRESS || normalized === DEAD_ADDRESS;
}

function rejectByPolicy(message: string): { error: 'policy_rejected'; message: string } {
  return { error: 'policy_rejected', message };
}

function validateLiveTransferPolicy(
  input: SendTokenInput,
  config: WalletAgentConfig,
): { error: 'policy_rejected'; message: string } | null {
  if (process.env.WDK_TOOLS_SOURCE !== 'live') return null;

  const maxAmount = process.env.WDK_MAX_TRANSFER_AMOUNT?.trim();
  const allowedRecipients = process.env.WDK_ALLOWED_RECIPIENTS?.split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (!maxAmount || !allowedRecipients?.length) {
    return rejectByPolicy(
      'Live transfer policy is not configured: set WDK_MAX_TRANSFER_AMOUNT and WDK_ALLOWED_RECIPIENTS.',
    );
  }

  const parsedMaxAmount = parsePositiveDecimal(maxAmount);
  if (!parsedMaxAmount) {
    return rejectByPolicy(
      'Live transfer policy is invalid: WDK_MAX_TRANSFER_AMOUNT must be a positive plain decimal.',
    );
  }
  if (allowedRecipients.some((address) => !isValidEvmAddress(address) || isBurnAddress(address))) {
    return rejectByPolicy(
      'Live transfer policy is invalid: WDK_ALLOWED_RECIPIENTS must contain only valid non-burn EVM addresses.',
    );
  }

  if (
    input.wallet !== config.wallet ||
    input.network !== config.network ||
    input.token !== config.token
  ) {
    return rejectByPolicy(
      'Refusing live transfer: wallet, network, and token must exactly match the configured wallet.',
    );
  }

  const parsedAmount = parsePositiveDecimal(input.amount);
  if (!parsedAmount) {
    return rejectByPolicy('Refusing live transfer: amount must be a positive plain decimal.');
  }
  if (compareDecimals(parsedAmount, parsedMaxAmount) > 0) {
    return rejectByPolicy('Refusing live transfer: amount exceeds WDK_MAX_TRANSFER_AMOUNT.');
  }

  if (!isValidEvmAddress(input.to)) {
    return rejectByPolicy('Refusing live transfer: recipient must be a valid EVM address.');
  }
  if (isBurnAddress(input.to)) {
    return rejectByPolicy('Refusing live transfer: zero and burn addresses are prohibited.');
  }
  const normalizedRecipient = input.to.toLocaleLowerCase('en-US');
  const allowlist = new Set(
    allowedRecipients.map((address) => address.toLocaleLowerCase('en-US')),
  );
  if (!allowlist.has(normalizedRecipient)) {
    return rejectByPolicy('Refusing live transfer: recipient is not in WDK_ALLOWED_RECIPIENTS.');
  }

  return null;
}

const transactionReceiptOutcomeSchema = z.object({
  status: z.enum(['confirmed', 'reverted']),
  network: z.literal('sepolia'),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
});

export type HandleMessageOptions = {
  model?: LanguageModel;
  recipientMemory?: RecipientMemoryRuntime;
  walletProvider?: WalletProvider;
  transactionReceiptWaiter?: TransactionReceiptWaiter;
  abortSignal?: AbortSignal;
  claimedTransfer?: PendingTransfer;
  language?: ConversationLanguage;
};

const selectedRecipientAddressSchema = z.object({}).strict();

function pendingMatches(session: ConversationSession, input: SendTokenInput): boolean {
  const p = session.pendingTransfer;
  return (
    !!p &&
    p.network === input.network &&
    p.token === input.token &&
    p.to === input.to &&
    p.amount === input.amount &&
    p.wallet === input.wallet
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
  session: ConversationSession,
  recipientMemory?: RecipientMemoryRuntime,
  config: WalletAgentConfig = getWalletAgentConfig(),
): Record<string, Tool> {
  const baseSendToken = baseTools.send_token;
  if (!baseSendToken?.execute) {
    throw new Error('send_token tool is not available from the WDK tool source.');
  }

  const baseGetBalance = baseTools.get_balance;
  const normalizedGetBalance = baseGetBalance?.execute
    ? tool({
      description: baseGetBalance.description,
      inputSchema: balanceInputSchema,
      execute: (input: BalanceInput, options) => baseGetBalance.execute!(
        input.token
          ? { ...input, token: normalizeWalletToken(input.token, config.token) }
          : input,
        options,
      ),
    })
    : undefined;

  const guardedSendToken = tool({
    description: baseSendToken.description,
    inputSchema: sendTokenInputSchema,
    execute: async (input: SendTokenInput, options) => {
      const normalizedInput = normalizeSendTokenInput(input, config.token);
      const policyRejection = validateLiveTransferPolicy(normalizedInput, config);
      if (policyRejection) return policyRejection;
      const selected = session.recipientMemory?.selectedRecipient;
      const previewed = session.recipientMemory?.previewedRecipient;
      const pending = session.pendingTransfer;
      if (
        normalizedInput.dryRun &&
        session.recipientMemory?.recipientSelectionRequired === true &&
        !selected
      ) {
        return {
          error: 'recipient_revalidation_required',
          message: 'Recipient changed or is no longer valid; resolve the recipient again.',
        };
      }
      const mustRevalidate = normalizedInput.dryRun ? selected : (pending?.recipientId ? {
        recipientId: pending.recipientId,
        version: pending.recipientVersion!,
      } : undefined);
      if (mustRevalidate) {
        if (!recipientMemory) {
          clearSelectedRecipient(session);
          clearPendingTransfer(session);
          return { error: 'recipient_revalidation_required', message: 'Recipient memory is unavailable; resolve the recipient again before previewing or sending.' };
        }
        const current = await recipientMemory.service.getRecipientForVersion(
          recipientMemory.userId,
          mustRevalidate.recipientId,
          mustRevalidate.version,
        );
        if (
          !current ||
          current.id !== mustRevalidate.recipientId ||
          current.version !== mustRevalidate.version ||
          !isValidEvmAddress(current.address) ||
          current.address !== normalizedInput.to
        ) {
          invalidateSelectedRecipient(session);
          clearPendingTransfer(session);
          return { error: 'recipient_revalidation_required', message: 'Recipient changed or is no longer valid; resolve the recipient again.' };
        }
        if (normalizedInput.dryRun && selected) {
          session.recipientMemory!.previewedRecipient = selected;
        }
      } else if (normalizedInput.dryRun && previewed) {
        session.recipientMemory!.previewedRecipient = undefined;
      }
      if (!normalizedInput.dryRun && !pendingMatches(session, normalizedInput)) {
        return {
          error: 'confirmation_required',
          message:
            'Refusing to broadcast: no matching confirmed preview for this transfer in the current session.',
        };
      }
      return baseSendToken.execute!(normalizedInput, options);
    },
  });

  return {
    ...baseTools,
    ...(normalizedGetBalance ? { get_balance: normalizedGetBalance } : {}),
    send_token: guardedSendToken,
  };
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
    get_selected_recipient_address: tool({
      description: 'Get the exact address for the recipient already selected and version-bound in this session. Takes no IDs or version arguments.',
      inputSchema: selectedRecipientAddressSchema,
      execute: (input) => raw.get_selected_recipient_address(input),
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

const CLARIFICATION_COPY = {
  en: {
    ask: (list: string) => `Which recipient do you mean: ${list}?`,
    missing: 'I need to know which recipient you mean before preparing a transfer.',
  },
  es: {
    ask: (list: string) => `¿A qué destinatario te referís: ${list}?`,
    missing: 'Necesito saber a qué destinatario te referís antes de preparar la transferencia.',
  },
} as const;

function clarificationMessage(
  candidates: Array<{ name: string; description: string }>,
  language: 'en' | 'es' = 'en',
): string {
  const copy = CLARIFICATION_COPY[language] ?? CLARIFICATION_COPY.en;
  if (candidates.length === 0) return copy.missing;
  return copy.ask(candidates.map((candidate) => `${candidate.name} (${candidate.description})`).join(', '));
}

function mapAgentError(err: unknown): string {
  return err instanceof Error ? err.message : 'The agent failed to process the request.';
}

export async function handleMessage(
  session: ConversationSession,
  userText: string,
  options: HandleMessageOptions = {},
): Promise<ConversationTurnResult> {
  const normalized = normalizeResolutionText(userText);
  appendMessage(session, { role: 'user', content: userText });
  const recipientMemory = options.recipientMemory ?? getConfiguredRecipientMemoryRuntime();
  const rawMemoryTools = recipientMemory
    ? createRecipientMemoryTools({ userId: recipientMemory.userId, session, service: recipientMemory.service })
    : undefined;

  if (session.transferResolutionState === 'uncertain') {
    const message =
      'The broadcast result is uncertain. Check the wallet history before taking another action.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'broadcast_uncertain' };
  }

  if (session.transferResolutionState === 'broadcasting') {
    const message = 'The confirmed transfer is already being broadcast.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'broadcast_in_progress' };
  }

  if (session.pendingTransfer && CANCEL_PHRASES.has(normalized)) {
    clearPendingTransfer(session);
    const message = 'Transfer cancelled.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'cancelled', message };
  }

  if (!session.pendingTransfer && rawMemoryTools && session.recipientMemory?.pendingWrite && CONFIRM_PHRASES.has(normalized)) {
    const confirmationId = session.recipientMemory.pendingWrite.confirmationId;
    const confirmation = confirmMemoryWrite(session, recipientMemory!.userId, confirmationId, Date.now());
    if (confirmation.status !== 'confirmed') {
      const message = 'That memory confirmation is no longer valid; please stage it again.';
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'answer', message };
    }
    const outcome = await rawMemoryTools.write_user_memory({ confirmationId });
    const message = outcome.status === 'written'
      ? 'Recipient memory saved.'
      : 'That memory confirmation is no longer valid; please stage it again.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'answer', message };
  }

  if (!session.pendingTransfer && CONFIRM_PHRASES.has(normalized)) {
    const message = 'There is no pending transfer to confirm.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'no_pending_preview' };
  }

  if (session.pendingTransfer && CONFIRM_PHRASES.has(normalized)) {
    const claim = options.claimedTransfer
      ? { status: 'claimed' as const, transfer: options.claimedTransfer }
      : claimPendingTransfer(session);
    if (claim.status !== 'claimed') {
      const message =
        claim.status === 'uncertain'
          ? 'The broadcast result is uncertain. Check the wallet history before taking another action.'
          : 'The confirmed transfer is already being broadcast.';
      return {
        status: 'error',
        message,
        code: claim.status === 'uncertain' ? 'broadcast_uncertain' : 'broadcast_in_progress',
      };
    }
    try {
      const baseTools = await getWdkTools();
      const tools = buildGuardedTools(baseTools, session, recipientMemory);
      return executeConfirmedTransfer(
        session,
        claim.transfer,
        tools,
        options.transactionReceiptWaiter,
        options.abortSignal,
      );
    } catch (error) {
      releasePendingTransferClaim(session);
      const message = mapAgentError(error);
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'error', message, code: 'agent_error' };
    }
  }

  if (session.pendingTransfer) {
    const message =
      'A transfer is waiting for your decision. Confirm or cancel it before sending another instruction.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'pending_confirmation' };
  }

  const hasExplicitAddress = hasExplicitTransferAddress(userText);
  if (hasExplicitAddress) {
    // An explicit address is complete recipient identity and must neither query
    // memory nor inherit a selection from an earlier named-recipient turn.
    clearSelectedRecipient(session);
  } else if (rawMemoryTools) {
    const resolution = await resolveTransferRecipient(userText, session, rawMemoryTools as RecipientMemoryToolPort);
    if (resolution.status === 'resolved') {
      setSelectedRecipient(session, resolution.recipient);
    }
    if (resolution.status === 'clarification_required') {
      setRecipientClarification(session, resolution.candidates.map((candidate) => ({
        recipientId: candidate.id,
        version: candidate.version,
        name: candidate.name,
        description: candidate.description,
      })));
      const message = clarificationMessage(resolution.candidates, options.language ?? 'en');
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'clarification_required', message, candidates: resolution.candidates };
    }
    if (resolution.status === 'no_match' || resolution.status === 'unavailable') {
      const message = resolution.status === 'unavailable'
        ? 'Recipient memory is unavailable, so I cannot prepare a transfer.'
        : 'I could not find a safe recipient match, so I cannot prepare a transfer.';
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'answer', message };
    }
  }

  const agentConfig = getWalletAgentConfig();
  const definition = options.walletProvider
    ? createWalletAgentDefinition()
    : undefined;
  const baseTools = definition && options.walletProvider
    ? toAiSdkTools(definition, {
      conversationId: session.id,
      userId: recipientMemory?.userId ?? '',
      language: options.language ?? 'en',
      config: agentConfig,
      session,
      wallet: options.walletProvider,
      ...(recipientMemory ? { recipientMemory } : {}),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    })
    : await getWdkTools();
  const tools = buildGuardedTools(
    definition ? baseTools : { ...baseTools, ...(rawMemoryTools ? createMemoryAgentTools(rawMemoryTools) : {}) },
    session,
    recipientMemory,
    agentConfig,
  );

  if (isDeterministicAgentRuntime() && !options.model) {
    return handleDeterministicTurn(userText, session, tools, agentConfig, options.language ?? 'en');
  }
  const agent = new ToolLoopAgent({
    model: options.model ?? defaultModel,
    instructions: definition
      ? definition.instructions({
        conversationId: session.id,
        userId: recipientMemory?.userId ?? '',
        language: options.language ?? 'en',
        config: agentConfig,
        session,
        wallet: options.walletProvider!,
        ...(recipientMemory ? { recipientMemory } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      })
      : buildWalletAgentInstructions(agentConfig, options.language ?? 'en'),
    tools,
  });

  let result: Awaited<ReturnType<typeof agent.generate>>;
  try {
    result = await agent.generate({ messages: session.messages });
  } catch (err) {
    const message = mapAgentError(err);
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'agent_error' };
  }

  appendMessage(session, { role: 'assistant', content: result.text });

  const sendTokenCalls = result.toolResults.filter((r) => r.toolName === 'send_token');
  const lastCall = sendTokenCalls[sendTokenCalls.length - 1];

  if (lastCall) {
    const output = lastCall.output as unknown;
    const guardedError = guardedSendTokenErrorSchema.safeParse(output);
    if (guardedError.success) {
      return {
        status: 'error',
        message: guardedError.data.message,
        code: guardedError.data.error,
      };
    }

    const parsedArgs = sendTokenInputSchema.safeParse(lastCall.input);
    const args = parsedArgs.success
      ? normalizeSendTokenInput(parsedArgs.data, agentConfig.token)
      : null;
    const transaction = normalizeBroadcastResult(output, args?.network ?? agentConfig.network);
    if (transaction) {
      clearPendingTransfer(session);
      setLastTransactionHash(session, transaction.transactionHash);
      return { status: 'sent', message: result.text, transaction };
    }

    const preview = args ? canonicalizeTransferPreview(args, output) : null;
    if (preview && args) {
      const selected = session.recipientMemory?.previewedRecipient;
      setPendingTransfer(session, {
        network: args.network,
        token: args.token,
        to: args.to,
        amount: args.amount,
        wallet: args.wallet,
        preview,
        ...(selected ? { recipientId: selected.recipientId, recipientVersion: selected.version } : {}),
      });
      return { status: 'confirmation_required', message: result.text, preview };
    }

    const message = 'The wallet returned an invalid transfer preview.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'invalid_tool_result' };
  }

  return { status: 'answer', message: result.text };
}

async function executeConfirmedTransfer(
  session: ConversationSession,
  pending: NonNullable<ConversationSession['pendingTransfer']>,
  tools: Record<string, Tool>,
  transactionReceiptWaiter: TransactionReceiptWaiter = defaultTransactionReceiptWaiter,
  abortSignal?: AbortSignal,
): Promise<ConversationTurnResult> {
  if (!pending.preview || !tools.send_token?.execute) {
    releasePendingTransferClaim(session);
    const message = 'There is no pending transfer to confirm.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'error', message, code: 'no_pending_preview' };
  }

  const input = {
    network: pending.network,
    token: pending.token,
    to: pending.to,
    amount: pending.amount,
    wallet: pending.wallet,
    dryRun: false,
  };

  let output: unknown;
  try {
    output = await tools.send_token.execute(input, toolCallOptions);
  } catch {
    return markBroadcastUncertain(session);
  }

  const guardedError = guardedSendTokenErrorSchema.safeParse(output);
  if (guardedError.success) {
    if (guardedError.data.error === 'confirmation_required') {
      releasePendingTransferClaim(session);
    } else {
      clearSelectedRecipient(session);
      clearPendingTransfer(session);
    }
    appendMessage(session, { role: 'assistant', content: guardedError.data.message });
    return {
      status: 'error',
      message: guardedError.data.message,
      code: guardedError.data.error,
    };
  }

  const transaction = normalizeBroadcastResult(output, pending.network);
  if (transaction) {
    setLastTransactionHash(session, transaction.transactionHash);
    let rawReceipt: unknown;
    try {
      rawReceipt = await transactionReceiptWaiter(transaction, { signal: abortSignal });
    } catch {
      return markTransactionReceiptInvalid(
        session,
        transaction.transactionHash,
        'The Sepolia receipt could not be verified.',
      );
    }
    const parsedReceipt = transactionReceiptOutcomeSchema.safeParse(rawReceipt);
    if (!parsedReceipt.success) {
      return markTransactionReceiptInvalid(
        session,
        transaction.transactionHash,
        'The Sepolia receipt is invalid.',
      );
    }
    const receipt = parsedReceipt.data;
    if (
      receipt.network !== transaction.network.toLocaleLowerCase('en-US') ||
      receipt.transactionHash.toLocaleLowerCase('en-US') !== transaction.transactionHash.toLocaleLowerCase('en-US')
    ) {
      return markTransactionReceiptInvalid(
        session,
        transaction.transactionHash,
        'The Sepolia receipt does not match the transfer.',
      );
    }
    clearPendingTransfer(session);
    if (receipt.status === 'reverted') {
      const message = `The transfer reverted on Sepolia. Hash: ${transaction.transactionHash}`;
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'error', message, code: 'transfer_reverted' };
    }
    const message = 'Transfer confirmed.';
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'sent', message, transaction };
  }

  return markBroadcastUncertain(session);
}

function markTransactionReceiptInvalid(
  session: ConversationSession,
  transactionHash: string,
  reason: string,
): ConversationTurnResult {
  // A hash proves the wallet already broadcast. Clearing the pending intent
  // releases the in-memory lock without ever making that transfer confirmable again.
  clearPendingTransfer(session);
  const message = `${reason} Hash: ${transactionHash}`;
  appendMessage(session, { role: 'assistant', content: message });
  return { status: 'error', message, code: 'transaction_receipt_invalid' };
}

function markBroadcastUncertain(session: ConversationSession): ConversationTurnResult {
  markPendingTransferUncertain(session);
  const message =
    'The broadcast result is uncertain. Check the wallet history before taking another action.';
  appendMessage(session, { role: 'assistant', content: message });
  return { status: 'error', message, code: 'broadcast_uncertain' };
}

async function handleDeterministicTurn(
  userText: string,
  session: ConversationSession,
  tools: Record<string, Tool>,
  config: WalletAgentConfig,
  language: ConversationLanguage = 'en',
): Promise<ConversationTurnResult> {
  const { network, token, wallet } = config;
  const intent = parseDeterministicIntent(userText, token);

  if (intent?.type === 'balance') {
    const balance = (await tools.get_balance?.execute!({ network, token, wallet }, toolCallOptions)) as {
      balance?: string;
      token?: string;
    };
    const message = language === 'es'
      ? `Tenés ${balance.balance ?? 'un monto desconocido'} ${balance.token ?? token}.`
      : `You have ${balance.balance ?? 'an unknown amount'} ${balance.token ?? token}.`;
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'answer', message };
  }

  if (intent?.type === 'send' && tools.send_token?.execute) {
    const input = normalizeSendTokenInput({
      network,
      token: intent.token,
      to: intent.to,
      amount: intent.amount,
      wallet,
      dryRun: true,
    }, token);
    const output = await tools.send_token.execute(input, toolCallOptions);
    const guardedError = guardedSendTokenErrorSchema.safeParse(output);
    if (guardedError.success) {
      appendMessage(session, { role: 'assistant', content: guardedError.data.message });
      return {
        status: 'error',
        message: guardedError.data.message,
        code: guardedError.data.error,
      };
    }
    const preview = canonicalizeTransferPreview(input, output);
    if (!preview) {
      const message = 'The wallet returned an invalid transfer preview.';
      appendMessage(session, { role: 'assistant', content: message });
      return { status: 'error', message, code: 'invalid_tool_result' };
    }
    setPendingTransfer(session, {
      network: input.network,
      token: input.token,
      to: input.to,
      amount: input.amount,
      wallet: input.wallet,
      preview,
    });
    const message = language === 'es'
      ? `Preparé una transferencia de ${input.amount} ${input.token} a ${input.to} en ${input.network}. Comisión estimada: ${preview.estimatedFee}. Confirmá para continuar.`
      : `Prepared a ${input.amount} ${input.token} transfer to ${input.to} on ${input.network}. Estimated fee: ${preview.estimatedFee}. Confirm to continue.`;
    appendMessage(session, { role: 'assistant', content: message });
    return { status: 'confirmation_required', message, preview };
  }

  const message = language === 'es'
    ? 'Decime a quién querés pagar o cuánto USDT querés enviar en Sepolia.'
    : 'Tell me who to pay or how much USDT you want to send on Sepolia.';
  appendMessage(session, { role: 'assistant', content: message });
  return { status: 'answer', message };
}
