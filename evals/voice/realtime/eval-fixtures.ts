/**
 * Offline fixture stack for the realtime voice-tool eval and its unit tests.
 *
 * Builds the complete dependency graph that `createRealtimeTools` closes over,
 * without any network, database, or live wallet:
 *  - an in-memory `ConversationRepository` seeded with a user + conversation
 *    snapshot,
 *  - a `RecipientMemoryService` stub whose contact book contains two contacts,
 *    including `Mamá` (valid EVM address), and which can resolve by id/version,
 *  - a `FixtureWalletProvider` wrapped in a spy that records every `broadcastTransfer`,
 *  - a `WalletConversationService` built with `memory: { userId, service }` at the
 *    service level (so `previewTransfer` and `resolveDecision` can revalidate),
 *  - `createRealtimeTools` over that stack.
 *
 * A hard guard runs at construction: `wallet.mode === 'fixture'` must hold, otherwise
 * the stack throws. This guarantees the env-selected live wallet can never leak into
 * the offline fixtures.
 */
import type { ModelMessage } from 'ai';
import type { PendingTransfer, TransferPreview } from '../../../src/contracts/http.js';
import { FixtureWalletProvider } from '../../../src/wallet/fixture-provider.js';
import type { WalletProvider, TransferRequest } from '../../../src/wallet/provider.js';
import {
  createWalletConversationService,
  type WalletConversationService,
} from '../../../src/conversations/service.js';
import type { ConversationRepository } from '../../../src/conversations/repository.js';
import type {
  ConversationSnapshot,
  ConversationState,
  PendingTransferClaim,
  WalletProgress,
} from '../../../src/conversations/types.js';
import type {
  RecipientMemoryService,
  RecipientSearchResult,
} from '../../../src/memory/service.js';
import type {
  RecipientCandidate,
  RecipientRecord,
} from '../../../src/memory/types.js';
import {
  createRealtimeTools,
  type RealtimeToolsDependencies,
} from '../../../src/livekit/realtime-tools/index.js';

export const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MAMA_ADDRESS = '0x1111111111111111111111111111111111111111';
export const MAMA_RECIPIENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const MAMA_RECIPIENT_VERSION = 2;

const PAPA_ADDRESS = '0x2222222222222222222222222222222222222222';

// ---------------------------------------------------------------------------
// In-memory conversation repository
// ---------------------------------------------------------------------------

function previewIdFor(): string {
  return crypto.randomUUID();
}

/**
 * A minimal in-memory `ConversationRepository` seeded with one conversation for the
 * given user. Implements the full interface so the service can preview, claim,
 * broadcast, and finalize a transfer entirely in memory.
 */
export function createInMemoryConversationRepository(
  userId: string,
  conversationId: string,
): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: conversationId,
    userId,
    mode: 'typed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: 'es',
    generation: 1,
    messages: [],
  };
  let transferStatus:
    | 'previewed'
    | 'broadcasting'
    | 'submitted'
    | 'uncertain'
    | 'confirmed'
    | 'reverted'
    | 'receipt_invalid'
    | 'cancelled'
    | undefined;

  const repository: ConversationRepository = {
    async create() {
      return snapshot;
    },
    async get(requestUserId: string, id: string) {
      return requestUserId === userId && id === conversationId
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined;
    },
    async inspect(requestUserId: string, id: string) {
      return this.get(requestUserId, id);
    },
    async appendMessage(_requestUserId, _id, message: ModelMessage) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(_requestUserId, incoming: ConversationSnapshot, _count) {
      snapshot = {
        ...incoming,
        pendingTransfer: incoming.pendingTransfer
          ? { ...incoming.pendingTransfer, previewId: incoming.pendingTransfer.previewId ?? previewIdFor() }
          : undefined,
        revision: incoming.revision + 1,
      };
      if (snapshot.pendingTransfer) transferStatus = 'previewed';
      return snapshot;
    },
    async updateState(_requestUserId, _id, _revision, state: ConversationState) {
      snapshot = { ...snapshot, ...state, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setProgress(_requestUserId, _id, progress: WalletProgress) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setPendingTransfer(_requestUserId, _id, transfer: NonNullable<ConversationSnapshot['pendingTransfer']>) {
      snapshot = {
        ...snapshot,
        pendingTransfer: { ...transfer, previewId: transfer.previewId ?? previewIdFor() },
        revision: snapshot.revision + 1,
      };
      transferStatus = 'previewed';
      return snapshot;
    },
    async clearPendingTransfer() {
      transferStatus = 'cancelled';
      snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async cancelPendingTransfer(_requestUserId, _id, previewId: string) {
      if (transferStatus !== 'previewed' || snapshot.pendingTransfer?.previewId !== previewId) {
        return 'stale_preview' as const;
      }
      transferStatus = 'cancelled';
      snapshot = { ...snapshot, pendingTransfer: undefined, revision: snapshot.revision + 1 };
      return 'cancelled' as const;
    },
    async claimPendingTransfer() {
      if (!snapshot.pendingTransfer) return { status: 'missing' as const };
      if (transferStatus === 'broadcasting') return { status: 'broadcasting' as const };
      if (transferStatus === 'uncertain') return { status: 'uncertain' as const };
      transferStatus = 'broadcasting';
      snapshot = { ...snapshot, transferResolutionState: 'broadcasting', revision: snapshot.revision + 1 };
      const claimed = snapshot.pendingTransfer;
      if (!claimed) return { status: 'missing' as const };
      return { status: 'claimed' as const, transfer: { ...claimed, previewId: claimed.previewId! } };
    },
    async releasePendingTransferClaim() {
      transferStatus = 'previewed';
      snapshot = { ...snapshot, transferResolutionState: undefined };
    },
    async markPendingTransferUncertain() {
      transferStatus = 'uncertain';
      snapshot = { ...snapshot, transferResolutionState: 'uncertain', revision: snapshot.revision + 1 };
    },
    async setLastTransactionHash(_requestUserId, _id, hash: string) {
      snapshot = { ...snapshot, lastTransactionHash: hash };
    },
    async markTransferSubmitted(_requestUserId, _id, hash: string) {
      transferStatus = 'submitted';
      snapshot = { ...snapshot, lastTransactionHash: hash, revision: snapshot.revision + 1 };
    },
    async finalizeTransfer(_requestUserId, _id, result: { status: 'confirmed' | 'reverted' | 'receipt_invalid'; transactionHash: string }) {
      transferStatus = result.status;
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        lastTransactionHash: result.transactionHash,
        revision: snapshot.revision + 1,
      };
    },
    async setMode() {
      return snapshot.revision + 1;
    },
    async acquireLiveLease() {
      throw new Error('not used in the realtime fixture stack');
    },
    async renewLiveLease() {
      return false;
    },
    async releaseLiveLease() {
      return false;
    },
  };

  return repository as ConversationRepository;
}

// ---------------------------------------------------------------------------
// Recipient memory stub
// ---------------------------------------------------------------------------

function toCandidate(record: RecipientRecord): RecipientCandidate {
  return {
    id: record.id,
    name: record.name,
    normalizedName: record.normalizedName,
    description: record.description,
    version: record.version,
    status: record.status,
    embeddingModelRevision: record.embeddingModelRevision,
    evidence: record.name,
    score: 1,
  };
}

/**
 * A deterministic `RecipientMemoryService` stub with a two-contact book (Mamá +
 * Papá). `searchRecipients` resolves a single exact name match; `getRecipientForVersion`
 * returns the record when id + version agree. Both return `undefined`/`no_match`
 * otherwise, mirroring the real service's fail-closed behavior.
 */
export function createRecipientMemoryStub(): RecipientMemoryService {
  const records: RecipientRecord[] = [
    {
      id: MAMA_RECIPIENT_ID,
      userId: FIXTURE_USER_ID,
      name: 'Mamá',
      normalizedName: 'mamá',
      description: 'Mi mamá',
      address: MAMA_ADDRESS,
      version: MAMA_RECIPIENT_VERSION,
      status: 'active',
      embeddingModelRevision: 'fixture',
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc-dad',
      userId: FIXTURE_USER_ID,
      name: 'Papá',
      normalizedName: 'papá',
      description: 'Mi papá',
      address: PAPA_ADDRESS,
      version: 1,
      status: 'active',
      embeddingModelRevision: 'fixture',
    },
  ];

  const service = {
    async searchRecipients(userId: string, query: string): Promise<RecipientSearchResult> {
      if (userId !== FIXTURE_USER_ID) return { status: 'no_match', candidates: [] };
      const normalized = query.trim().toLocaleLowerCase('en-US');
      const matches = records.filter((record) => record.normalizedName === normalized);
      if (matches.length === 1) {
        const recipient = toCandidate(matches[0]!);
        return { status: 'resolved', candidates: [recipient], recipient };
      }
      if (matches.length > 1) {
        return { status: 'clarification_required', candidates: matches.map(toCandidate) };
      }
      return { status: 'no_match', candidates: [] };
    },
    async getRecipientForVersion(
      userId: string,
      recipientId: string,
      expectedVersion: number,
    ): Promise<RecipientRecord | undefined> {
      if (userId !== FIXTURE_USER_ID) return undefined;
      const record = records.find(
        (candidate) => candidate.id === recipientId && candidate.version === expectedVersion,
      );
      return record;
    },
  };

  return service as RecipientMemoryService;
}

// ---------------------------------------------------------------------------
// Wallet spy + fixture stack
// ---------------------------------------------------------------------------

/**
 * Wraps a `WalletProvider` so every `broadcastTransfer` call is recorded. All other
 * methods delegate to the underlying provider.
 */
export function createBroadcastSpy(
  provider: WalletProvider,
): { wallet: WalletProvider; broadcastCalls: TransferRequest[] } {
  const broadcastCalls: TransferRequest[] = [];
  // Class methods live on the prototype, so a plain spread copies nothing.
  // A proxy forwards every method (bound) and only intercepts broadcasts.
  const wallet: WalletProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'broadcastTransfer') {
        return async (request: TransferRequest) => {
          broadcastCalls.push(request);
          return target.broadcastTransfer(request);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { wallet: wallet as WalletProvider, broadcastCalls };
}

function assertFixtureWallet(wallet: WalletProvider): void {
  if ((wallet as { mode?: string }).mode !== 'fixture') {
    throw new Error(
      'Realtime eval fixtures require a FixtureWalletProvider (wallet.mode === "fixture"); refusing a live-selected wallet.',
    );
  }
}

export type RealtimeFixtureStack = {
  userId: string;
  conversationId: string;
  repository: ConversationRepository;
  service: WalletConversationService;
  wallet: WalletProvider;
  broadcastCalls: TransferRequest[];
  recipientMemory: RecipientMemoryService;
  tools: ReturnType<typeof createRealtimeTools>;
  deps: RealtimeToolsDependencies;
};

export type RealtimeFixtureOptions = {
  userId?: string;
  conversationId?: string;
  /** Override the wallet. The mode guard still runs; a non-fixture wallet throws. */
  wallet?: WalletProvider;
};

/**
 * Builds the full offline stack for one conversation. Throws if the wallet is not a
 * `FixtureWalletProvider` (mode !== 'fixture').
 */
export function createRealtimeFixtureStack(
  options: RealtimeFixtureOptions = {},
): RealtimeFixtureStack {
  const userId = options.userId ?? FIXTURE_USER_ID;
  const conversationId = options.conversationId ?? FIXTURE_CONVERSATION_ID;
  const repository = createInMemoryConversationRepository(userId, conversationId);
  const recipientMemory = createRecipientMemoryStub();

  const baseWallet = options.wallet ?? new FixtureWalletProvider();
  assertFixtureWallet(baseWallet);
  const { wallet, broadcastCalls } = createBroadcastSpy(baseWallet);

  const service = createWalletConversationService({
    conversations: repository,
    wallet,
    memory: { userId, service: recipientMemory },
  });

  const deps: RealtimeToolsDependencies = {
    conversationId,
    userId,
    wallet,
    recipientMemory,
    service,
    conversations: repository,
  };
  const tools = createRealtimeTools(deps);

  return {
    userId,
    conversationId,
    repository,
    service,
    wallet,
    broadcastCalls,
    recipientMemory,
    tools,
    deps,
  };
}

// Re-export a couple of types used by callers for ergonomics.
export type { TransferPreview, PendingTransfer };
