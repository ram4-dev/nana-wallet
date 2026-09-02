import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { isValidEvmAddress } from '../memory/address.js';
import type { RecipientMemoryRuntime } from '../memory/runtime.js';
import type { ConversationSession } from '../conversations/session-state.js';
import { getWalletAgentConfig, type WalletAgentConfig } from '../agent/instructions.js';
import type { WalletProvider, TransferRequest } from './provider.js';

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
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/u;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

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

export function validateWalletTransferPolicy(input: SendTokenInput, config: WalletAgentConfig): { error: 'policy_rejected'; message: string } | undefined {
  if (process.env.WDK_TOOLS_SOURCE !== 'live') return undefined;
  const maximum = process.env.WDK_MAX_TRANSFER_AMOUNT?.trim();
  const allowed = process.env.WDK_ALLOWED_RECIPIENTS?.split(',').map((value) => value.trim()).filter(Boolean);
  if (!maximum || !allowed?.length) return { error: 'policy_rejected', message: 'Live transfer policy is not configured: set WDK_MAX_TRANSFER_AMOUNT and WDK_ALLOWED_RECIPIENTS.' };
  if (!positiveDecimal(maximum)) return { error: 'policy_rejected', message: 'Live transfer policy is invalid: WDK_MAX_TRANSFER_AMOUNT must be a positive plain decimal.' };
  if (input.wallet !== config.wallet || input.network !== config.network || input.token !== config.token) return { error: 'policy_rejected', message: 'Refusing live transfer: wallet, network, and token must exactly match the configured wallet.' };
  if (!positiveDecimal(input.amount)) return { error: 'policy_rejected', message: 'Refusing live transfer: amount must be a positive plain decimal.' };
  if (compareDecimals(input.amount, maximum) > 0) return { error: 'policy_rejected', message: 'Refusing live transfer: amount exceeds WDK_MAX_TRANSFER_AMOUNT.' };
  if (!isValidEvmAddress(input.to) || isBurnAddress(input.to)) return { error: 'policy_rejected', message: 'Refusing live transfer: recipient must be a valid non-burn EVM address.' };
  if (!allowed.some((value) => value.toLocaleLowerCase('en-US') === input.to.toLocaleLowerCase('en-US'))) return { error: 'policy_rejected', message: 'Refusing live transfer: recipient is not in WDK_ALLOWED_RECIPIENTS.' };
  return undefined;
}

function positiveDecimal(value: string): boolean {
  return DECIMAL_AMOUNT.test(value) && /[1-9]/u.test(value.replace('.', ''));
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  if (leftWhole.length !== rightWhole.length) return leftWhole.length < rightWhole.length ? -1 : 1;
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, '0').localeCompare(rightFraction.padEnd(width, '0'));
}

function isBurnAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase('en-US');
  return normalized === ZERO_ADDRESS || normalized === DEAD_ADDRESS;
}
