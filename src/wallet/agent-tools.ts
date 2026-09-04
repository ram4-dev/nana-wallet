import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { isValidEvmAddress } from '../memory/address.js';
import type { RecipientMemoryRuntime } from '../memory/runtime.js';
import type { ConversationSession } from '../conversations/session-state.js';
import { getWalletAgentConfig, type WalletAgentConfig } from '../agent/instructions.js';
import { validateWalletTransferPolicy } from '../agent/definition.js';
import type { WalletProvider, TransferRequest } from './provider.js';

export { validateWalletTransferPolicy } from '../agent/definition.js';

const sendTokenSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1),
  to: z.string().trim().min(1),
  amount: z.string().trim().min(1),
  wallet: z.string().trim().min(1),
  dryRun: z.boolean(),
});
type SendTokenInput = z.infer<typeof sendTokenSchema>;

const balanceSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1).optional(),
  wallet: z.string().trim().min(1).optional(),
});

const historySchema = balanceSchema;
const addressSchema = z.object({
  network: z.string().trim().min(1),
  wallet: z.string().trim().min(1).optional(),
});

const GENERIC_USDT_NAMES = new Set(['usdt', 'usd₮', 'tether']);

export type WalletAgentToolsDependencies = {
  wallet: WalletProvider;
  session: ConversationSession;
  recipientMemory?: RecipientMemoryRuntime;
  config?: WalletAgentConfig;
};

export function createWalletAgentTools(dependencies: WalletAgentToolsDependencies): Record<string, Tool> {
  const config = dependencies.config ?? getWalletAgentConfig();
  return {
    get_networks: tool({
      description: 'List configured wallet networks.',
      inputSchema: z.object({}),
      execute: () => dependencies.wallet.listNetworks(),
    }),
    list_tokens: tool({
      description: 'List wallet tokens for a network.',
      inputSchema: z.object({ network: z.string().trim().min(1).optional() }),
      execute: (input) => dependencies.wallet.listTokens(input.network),
    }),
    get_address: tool({
      description: 'Read the configured wallet address.',
      inputSchema: addressSchema,
      execute: (input) => dependencies.wallet.getAddress({
        network: input.network,
        wallet: input.wallet ?? config.wallet,
      }),
    }),
    get_balance: tool({
      description: 'Read a wallet balance.',
      inputSchema: balanceSchema,
      execute: (input) => dependencies.wallet.getBalance({
        network: input.network,
        ...(input.token ? { token: normalizeToken(input.token, config.token) } : {}),
        wallet: input.wallet ?? config.wallet,
      }),
    }),
    get_history: tool({
      description: 'Read wallet transfer history.',
      inputSchema: historySchema,
      execute: (input) => dependencies.wallet.getHistory({
        network: input.network,
        ...(input.token ? { token: normalizeToken(input.token, config.token) } : {}),
        wallet: input.wallet ?? config.wallet,
      }),
    }),
    send_token: tool({
      description: 'Preview or execute a wallet transfer.',
      inputSchema: sendTokenSchema,
      execute: (input: SendTokenInput) => sendToken(dependencies, config, input),
    }),
  };
}

async function sendToken(
  dependencies: WalletAgentToolsDependencies,
  config: WalletAgentConfig,
  input: SendTokenInput,
): Promise<unknown> {
  const normalized: SendTokenInput = { ...input, token: normalizeToken(input.token, config.token) };
  const policyError = validateWalletTransferPolicy(normalized, config);
  if (policyError) return policyError;

  if (normalized.dryRun) {
    const recipientError = await revalidateRecipient(dependencies, normalized, true);
    if (recipientError) return recipientError;
    const preview = await dependencies.wallet.previewTransfer(toTransferRequest(normalized));
    return { preview: true, ...preview };
  }

  if (!matchesPending(dependencies.session.pendingTransfer, normalized)) {
    return {
      error: 'confirmation_required',
      message: 'Refusing to broadcast: no matching confirmed preview for this transfer in the current session.',
    };
  }
  const recipientError = await revalidateRecipient(dependencies, normalized, false);
  if (recipientError) return recipientError;
  const outcome = await dependencies.wallet.broadcastTransfer(toTransferRequest(normalized));
  if (outcome.kind === 'submitted') return outcome.transaction;
  return {
    error: outcome.kind === 'uncertain' ? 'broadcast_uncertain' : 'wallet_unavailable',
    message: outcome.reason,
  };
}

async function revalidateRecipient(
  dependencies: WalletAgentToolsDependencies,
  input: SendTokenInput,
  preview: boolean,
): Promise<{ error: 'recipient_revalidation_required'; message: string } | undefined> {
  const selected = dependencies.session.recipientMemory?.selectedRecipient;
  const pending = dependencies.session.pendingTransfer;
  const selection = preview ? selected : pending?.recipientId && pending.recipientVersion
    ? { recipientId: pending.recipientId, version: pending.recipientVersion }
    : undefined;
  if (!selection) return undefined;
  if (!dependencies.recipientMemory) return recipientRevalidationError();
  const current = await dependencies.recipientMemory.service.getRecipientForVersion(
    dependencies.recipientMemory.userId,
    selection.recipientId,
    selection.version,
  );
  if (!current || current.id !== selection.recipientId || current.version !== selection.version || !isValidEvmAddress(current.address) || current.address !== input.to) {
    return recipientRevalidationError();
  }
  if (preview) dependencies.session.recipientMemory!.previewedRecipient = selection;
  return undefined;
}

function recipientRevalidationError(): { error: 'recipient_revalidation_required'; message: string } {
  return { error: 'recipient_revalidation_required', message: 'Recipient changed or is no longer valid; resolve the recipient again.' };
}

function toTransferRequest(input: SendTokenInput): TransferRequest {
  return {
    network: input.network,
    token: input.token,
    to: input.to,
    amount: input.amount,
    wallet: input.wallet,
  };
}

function matchesPending(pending: ConversationSession['pendingTransfer'], input: SendTokenInput): boolean {
  return Boolean(pending && pending.network === input.network && pending.token === input.token && pending.to === input.to && pending.amount === input.amount && pending.wallet === input.wallet);
}

function normalizeToken(token: string, configuredToken: string): string {
  return GENERIC_USDT_NAMES.has(token.trim().normalize('NFKC').toLocaleLowerCase('en-US')) ? configuredToken : token;
}
