import { z } from 'zod';
import { buildWalletAgentInstructions, type WalletAgentConfig } from './instructions.js';
import type { ConversationLanguage } from '../conversations/language.js';
import type { ConversationSession } from '../conversations/session-state.js';
import type { RecipientMemoryRuntime } from '../memory/runtime.js';
import { createRecipientMemoryTools } from '../memory/tools.js';
import { isValidEvmAddress } from '../memory/address.js';
import type { WalletProvider, TransferRequest } from '../wallet/provider.js';
import { decodeMcpText } from '../wdk/mcp-client.js';
import { transactionResultSchema, transferPreviewSchema, type TransferPreview } from '../contracts/http.js';

export type WalletAgentContext = {
  conversationId: string;
  userId: string;
  language: ConversationLanguage;
  config: WalletAgentConfig;
  session: ConversationSession;
  wallet: WalletProvider;
  recipientMemory?: RecipientMemoryRuntime;
  signal?: AbortSignal;
};

export type AgentToolDefinition<Input, Output> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute(input: Input, context: WalletAgentContext): Promise<Output>;
};

export type WalletAgentDefinition = {
  instructions(context: WalletAgentContext): string;
  tools(context: WalletAgentContext): readonly AgentToolDefinition<unknown, unknown>[];
};

export const sendTokenInputSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1),
  to: z.string().trim().min(1),
  amount: z.string().trim().min(1),
  wallet: z.string().trim().min(1),
  dryRun: z.boolean(),
});
export type SendTokenInput = z.infer<typeof sendTokenInputSchema>;

export const balanceInputSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1).optional(),
  wallet: z.string().trim().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
});

const addressInputSchema = z.object({
  network: z.string().trim().min(1),
  wallet: z.string().trim().min(1).optional(),
});
const listTokensInputSchema = z.object({ network: z.string().trim().min(1).optional() });
const emptyInputSchema = z.object({}).strict();
export const memorySearchSchema = z.object({ query: z.string().trim().min(1) });
export const memoryWriteSchema = z.object({ confirmationId: z.string().uuid() });
export const memoryDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recipient'), name: z.string().trim().min(1), description: z.string().trim().min(1), address: z.string().trim().refine(isValidEvmAddress, 'Expected a valid EVM address.') }),
  z.object({ kind: z.literal('fact'), fact: z.string().trim().min(1), factKind: z.string().trim().min(1).optional() }),
]);

const GENERIC_USDT_NAMES = new Set(['usdt', 'usd₮', 'tether']);
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/u;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

export function normalizeWalletToken(token: string, configuredToken: string): string {
  const normalized = token.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  return GENERIC_USDT_NAMES.has(normalized) ? configuredToken : token;
}

export function canonicalizeTransferPreview(
  input: SendTokenInput,
  output: unknown,
): TransferPreview | null {
  const candidate = decodePreviewCandidate(output);
  if (!candidate || candidate.preview !== true) return null;
  let estimatedFee: string | undefined;
  for (const value of [candidate.estimatedFeeFormatted, candidate.estimatedFee]) {
    const parsed = z.string().trim().min(1).safeParse(value);
    if (parsed.success) {
      estimatedFee = parsed.data;
      break;
    }
  }
  if (!estimatedFee) return null;
  const canonical = transferPreviewSchema.safeParse({
    network: input.network,
    token: input.token,
    recipient: input.to,
    amount: input.amount,
    estimatedFee,
  });
  return canonical.success ? canonical.data : null;
}

export function normalizeBroadcastResult(output: unknown, network: string) {
  const candidate = decodeBroadcastCandidate(output);
  const status = typeof candidate?.status === 'string' ? candidate.status.toLocaleLowerCase('en-US') : '';
  if (
    !candidate ||
    candidate.success === false ||
    'failure' in candidate ||
    'error' in candidate ||
    candidate.isError === true ||
    ['failed', 'error', 'reverted'].includes(status)
  ) return null;
  const hashEntry = ['transactionHash', 'txHash', 'hash']
    .map((key) => ({ key, value: candidate[key] }))
    .find(({ value }) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(value));
  if (!hashEntry || (hashEntry.key !== 'transactionHash' && candidate.success !== true)) return null;
  const hash = hashEntry.value as string;
  const result = transactionResultSchema.safeParse({
    network,
    transactionHash: hash,
    explorerUrl: `https://sepolia.etherscan.io/tx/${hash}`,
  });
  return result.success ? result.data : null;
}

export function validateWalletTransferPolicy(
  input: SendTokenInput,
  config: WalletAgentConfig,
): { error: 'policy_rejected'; message: string } | undefined {
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

export function createWalletAgentDefinition(): WalletAgentDefinition {
  return {
    instructions: (context) => buildWalletAgentInstructions(context.config, context.language),
    tools: (context) => [
      ...createWalletOperations(context),
      ...createRecipientMemoryOperations(context),
    ],
  };
}

function createWalletOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  return [
    {
      name: 'get_networks',
      description: 'List configured wallet networks.',
      inputSchema: emptyInputSchema,
      execute: async () => context.wallet.listNetworks(),
    },
    {
      name: 'list_tokens',
      description: 'List wallet tokens for a network.',
      inputSchema: listTokensInputSchema,
      execute: async (input) => context.wallet.listTokens((input as z.infer<typeof listTokensInputSchema>).network),
    },
    {
      name: 'get_address',
      description: 'Read the configured wallet address.',
      inputSchema: addressInputSchema,
      execute: async (input) => {
        const parsed = input as z.infer<typeof addressInputSchema>;
        return context.wallet.getAddress({ network: parsed.network, wallet: parsed.wallet ?? context.config.wallet });
      },
    },
    {
      name: 'get_balance',
      description: 'Read a wallet balance.',
      inputSchema: balanceInputSchema,
      execute: async (input) => {
        const parsed = input as z.infer<typeof balanceInputSchema>;
        return context.wallet.getBalance({
          network: parsed.network,
          ...(parsed.token ? { token: normalizeWalletToken(parsed.token, context.config.token) } : {}),
          wallet: parsed.wallet ?? context.config.wallet,
        });
      },
    },
    {
      name: 'get_history',
      description: 'Read wallet transfer history.',
      inputSchema: balanceInputSchema,
      execute: async (input) => {
        const parsed = input as z.infer<typeof balanceInputSchema>;
        return context.wallet.getHistory({
          network: parsed.network,
          ...(parsed.token ? { token: normalizeWalletToken(parsed.token, context.config.token) } : {}),
          wallet: parsed.wallet ?? context.config.wallet,
        });
      },
    },
    {
      name: 'send_token',
      description: 'Preview or execute a wallet transfer.',
      inputSchema: sendTokenInputSchema,
      execute: async (input) => sendToken(input as SendTokenInput, context),
    },
  ];
}

function createRecipientMemoryOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  if (!context.recipientMemory) return [];
  const raw = createRecipientMemoryTools({
    userId: context.recipientMemory.userId,
    session: context.session,
    service: context.recipientMemory.service,
  });
  return [
    { name: 'search_recipients', description: 'Search current-user recipient names and descriptions. Results never include addresses.', inputSchema: memorySearchSchema, execute: async (input) => raw.search_recipients(input) },
    { name: 'search_user_memory', description: 'Search confirmed current-user relationship facts. Facts are evidence, not recipient identity proof.', inputSchema: memorySearchSchema, execute: async (input) => raw.search_user_memory(input) },
    { name: 'get_selected_recipient_address', description: 'Get the exact address for the recipient already selected and version-bound in this session. Takes no IDs or version arguments.', inputSchema: emptyInputSchema, execute: async (input) => raw.get_selected_recipient_address(input) },
    { name: 'stage_user_memory', description: 'Stage a recipient or relationship for explicit user confirmation. Display the returned draft exactly, including any address.', inputSchema: memoryDraftSchema, execute: async (input) => raw.stage_user_memory(input) },
    { name: 'write_user_memory', description: 'Persist only a staged, explicitly confirmed memory proposal using its one-time confirmation ID.', inputSchema: memoryWriteSchema, execute: async (input) => raw.write_user_memory(input) },
  ];
}

async function sendToken(input: SendTokenInput, context: WalletAgentContext): Promise<unknown> {
  const normalized = { ...input, token: normalizeWalletToken(input.token, context.config.token) };
  const policyError = validateWalletTransferPolicy(normalized, context.config);
  if (policyError) return policyError;
  const request: TransferRequest = {
    network: normalized.network,
    token: normalized.token,
    to: normalized.to,
    amount: normalized.amount,
    wallet: normalized.wallet,
  };
  if (normalized.dryRun) return { preview: true, ...await context.wallet.previewTransfer(request) };
  const outcome = await context.wallet.broadcastTransfer(request);
  if (outcome.kind === 'submitted') return outcome.transaction;
  return { error: outcome.kind === 'uncertain' ? 'broadcast_uncertain' : 'wallet_unavailable', message: outcome.reason };
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

function decodePreviewCandidate(output: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof output === 'string') {
    try {
      return decodePreviewCandidate(JSON.parse(output) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const candidate = output as Record<string, unknown>;
  if (isBroadcastResult(candidate)) return null;
  const decoded = decodeMcpText(candidate);
  if (decoded !== candidate) return decodePreviewCandidate(decoded, depth + 1);
  if ('estimatedFee' in candidate || 'estimatedFeeFormatted' in candidate) return candidate;
  for (const key of ['output', 'result', 'data'] as const) {
    if (key in candidate) {
      const nested = decodePreviewCandidate(candidate[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function decodeBroadcastCandidate(output: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof output === 'string') {
    try {
      return decodeBroadcastCandidate(JSON.parse(output) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const candidate = output as Record<string, unknown>;
  const decoded = decodeMcpText(candidate);
  if (decoded !== candidate) return decodeBroadcastCandidate(decoded, depth + 1);
  if (['transactionHash', 'txHash', 'hash', 'success', 'failure', 'error'].some((key) => key in candidate)) return candidate;
  for (const key of ['output', 'result', 'data'] as const) {
    if (key in candidate) {
      const nested = decodeBroadcastCandidate(candidate[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function isBroadcastResult(candidate: Record<string, unknown>): boolean {
  if (candidate.preview === false || 'success' in candidate || 'broadcast' in candidate) return true;
  if (['success', 'sent', 'confirmed', 'broadcast', 'broadcasted'].includes(
    typeof candidate.status === 'string' ? candidate.status.toLocaleLowerCase('en-US') : '',
  )) return true;
  return ['transactionHash', 'txHash', 'hash'].some((key) => key in candidate);
}
