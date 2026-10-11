import { z } from 'zod';
import { asSchema, jsonSchema } from 'ai';
import { buildWalletAgentInstructions, type WalletAgentConfig } from './instructions.js';
import { formatBalanceForAgent } from './balance-format.js';
import type { ConversationLanguage } from '../conversations/language.js';
import { invalidateSelectedRecipient, type ConversationSession } from '../conversations/session-state.js';
import type { RecipientMemoryRuntime } from '../memory/runtime.js';
import { createRecipientMemoryTools } from '../memory/tools.js';
import { isValidRecipientAddress } from '../memory/address.js';
import type { RecipientCandidate } from '../memory/types.js';
import type { ContactRecord } from '../memory/contacts-repository.js';
import type { RecipientSearchResult } from '../memory/service.js';
import type { WalletProvider, TransferRequest } from '../wallet/provider.js';
import { explorerUrlFor } from '../wallet/provider.js';
import { decodeMcpText } from '../wdk/mcp-client.js';
import type { WalletConversationService } from '../conversations/service.js';
import {
  notDispatchedErrorCode,
  safeErrorMessage,
  type ConversationErrorCode,
} from '../conversations/errors.js';
import type { ConversationRepository } from '../conversations/repository.js';
import type { VoiceDecisionGate } from '../livekit/voice-decision-gate.js';
import type { ConfirmationArbiter } from '../conversations/confirmation-arbiter.js';
import type { ContactPermissionSnapshot } from '../wallet/policy/service.js';
import {
  transactionResultSchema,
  transferPreviewSchema,
  type ConversationTurnResult,
  type NaniGrantCreationResult,
  type TransferPreview,
} from '../contracts/http.js';

export type WalletAgentContext = {
  conversationId: string;
  userId: string;
  language: ConversationLanguage;
  config: WalletAgentConfig;
  session: ConversationSession;
  wallet: WalletProvider;
  recipientMemory?: RecipientMemoryRuntime;
  signal?: AbortSignal;
  /**
   * Voice-only runtime seam. When present, the shared `send_token` preview
   * delegates to the per-binding conversation service instead of the raw wallet
   * provider, and `confirm_transfer`/`cancel_transfer` are produced. Absent for
   * the text agent, which keeps the shared preview -> chat-confirmation flow.
   */
  voiceService?: WalletConversationService;
  /** Voice-only: repository the read-back snapshot and pending preview are read from. */
  voiceConversations?: ConversationRepository;
  /** Voice-only: spoken-decision evidence gate (fail closed when absent). */
  voiceDecisionGate?: VoiceDecisionGate;
  /** Shared typed window for contact and transfer authorizations in live voice. */
  confirmationArbiter?: ConfirmationArbiter;
  /** Server-owned proposal lifecycle. Model input is deliberately narrower. */
  contactActions?: ContactActionPort;
  /**
   * Read-only enumeration of the user's active contacts. Structurally
   * satisfied by `ContactsRepository`. Absent ⇒ `list_contacts` fails closed to
   * `unavailable` with an empty list (never an invented address book).
   */
  contacts?: ContactListPort;
  /** Voice-only: plays the preview read-back aloud before the spoken decision. */
  /**
   * Delegated-grant creation seam (DGC-6). Present for the text agent when the
   * conversation service is wired; voice uses `voiceService`. Absent ⇒ the
   * `create_grant` tool fails closed to `grant_creation_unavailable`.
   */
  grantService?: GrantCreationPort;
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

/**
 * Voice-only tools: the single permitted divergence between the text surface and
 * the voice surface. They are produced only for a voice context and are gated by
 * the spoken-decision evidence gate; the text agent confirms through a chat turn.
 * The parity test asserts every other tool name is shared.
 */
export const VOICE_ONLY_TOOLS = ['confirm_transfer', 'cancel_transfer'] as const;

export type ContactActionPort = {
  stage(input: {
    userId: string;
    conversationId: string;
    origin: 'text' | 'voice';
    action: 'create' | 'edit' | 'remove';
    contactId?: string;
    expectedVersion?: number;
    /** Display metadata only; it cannot identify a wallet address. */
    name?: string;
    description?: string;
    /**
     * An explicit `.sns` name the user supplied. It is a LABEL, never a
     * destination: the server resolves it and the resolved address is what the
     * user reviews and what the system stores. Accepted on `create` only — the
     * versioned tools and the confirmation take no name.
     */
    snsName?: string;
  }): Promise<{ status: 'staged' | 'confirmation_required' | 'conflict_active_window' | 'address_review_required' | 'proposal_not_published' | 'alias_unresolved'; proposalId?: string; proposalVersion?: number; message: string; code?: string }>;
  /**
   * Confirms one server-owned proposal. Stale or unknown ids fail closed and the
   * refusal names the proposal that is actually open (`currentProposalId` +
   * `currentProposalVersion`, read from the persisted row), so the model can
   * recover in one step instead of repeating the id it staged. The model still
   * supplies only `proposalId`/`proposalVersion` — never an address, phrase,
   * timestamp or turn count.
   */
  confirm?(input: { userId: string; conversationId: string; proposalId: string; proposalVersion: number; source: 'text' | 'voice' }): Promise<{
    status: string;
    message: string;
    currentProposalId?: string;
    currentProposalVersion?: number;
    /**
     * The typed code of a refusal (`code: ` on the seam's failures and on the
     * proposal-shape refusals), so the model can tell "that contact moved" from
     * "there is no address yet" instead of reading the sentence alone. `undefined`
     * on success and on the stale/unknown handle refusal, which is not a
     * mutation refusal at all.
     */
    code?: string;
    /**
     * Where the recipient's PERMISSION got to, read back from the recorded
     * revision — never a promise. It exists so "habilitado" can never be said
     * before a verified readback: `applied` is the only value that may be narrated
     * as enabled, and it is only ever produced by `projectContactPermission` after
     * a verified readback of the current desired revision. Absent when nothing was
     * applied.
     */
    permission?: ContactPermissionSnapshot['state'];
  }>;
};

const contactCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  /**
   * The alias the user said out loud. It is accepted as a NAME and nothing more:
   * `.strict()` still refuses `address`, `network`, `policyId`, `signerId`, a cap,
   * a confirmation, a timestamp and a turn count, so a model-inferred address has
   * no key to travel on.
   */
  snsName: z.string().trim().min(1).max(70).optional(),
}).strict();
const contactChangeInputSchema = z.object({
  contactId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();
const contactConfirmInputSchema = z.object({
  proposalId: z.string().uuid(),
  proposalVersion: z.number().int().positive(),
}).strict();

/**
 * Model-facing transfer schema, shared by the text and voice agents. Preview-only:
 * the model supplies the amount plus the versioned recipient it already resolved;
 * address, network, and token are resolved server-side. `.strict()` is the security
 * boundary — a model inventing `to`, `dryRun`, `network`, `token`, or `wallet` fails
 * closed before the tool ever executes.
 */
export const sendTokenInputSchema = z.object({
  amount: z.string().trim().min(1),
  recipientId: z.string().trim().min(1),
  recipientVersion: z.number().int().positive(),
  memo: z.string().trim().max(200).optional(),
}).strict();
export type PreviewSendTokenInput = z.infer<typeof sendTokenInputSchema>;

/**
 * Model-facing `create_grant` input (DGC-6). Preview-strict: the model supplies
 * only the already-resolved recipient and the SOL limits. The chain, rolling
 * window, expiry, and recipient address are resolved server-side, so `.strict()`
 * fails a model that invents `to`, `address`, `chain`, `windowSeconds`,
 * `expiresAt`, `recipients`, or `walletId` before the tool ever executes.
 */
export const createGrantInputSchema = z
  .object({
    recipientId: z.string().trim().min(1),
    recipientVersion: z.number().int().positive(),
    maxPerTransferSol: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,9})?$/u, 'must be a positive SOL amount with at most 9 decimals'),
    maxCumulativeSol: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,9})?$/u, 'must be a positive SOL amount with at most 9 decimals'),
  })
  .strict();
export type CreateGrantToolInput = z.infer<typeof createGrantInputSchema>;

/** Input accepted by the grant-creation seam (bound to one conversation). */
export type CreateDelegatedGrantInput = {
  userId: string;
  conversationId: string;
  recipientId: string;
  recipientVersion: number;
  maxPerTransferSol: string;
  maxCumulativeSol: string;
};

/** Model-facing grant-creation result. */
export type CreateDelegatedGrantResult = NaniGrantCreationResult;

/** Narrow seam the `create_grant` tool calls; implemented by the conversation service. */
export type GrantCreationPort = {
  createDelegatedGrant(
    input: CreateDelegatedGrantInput,
  ): Promise<CreateDelegatedGrantResult>;
};

/**
 * Narrow read-only seam the `list_contacts` tool calls. It is deliberately
 * exactly one method and structurally satisfied by `ContactsRepository`, whose
 * `listActive` is the SAME call the app screen's `GET /v1/contacts` makes
 * (`src/api/contacts.ts`). Enumerating through a different query would let the
 * agent and the screen disagree about what the user's contacts are — the
 * divergence class this codebase has been bitten by — so the one repository is
 * reused rather than a second read invented.
 */
export type ContactListPort = {
  listActive(userId: string): Promise<ContactRecord[]>;
};

/**
 * Internal broadcast input used by the guarded tool wrapper, the deterministic
 * path, and the confirmed-broadcast path. Never exposed to a model. `previewId`
 * is model-invisible: the zod input schema must never expose it, or a hallucinated
 * key could silently defeat the duplicate-broadcast idempotency protection.
 */
export const internalSendTokenInputSchema = z.object({
  network: z.string().trim().min(1),
  token: z.string().trim().min(1),
  to: z.string().trim().min(1),
  amount: z.string().trim().min(1),
  wallet: z.string().trim().min(1),
  dryRun: z.boolean(),
  // previewId is model-invisible (CAR-006) but passes through internal calls.
  previewId: z.string().optional(),
});
export type SendTokenInput = z.infer<typeof internalSendTokenInputSchema>;
export type SendTokenBroadcastInput = SendTokenInput & { previewId?: string };

/** Default network for a shared read tool that omits `network`. */
export const DEFAULT_READ_NETWORK = 'solana-devnet';

/**
 * Guarded-wrapper schema: accepts BOTH the model-facing preview-only shape and
 * the internal broadcast shape. Internal/deterministic callers and the legacy
 * WDK path exercise the wrapper directly; the wrapper's dual-parse and runtime
 * guards (pending preview match, policy, revalidation) stay authoritative.
 */
export const guardedSendTokenSchema = z.union([sendTokenInputSchema, internalSendTokenInputSchema]);

const guardedSendTokenUnion = asSchema(guardedSendTokenSchema);

/**
 * Parameters schema the provider is handed for the guarded `send_token` tool.
 *
 * A top-level `z.union` serializes to a bare `anyOf`, and the gateway validates
 * every function's schema before it routes a completion. Without a top-level
 * `type: "object"` it rejects the WHOLE turn:
 *
 *   Invalid schema for function 'send_token': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'.
 *
 * Every branch of the union is already an object, so the object type is implied
 * by the union itself: declaring it adds no constraint and removes none. The
 * validator stays the union — this changes only what the provider is told, and
 * the acceptance set above is exactly the one the wrapper had before.
 */
export const guardedSendTokenToolSchema = jsonSchema<z.output<typeof guardedSendTokenSchema>>(
  () => ({ ...guardedSendTokenUnion.jsonSchema, type: 'object' }),
  { validate: (value) => guardedSendTokenUnion.validate!(value) },
);

export const balanceInputSchema = z.object({
  network: z.string().trim().min(1).optional(),
  token: z.string().trim().min(1).optional(),
  wallet: z.string().trim().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
});

const addressInputSchema = z.object({
  network: z.string().trim().min(1).optional(),
  wallet: z.string().trim().min(1).optional(),
});
const listTokensInputSchema = z.object({ network: z.string().trim().min(1).optional() });
const emptyInputSchema = z.object({}).strict();
export type RealtimeContactCandidate = {
  id: string;
  name: string;
  normalizedName: string;
  description: string;
  version: number;
  status: 'active' | 'inactive';
  evidence: string;
  score: number;
  network?: 'solana-devnet';
};

/** Frontend-facing voice search result (see `RealtimeSearchContactsResult`). */
export type RealtimeSearchContactsResult = {
  query: string;
  count: number;
  ambiguous: boolean;
  status: RecipientSearchResult['status'];
  contacts: RealtimeContactCandidate[];
};

/**
 * Address-free financial tool result for the voice model. The recipient address
 * only ever travels inside the service machinery; the model receives
 * amount/token/status/message plus typed errors it can narrate in plain Spanish.
 */
export type RealtimeVoiceToolResult = {
  status: 'confirmation_required' | 'sent' | 'cancelled' | 'error';
  message: string;
  code?: string;
  amount?: string;
  token?: string;
  recipientName?: string;
  estimatedFee?: string;
  network?: string;
  transactionHash?: string;
};

export const memorySearchSchema = z.object({ query: z.string().trim().min(1) });
export const memoryWriteSchema = z.object({ confirmationId: z.string().uuid() });
export const memoryDraftSchema = z.object({
  kind: z.enum(['recipient', 'fact']),
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  address: z.string().trim().refine((value) => isValidRecipientAddress(value, 'solana-devnet'), 'Expected a canonical Solana address.').optional(),
  fact: z.string().trim().min(1).optional(),
  factKind: z.string().trim().min(1).optional(),
}).superRefine((value, issue) => {
  if (value.kind === 'recipient') {
    if (!value.name) issue.addIssue({ code: 'custom', path: ['name'], message: 'Recipient name is required.' });
    if (!value.description) issue.addIssue({ code: 'custom', path: ['description'], message: 'Recipient description is required.' });
    if (!value.address) issue.addIssue({ code: 'custom', path: ['address'], message: 'Recipient address is required.' });
    return;
  }
  if (!value.fact) issue.addIssue({ code: 'custom', path: ['fact'], message: 'Memory fact is required.' });
});

// ---------------------------------------------------------------------------
// Voice result helpers (shared definitions → frontend contract)
// ---------------------------------------------------------------------------

/** Map a service `ConversationTurnResult` onto an address-free tool result. */
function toVoiceToolResult(result: ConversationTurnResult): RealtimeVoiceToolResult {
  switch (result.status) {
    case 'confirmation_required':
      return { status: 'confirmation_required', message: result.message, amount: result.preview.amount, token: result.preview.token };
    case 'sent':
      return { status: 'sent', message: result.message, transactionHash: result.transaction.transactionHash };
    case 'cancelled':
      return { status: 'cancelled', message: result.message };
    case 'error':
      return { status: 'error', code: result.code, message: result.message };
    default:
      return { status: 'error', code: 'internal_error', message: result.message };
  }
}

/** Map a raw memory search result onto the voice-shaped result. */
function toVoiceSearchResult(
  query: string,
  result: { status: string; candidates?: Array<Record<string, unknown>>; recipient?: RecipientCandidate },
): RealtimeSearchContactsResult {
  if (result.status === 'unavailable') {
    return { query, count: 0, ambiguous: false, status: 'unavailable', contacts: [] };
  }
  const candidates = result.status === 'no_match' ? [] : (result.candidates ?? []) as RecipientCandidate[];
  const contacts = candidates.map(stripContact);
  return {
    query,
    count: contacts.length,
    ambiguous: result.status === 'clarification_required',
    status: result.status as RecipientSearchResult['status'],
    contacts,
  };
}

function stripContact(candidate: RecipientCandidate): RealtimeContactCandidate {
  return {
    id: candidate.id,
    name: candidate.name,
    normalizedName: candidate.normalizedName,
    description: candidate.description,
    version: candidate.version,
    status: candidate.status,
    evidence: candidate.evidence,
    score: candidate.score,
  };
}

// ---------------------------------------------------------------------------
// Shared transfer utilities (preview-only model path)
// ---------------------------------------------------------------------------

/**
 * Resolve a versioned recipient into a full internal broadcast input.
 * Reuses the same validation rules that `validatePreviewRecipient` uses
 * so the definition, the guarded wrapper, and the service agree.
 */
export async function resolvePreviewRecipient(
  input: PreviewSendTokenInput,
  ctx: {
    session: ConversationSession;
    recipientMemory?: RecipientMemoryRuntime;
    config: WalletAgentConfig;
  },
): Promise<
  | { ok: true; internal: SendTokenInput }
  | { ok: false; error: { error: 'recipient_revalidation_required'; message: string } }
> {
  if (!ctx.recipientMemory) {
    invalidateSelectedRecipient(ctx.session);
    return {
      ok: false,
      error: {
        error: 'recipient_revalidation_required',
        message: 'Recipient memory is unavailable; resolve the recipient again before previewing.',
      },
    };
  }
  if (ctx.session.recipientMemory?.recipientSelectionRequired && !ctx.session.recipientMemory.selectedRecipient) {
    return {
      ok: false,
      error: {
        error: 'recipient_revalidation_required',
        message: 'Recipient changed or is no longer valid; resolve the recipient again.',
      },
    };
  }
  const recipient = await ctx.recipientMemory.service.getRecipientForVersion(
    ctx.recipientMemory.userId,
    input.recipientId,
    input.recipientVersion,
  );
  if (!recipient || recipient.id !== input.recipientId || recipient.version !== input.recipientVersion || !isValidRecipientAddress(recipient.address, recipient.network)) {
    invalidateSelectedRecipient(ctx.session);
    return {
      ok: false,
      error: {
        error: 'recipient_revalidation_required',
        message: 'Recipient changed or is no longer valid; resolve the recipient again.',
      },
    };
  }
  // Also require the session's selected recipient matches the resolved one.
  const selected = ctx.session.recipientMemory?.selectedRecipient;
  if (selected && (selected.recipientId !== input.recipientId || selected.version !== input.recipientVersion)) {
    invalidateSelectedRecipient(ctx.session);
    return {
      ok: false,
      error: {
        error: 'recipient_revalidation_required',
        message: 'Recipient changed or is no longer valid; resolve the recipient again.',
      },
    };
  }
  const network = recipient.network ?? ctx.config.network;
  const token = recipient.network === 'solana-devnet' ? 'SOL' : ctx.config.token;
  const internal: SendTokenInput = {
    network,
    token,
    to: recipient.address,
    amount: input.amount,
    wallet: ctx.config.wallet,
    dryRun: true,
  };
  if (selected) {
    ctx.session.recipientMemory!.previewedRecipient = { recipientId: recipient.id, version: recipient.version };
  }
  return { ok: true, internal };
}

/**
 * Augment a preview result from the definition's internal preview path so
 * `handleMessage` can persist the full pending transfer (to/wallet from
 * the resolved recipient, not from the model).
 */
export type AugmentedPreviewOutput = {
  preview: true;
  network: string;
  token: string;
  to: string;
  amount: string;
  wallet: string;
  estimatedFee?: string;
};

export function augmentPreviewOutput(
  output: unknown,
  internal: SendTokenInput,
): AugmentedPreviewOutput | Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { preview: true, ...internal, dryRun: undefined } as AugmentedPreviewOutput;
  }
  const c = output as Record<string, unknown>;
  if (c.preview !== true) return c;
  return { ...c, network: internal.network, token: internal.token, to: internal.to, amount: internal.amount, wallet: internal.wallet };
}

const GENERIC_USDT_NAMES = new Set(['usdt', 'usd₮', 'tether']);

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

/**
 * A transaction hash as the provider reports it: an EVM `0x` hash, or a Solana
 * base58 signature (64 bytes, so 87-88 base58 characters). Solana signature is
 * what this deployment produces; EVM hashes are still accepted because the
 * fixture and the legacy paths mint one.
 */
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/u;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/u;

function isTransactionHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (EVM_TRANSACTION_HASH.test(value) || SOLANA_SIGNATURE.test(value))
  );
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
    .find(({ value }) => isTransactionHash(value));
  if (!hashEntry || (hashEntry.key !== 'transactionHash' && candidate.success !== true)) return null;
  const hash = hashEntry.value as string;
  const result = transactionResultSchema.safeParse({
    network,
    transactionHash: hash,
    explorerUrl: explorerUrlFor(network, hash),
  });
  return result.success ? result.data : null;
}

export function createWalletAgentDefinition(): WalletAgentDefinition {
  return {
    instructions: (context) =>
      `${buildWalletAgentInstructions(context.config, context.language)}\n${CONTACT_LIST_INSTRUCTIONS}`,
    tools: (context) => [
      ...createWalletOperations(context),
      ...createRecipientMemoryOperations(context),
      ...createContactReadOperations(context),
      ...createContactActionOperations(context),
      ...createVoiceDecisionOperations(context),
    ],
  };
}

/**
 * Routing guidance for the contact read surface. It is appended by the
 * DEFINITION rather than by `buildWalletAgentInstructions`, so it is present
 * exactly when the `list_contacts` tool is: the no-provider fallback in
 * `wallet-agent.ts` (which serves the WDK tool source, not this definition)
 * must never be told about a tool it does not have.
 */
const CONTACT_LIST_INSTRUCTIONS = `- To answer "which contacts do I have?" or "who can I send to?", call list_contacts. It enumerates the user's saved contacts and returns a bounded page plus the real total. Do NOT use search_recipients to enumerate contacts: it is a similarity search and returns nothing for a broad question like that. When its result has truncated=true, tell the user the real total and that you are reading only the first page.
- list_contacts never returns an address. Never tell the user a contact's address from memory or from a list; an address reaches them only through the secure review card after they select a contact.`;

/**
 * Contact-listing bound. The default keeps a large address book from flooding
 * the model's context (and, on voice, from being read aloud in full); the
 * ceiling keeps a model that passes an enormous `limit` from doing the same.
 */
export const LIST_CONTACTS_DEFAULT_LIMIT = 20;
export const LIST_CONTACTS_MAX_LIMIT = 50;

/**
 * Model-facing `list_contacts` input. `.strict()` and NO `query`: enumerating
 * the user's contacts must not be expressed as a similarity search (see the
 * tool below). Only a bounded page size is accepted.
 */
export const listContactsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(LIST_CONTACTS_MAX_LIMIT).optional(),
  })
  .strict();
export type ListContactsInput = z.infer<typeof listContactsInputSchema>;

/** One address-free row of the contact list. Deliberately carries no address. */
export type ListedContact = {
  name: string;
  description: string;
  network: string | null;
  /** Whether the stored provenance claims an `.sns` alias (see `carriesAlias`). */
  hasAlias: boolean;
};

export type ListContactsResult = {
  status: 'listed' | 'unavailable';
  contacts: ListedContact[];
  /** The REAL count of active contacts, before the limit was applied. */
  total: number;
  /** Whether the limit cut the list (`total > contacts.length`). */
  truncated: boolean;
  limit: number;
  message?: string;
};

/**
 * Whether a contact's stored `provenance` claims an `.sns` alias — the SAME
 * predicate `contactAlias` applies in `src/api/contacts.ts` (source `sns`, a
 * non-empty `name` and a non-empty `resolvedAt`). It is reduced to a boolean
 * here: the alias is a LABEL, the list needs no timestamp, and this derivation
 * never invents a shape the contacts surface does not already have.
 */
function carriesAlias(
  provenance: Record<string, unknown> | null | undefined,
): boolean {
  if (!provenance || provenance.source !== 'sns') return false;
  const { name, resolvedAt } = provenance;
  return (
    typeof name === 'string' && name.length > 0 &&
    typeof resolvedAt === 'string' && resolvedAt.length > 0
  );
}

/**
 * `list_contacts`: enumerate the user's active contacts.
 *
 * WHY THIS IS NOT `search_recipients`
 * -----------------------------------
 * `search_recipients` is an embedding-similarity search: its schema REQUIRES a
 * non-empty `query` and its result is thresholded, so a question like "which
 * contacts do I have" has no similar neighbour and comes back empty. Passing a
 * fake query (`"*"`, `"contactos"`) would stay a similarity search asked to
 * behave as an enumeration — still threshold-dependent, still able to return
 * nothing. This tool instead reads through `ContactListPort` — the EXACT
 * `ContactsRepository.listActive` call `GET /v1/contacts` makes — so the agent
 * and the screen can never disagree about what the user's contacts are.
 *
 * NO ADDRESSES. This is a security decision, not tidiness. The change's
 * architecture routes an address to the user ONLY through the secure review
 * card (`search_recipients` strips them too), and on the voice surface a list
 * read aloud is a NEW exfiltration path: a model can be talked into reading a
 * stored address to whoever is in the room. The only way to obtain an address
 * stays selection plus the review card, so the list carries `name`,
 * `description`, `network` and `hasAlias` and nothing else.
 *
 * FAIL CLOSED. When the port is absent, or the read throws, the tool reports
 * `unavailable` with an empty list and `total: 0` — it never invents contacts,
 * never narrates "no contacts" for a store it could not read, and never throws.
 */
function createContactReadOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  const unavailable = (limit: number): ListContactsResult => ({
    status: 'unavailable',
    contacts: [],
    total: 0,
    truncated: false,
    limit,
    message: 'No puedo leer tus contactos en este momento.',
  });
  return [
    {
      name: 'list_contacts',
      description:
        'List the current user\'s saved contacts (names and descriptions only, never addresses). ' +
        'Use this to answer "which contacts do I have?" or "who can I send to?" — do NOT use search_recipients for an enumeration. ' +
        'It returns a bounded page plus `total` (the real count) and `truncated`; when `truncated` is true, tell the user the real total and that you are reading only the first page. ' +
        'To get a contact\'s address, select that contact and let the user review the secure card — never read an address from memory.',
      inputSchema: listContactsInputSchema,
      execute: async (input) => {
        const limit = (input as ListContactsInput).limit ?? LIST_CONTACTS_DEFAULT_LIMIT;
        if (!context.contacts) return unavailable(limit);
        try {
          const all = await context.contacts.listActive(context.userId);
          return {
            status: 'listed',
            contacts: all.slice(0, limit).map((contact) => ({
              name: contact.name,
              description: contact.description,
              network: contact.network ?? null,
              hasAlias: carriesAlias(contact.provenance),
            })),
            total: all.length,
            truncated: all.length > limit,
            limit,
          } satisfies ListContactsResult;
        } catch {
          return unavailable(limit);
        }
      },
    },
  ];
}

/**
 * Trusted-recipient actions are proposal-only at the model boundary. An address
 * is accepted solely through the authenticated review channel, never from a
 * model tool argument or inferred from the supplied label.
 */
function createContactActionOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  const unavailable = { status: 'address_review_required' as const, message: 'Necesito que revises y pegues la dirección en la tarjeta segura antes de guardar este destinatario.' };
  const stage = async (
    action: 'create' | 'edit' | 'remove',
    value: { contactId?: string; expectedVersion?: number; name?: string; description?: string; snsName?: string },
  ) => {
    if (!context.contactActions) return unavailable;
    return context.contactActions.stage({
      userId: context.userId,
      conversationId: context.conversationId,
      origin: context.voiceService ? 'voice' : 'text',
      action,
      ...value,
    });
  };
  return [
    {
      name: 'stage_trusted_recipient',
      description: 'Stage a new trusted recipient for the secure review card. Supply only their display name, an optional description, and — when the user gave one — the explicit .sns name they said (for example "juan.sns"); the server resolves that name and the resolved address is what the user reviews. Copy that .sns name exactly as the user gave it, character for character: never translate it, never re-spell it the way it sounds, and never invent a spelling. A spoken name arrives through transcription and may be written differently from how it is registered, so when the user says a name that is not Spanish or you heard more than one plausible spelling, ask them to spell it letter by letter BEFORE staging and stage the spelling they confirm. THEN, IF THIS TOOL ANSWERS `alias_unresolved`: stop. Do not call this tool again in that turn, do not try another spelling of the same name on your own, and do not rephrase it — you do not know which spelling is registered, so guessing again is how a name the user gave correctly never resolves. Speak the refusal sentence you were given, which names the exact spelling that failed, and ask the user to spell the name letter by letter or tell you the correct one; stage again only after they do. Never supply an address, a resolution, an inferred address, a network, policy, signer, cap, confirmation, timestamp, or turn count.',
      inputSchema: contactCreateInputSchema,
      execute: (input) => stage('create', input as z.infer<typeof contactCreateInputSchema>),
    },
    {
      name: 'stage_trusted_recipient_edit',
      description: 'Stage an edit to an already selected trusted recipient by its exact id and version. Never supply an address or policy fields.',
      inputSchema: contactChangeInputSchema,
      execute: (input) => stage('edit', input as z.infer<typeof contactChangeInputSchema>),
    },
    {
      name: 'stage_trusted_recipient_removal',
      description: 'Stage removal of an already selected trusted recipient by its exact id and version. The secure review explains any affected automatic payments.',
      inputSchema: contactChangeInputSchema,
      execute: (input) => stage('remove', input as z.infer<typeof contactChangeInputSchema>),
    },
    {
      name: 'confirm_trusted_recipient_action',
      description: 'Consumes only the exact secure proposal after authenticated user evidence. It takes proposal id and version, never an address, confirmation phrase, timestamp, or turn count. If the refusal reports a currentProposalId and currentProposalVersion, that is the proposal actually open: retry once with that exact handle instead of reusing the id you staged.',
      inputSchema: contactConfirmInputSchema,
      execute: async (input) => {
        if (!context.contactActions?.confirm) return unavailable;
        const value = input as z.infer<typeof contactConfirmInputSchema>;
        return context.contactActions.confirm({
          userId: context.userId,
          conversationId: context.conversationId,
          proposalId: value.proposalId,
          proposalVersion: value.proposalVersion,
          source: context.voiceService ? 'voice' : 'text',
        });
      },
    },
  ];
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
        return context.wallet.getAddress({
          network: parsed.network ?? DEFAULT_READ_NETWORK,
          wallet: parsed.wallet ?? context.config.wallet,
        });
      },
    },
    {
      name: 'get_balance',
      description:
        'Read wallet balances. Without arguments returns a JSON with the balance of EVERY supported network so the agent can answer any balance question in one call. With a network, returns just that network\'s balance. Never ask the user which wallet or network: the result already covers all of them — answer only what the user asked for.',
      inputSchema: balanceInputSchema,
      execute: async (input) => {
        const parsed = input as z.infer<typeof balanceInputSchema>;
        const token = parsed.token
          ? normalizeWalletToken(parsed.token, context.config.token)
          : undefined;
        // Multi-network read: omitting `network` asks for EVERY network the
        // wallet supports, so the model never needs to ask which wallet — it
        // answers only what the user asked about (user decision 2026-10-07).
        if (!parsed.network) {
          const networks = await context.wallet.listNetworks();
          const balances = await Promise.all(
            networks.map(async ({ network }) => {
              try {
                const balance = await context.wallet.getBalance({
                  network,
                  ...(token ? { token } : {}),
                  wallet: parsed.wallet ?? context.config.wallet,
                });
                const presentation = formatBalanceForAgent({
                  balance: balance.balance,
                  token: balance.token ?? token ?? context.config.token,
                  language: context.language,
                });
                return {
                  network: balance.network,
                  token: balance.token ?? token ?? context.config.token,
                  address: balance.address,
                  balance: presentation.balance,
                  balanceSpoken: presentation.balanceSpoken,
                };
              } catch (error) {
                // One network failing must never reject the whole read: the
                // model narrates the available balances plus the degraded one.
                return {
                  network,
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Balance unavailable for this network.',
                };
              }
            }),
          );
          return { balances };
        }
        const network = parsed.network;
        const balance = await context.wallet.getBalance({
          network,
          ...(token ? { token } : {}),
          wallet: parsed.wallet ?? context.config.wallet,
        });
        const presentation = formatBalanceForAgent({
          balance: balance.balance,
          token: balance.token ?? token ?? context.config.token,
          language: context.language,
        });
        return {
          ...balance,
          balance: presentation.balance,
          balanceSpoken: presentation.balanceSpoken,
        };
      },
    },
    {
      name: 'get_history',
      description: 'Read wallet transfer history.',
      inputSchema: balanceInputSchema,
      execute: async (input) => {
        const parsed = input as z.infer<typeof balanceInputSchema>;
        return context.wallet.getHistory({
          network: parsed.network ?? DEFAULT_READ_NETWORK,
          ...(parsed.token ? { token: normalizeWalletToken(parsed.token, context.config.token) } : {}),
          wallet: parsed.wallet ?? context.config.wallet,
        });
      },
    },
    {
      name: 'send_token',
      description:
        'Preview or execute a wallet transfer. For preview, supply only the amount ' +
        'and the already-resolved recipient (recipientId + recipientVersion). Never ' +
        'supply an address, network, token, wallet, or dryRun — those are resolved ' +
        'server-side. For internal confirmation, supply the full broadcast input ' +
        '(network, token, to, amount, wallet, dryRun).',
      inputSchema: sendTokenInputSchema,
      execute: async (input) => executeSendToken(input as unknown, context),
    },
    {
      name: 'create_grant',
      description:
        'Create a delegated spending grant (a pre-authorized allowance) for one ' +
        'already-resolved Solana recipient. Supply only the resolved recipient ' +
        '(recipientId + recipientVersion) and the SOL limits ' +
        '(maxPerTransferSol, maxCumulativeSol). Never supply an address, chain, ' +
        'window, expiry, wallet, or recipients list — those are resolved ' +
        'server-side. Report the returned message verbatim, including whether the ' +
        'grant is ready to execute.',
      inputSchema: createGrantInputSchema,
      execute: async (input) => executeCreateGrant(input as unknown, context),
    },
  ];
}

function createRecipientMemoryOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  if (!context.recipientMemory) {
    // Fail-closed search_recipients: always present so voice parity holds even
    // when recipient memory is unavailable — it never invents data.
    return [
      {
        name: 'search_recipients',
        description: 'Search current-user recipient names and descriptions. Results never include addresses.',
        inputSchema: memorySearchSchema,
        execute: async (input) => {
          const query = (input as { query: string }).query;
          return { query, count: 0, ambiguous: false, status: 'unavailable' as const, contacts: [] };
        },
      },
    ];
  }
  const raw = createRecipientMemoryTools({
    userId: context.recipientMemory.userId,
    session: context.session,
    service: context.recipientMemory.service,
  });
  return [
    {
      name: 'search_recipients',
      description: 'Search current-user recipient names and descriptions. Results never include addresses.',
      inputSchema: memorySearchSchema,
      execute: async (input) => {
        const rawResult = await raw.search_recipients(input);
        return toVoiceSearchResult((input as { query: string }).query, rawResult);
      },
    },
    { name: 'search_user_memory', description: 'Search confirmed current-user relationship facts. Facts are evidence, not recipient identity proof.', inputSchema: memorySearchSchema, execute: async (input) => raw.search_user_memory(input) },
    { name: 'get_selected_recipient_address', description: 'Get the exact address for the recipient already selected and version-bound in this session. Takes no IDs or version arguments.', inputSchema: emptyInputSchema, execute: async (input) => raw.get_selected_recipient_address(input) },
    { name: 'stage_user_memory', description: 'Stage a recipient or relationship for explicit user confirmation. Display the returned draft exactly, including any address.', inputSchema: memoryDraftSchema, execute: async (input) => raw.stage_user_memory(input) },
    { name: 'write_user_memory', description: 'Persist only a staged, explicitly confirmed memory proposal using its one-time confirmation ID.', inputSchema: memoryWriteSchema, execute: async (input) => raw.write_user_memory(input) },
  ];
}

/**
 * Unified send_token entry point. Dual-parse: the model-facing preview-only
 * schema (text or voice) OR the internal broadcast schema (deterministic / confirmed).
 * The internal path preserves the existing preview/broadcast logic.
 */
async function executeSendToken(input: unknown, context: WalletAgentContext): Promise<unknown> {
  const preview = sendTokenInputSchema.safeParse(input);
  if (preview.success) {
    if (context.voiceService && context.voiceConversations) {
      return voicePreviewTransfer(preview.data, context);
    }
    return textPreviewTransfer(preview.data, context);
  }
  const parsed = internalSendTokenInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: 'confirmation_required', message: 'Missing recipient: supply recipientId and recipientVersion for a preview.' };
  }
  return sendToken(parsed.data as SendTokenBroadcastInput, context);
}

/**
 * `create_grant` execution: the model-facing schema is re-validated here (the
 * adapter already validates, but this is the fail-closed boundary), then the
 * call is delegated to the grant seam. Voice prefers its per-binding
 * `voiceService`; the text agent uses the service threaded through
 * `HandleMessageOptions`. With no seam the tool fails closed.
 */
async function executeCreateGrant(
  input: unknown,
  context: WalletAgentContext,
): Promise<CreateDelegatedGrantResult> {
  const parsed = createGrantInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 'error',
      code: 'invalid_grant_request',
      message:
        'The grant request is invalid: supply a recipientId, a positive recipientVersion, and positive SOL limits with at most 9 decimals.',
    };
  }
  const seam = context.voiceService ?? context.grantService;
  if (!seam) {
    return {
      status: 'error',
      code: 'grant_creation_unavailable',
      message: 'Grant creation is unavailable in this session.',
    };
  }
  return seam.createDelegatedGrant({
    userId: context.userId,
    conversationId: context.conversationId,
    recipientId: parsed.data.recipientId,
    recipientVersion: parsed.data.recipientVersion,
    maxPerTransferSol: parsed.data.maxPerTransferSol,
    maxCumulativeSol: parsed.data.maxCumulativeSol,
  });
}

/**
 * Text-agent preview: resolve the versioned recipient, run policy,
 * call the wallet provider, and return the augmented preview.
 */
async function textPreviewTransfer(
  input: PreviewSendTokenInput,
  context: WalletAgentContext,
): Promise<unknown> {
  const resolved = await resolvePreviewRecipient(input, {
    session: context.session,
    recipientMemory: context.recipientMemory,
    config: context.config,
  });
  if (!resolved.ok) return resolved.error;
  const preview = await context.wallet.previewTransfer({
    network: resolved.internal.network,
    token: resolved.internal.token,
    to: resolved.internal.to,
    amount: resolved.internal.amount,
    wallet: resolved.internal.wallet,
  });
  return { preview: true, ...preview, network: resolved.internal.network, token: resolved.internal.token, to: resolved.internal.to, amount: resolved.internal.amount, wallet: resolved.internal.wallet };
}

/**
 * Voice preview: delegate to the per-binding conversation service which
 * persists the pending preview and revalidates the recipient. Then read
 * the preview aloud and gate on the spoken-decision evidence.
 */
async function voicePreviewTransfer(
  input: PreviewSendTokenInput,
  context: WalletAgentContext,
): Promise<RealtimeVoiceToolResult> {
  const service = context.voiceService!;
  const conversations = context.voiceConversations;
  if (!conversations) {
    return { status: 'error', code: 'wallet_unavailable', message: 'The wallet service is unavailable.' };
  }
  const result = await service.previewTransfer({
    conversationId: context.conversationId,
    userId: context.userId,
    amount: input.amount,
    recipientId: input.recipientId,
    recipientVersion: input.recipientVersion,
    ...(input.memo ? { memo: input.memo } : {}),
  });
  const output = toVoiceToolResult(result);
  if (result.status !== 'confirmation_required') return output;
  const current = await conversations.get(context.userId, context.conversationId);
  const pending = current?.pendingTransfer;
  const previewId = pending?.previewId;
  if (
    !previewId ||
    !pending ||
    pending.amount !== result.preview.amount ||
    pending.token !== result.preview.token ||
    pending.network !== result.preview.network ||
    !context.voiceDecisionGate
  ) {
    if (previewId) context.voiceDecisionGate?.clear(previewId);
    return {
      status: 'error',
      code: 'confirmation_required',
      message: 'The saved preview could not be confirmed safely. Please try again.',
    };
  }
  const recipient = context.recipientMemory
    ? await context.recipientMemory.service.getRecipientForVersion(
        context.userId,
        input.recipientId,
        input.recipientVersion,
      )
    : undefined;
  if (
    !recipient ||
    recipient.id !== input.recipientId ||
    recipient.version !== input.recipientVersion
  ) {
    context.voiceDecisionGate.clear(previewId);
    return {
      status: 'error',
      code: 'recipient_revalidation_required',
      message: 'The saved contact changed. Please select the contact again.',
    };
  }
  const state = await conversations.get(context.userId, context.conversationId);
  const language = state?.language ?? 'en';
  const networkLabel = result.preview.network === 'solana-devnet' ? 'Solana devnet' : result.preview.network;
  const fee = result.preview.estimatedFee;
  // Opens the decision window. The window is anchored to the moment the
  // preview EXISTS, not to a read-back: see voice-decision-gate.ts.
  if (!context.voiceDecisionGate.prepare(previewId)) {
    return {
      status: 'error',
      code: 'confirmation_required',
      message: 'There is another action awaiting an explicit decision. Please cancel it before preparing a transfer.',
    };
  }
  return {
    ...output,
    // This string is a tool RESULT, so it reaches the model and reads as an
    // instruction to it. The narration is the MODEL's own turn, which is the
    // only thing that reliably speaks on a realtime session — a nested
    // generateReply asking for an exact sentence produced anything but that.
    message: language === 'es'
      ? 'Decile esto al usuario, breve y cálido, y después quedate esperando: el monto, la comisión estimada y el nombre del contacto. Preguntale si confirma o cancela. No menciones herramientas, redes ni estados internos, no repitas la comisión como número crudo.'
      : 'Tell the user this briefly and warmly, then stop and wait: the amount, the estimated fee and the contact name. Ask whether to confirm or cancel. Never mention tools, networks or internal states, and never read the fee as a raw number.',
    recipientName: recipient.name,
    estimatedFee: fee,
    network: networkLabel,
  };
}

  /**
   * User-facing copy for the voice decision gate, in the session language.
   *
   * These lines are SPOKEN to the user, so they say what happened and what to
   * do next, in plain words. They never name a tool, a code or an internal
   * state: the user asked for money to move, not for a status report.
   */
  function decisionCopy(language: 'es' | 'en') {
    return language === 'es'
      ? {
          noPreview: 'Todavía no hay ninguna transferencia preparada. Decime a quién y cuánto querés mandarle.',
          notYet: 'Decile el monto, la comisión y a quién le vas a mandar, y preguntale si confirma o cancela. Todavía no te dijo que sí.',
        }
      : {
          noPreview: 'There is no transfer ready yet. Tell me who to pay and how much.',
          notYet: 'Say the amount, the fee and who it goes to, and ask whether to confirm or cancel. The user has not agreed yet.',
        };
  }

  /** Ported decideTransfer logic from create-realtime-tools.ts. */
  async function decideTransfer(
    decision: 'confirm' | 'cancel',
    context: WalletAgentContext,
  ): Promise<RealtimeVoiceToolResult> {
    if (!context.voiceService || !context.voiceConversations) {
      return { status: 'error', code: 'wallet_unavailable', message: 'The wallet service is unavailable.' };
    }
    const conversations = context.voiceConversations;
    const snapshot = await conversations.get(context.userId, context.conversationId);
    const previewId = snapshot?.pendingTransfer?.previewId;
    const language = snapshot?.language ?? 'en';
    if (!previewId) {
      return { status: 'error', code: 'stale_preview', message: decisionCopy(language).noPreview };
    }
    if (!await context.voiceDecisionGate?.waitAndConsume(previewId, decision)) {
      // The refusal is almost always one of two things: the user has not
      // answered the preview yet, or they said something affirmative
      // BEFORE it existed (for example "sí, mandale 5" to the instruction
      // that created it). Either way the recovery is the same: say the
      // preview and let them answer, so the message tells them that instead
      // of naming an internal state.
      return {
        status: 'error',
        code: 'confirmation_required',
        message: decisionCopy(language).notYet,
      };
    }
  let result: ConversationTurnResult | undefined;
  const iterable = context.voiceService.resolveDecision({
    conversationId: context.conversationId,
    userId: context.userId,
    previewId,
    decision,
    waitForFinancialTask: decision === 'confirm',
  });
  for await (const event of iterable) {
    if (event.type === 'turn-completed') result = event.result;
  }
  if (!result) {
    return { status: 'error', code: 'internal_error', message: 'The transfer could not be resolved.' };
  }
  return toVoiceToolResult(result);
}

/**
 * Voice-only operations (confirm/cancel) produced only for a voice context.
 * When the gate is absent the tools still exist but fail-closed to
 * `confirmation_required`.
 */
function createVoiceDecisionOperations(context: WalletAgentContext): AgentToolDefinition<unknown, unknown>[] {
  if (!context.voiceService || !context.voiceConversations) return [];
  return [
    {
      name: 'confirm_transfer',
      description:
        'Confirms the current transfer only after a fresh final spoken confirmation following the preview. It acts ONLY on a preview that send_token created in THIS SAME conversation: without that preview it fails, and the recovery is to call send_token, never to insist. A "yes" answering any other question is not a transfer confirmation. A model tool call is not authorization. Takes no parameters.',
      inputSchema: emptyInputSchema,
      execute: () => decideTransfer('confirm', context),
    },
    {
      name: 'cancel_transfer',
      description:
        'Cancels the current transfer only after a fresh final spoken cancellation following the preview. Takes no parameters.',
      inputSchema: emptyInputSchema,
      execute: () => decideTransfer('cancel', context),
    },
  ];
}

async function sendToken(input: SendTokenBroadcastInput, context: WalletAgentContext): Promise<unknown> {
  const normalized = { ...input, token: normalizeWalletToken(input.token, context.config.token) };
  if (normalized.dryRun) {
    const recipientError = await validatePreviewRecipient(normalized, context);
    if (recipientError) return recipientError;
  }
  const request: TransferRequest = {
    network: normalized.network,
    token: normalized.token,
    to: normalized.to,
    amount: normalized.amount,
    wallet: normalized.wallet,
    ...(normalized.previewId ? { previewId: normalized.previewId } : {}),
  };
  if (normalized.dryRun) return { preview: true, ...await context.wallet.previewTransfer(request) };
  const outcome = await context.wallet.broadcastTransfer(request);
  if (outcome.kind === 'submitted') return outcome.transaction;
  // The provider states WHY it did not dispatch, and the two reasons need
  // opposite copy: a policy refusal is permanent, an outage is temporary.
  // `notDispatchedErrorCode` is the single cause→code mapper (shared with the
  // conversation service); `safeErrorMessage` is the single localized copy.
  const code: ConversationErrorCode =
    outcome.kind === 'uncertain'
      ? 'broadcast_uncertain'
      : notDispatchedErrorCode(outcome.cause);
  return {
    error: code,
    // This `message` is what the model is told to narrate, so it must be the
    // localized safe copy and never the provider's internal diagnostic (which
    // was previously narrated verbatim to a Spanish-speaking user).
    message: safeErrorMessage(code, context.language),
    // The diagnostic is not lost, it is just kept off the narrated message.
    cause: outcome.reason,
  };
}

async function validatePreviewRecipient(
  input: SendTokenInput,
  context: WalletAgentContext,
): Promise<{ error: 'recipient_revalidation_required'; message: string } | undefined> {
  const selected = context.session.recipientMemory?.selectedRecipient;
  if (context.session.recipientMemory?.recipientSelectionRequired && !selected) {
    return {
      error: 'recipient_revalidation_required',
      message: 'Recipient changed or is no longer valid; resolve the recipient again.',
    };
  }
  if (!selected) {
    if (context.session.recipientMemory?.previewedRecipient) {
      context.session.recipientMemory.previewedRecipient = undefined;
    }
    return undefined;
  }
  if (!context.recipientMemory) {
    invalidateSelectedRecipient(context.session);
    return {
      error: 'recipient_revalidation_required',
      message: 'Recipient memory is unavailable; resolve the recipient again before previewing.',
    };
  }
  const current = await context.recipientMemory.service.getRecipientForVersion(
    context.recipientMemory.userId,
    selected.recipientId,
    selected.version,
  );
  if (
    !current ||
    current.id !== selected.recipientId ||
    current.version !== selected.version ||
    !isValidRecipientAddress(current.address, current.network) ||
    current.address !== input.to
  ) {
    invalidateSelectedRecipient(context.session);
    return {
      error: 'recipient_revalidation_required',
      message: 'Recipient changed or is no longer valid; resolve the recipient again.',
    };
  }
  context.session.recipientMemory!.previewedRecipient = selected;
  return undefined;
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
