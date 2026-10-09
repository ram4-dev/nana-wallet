import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletConversationService, type ConversationEvent, type ConversationProgressPublisher } from '../../src/conversations/service.js';
import { safeErrorMessage, type ConversationErrorCode } from '../../src/conversations/errors.js';
import type { ConversationRepository } from '../../src/conversations/repository.js';
import type { ConversationSnapshot, ConversationState, WalletProgress } from '../../src/conversations/types.js';
import type { ConversationTurnResult, PendingTransfer } from '../../src/contracts/http.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';
import type { BroadcastOutcome, WalletProvider } from '../../src/wallet/provider.js';
import { FinancialTaskRegistry } from '../../src/conversations/financial-task-registry.js';

const userId = '11111111-1111-4111-8111-111111111111';
const recipient = '0x1234567890123456789012345678901234567890';
const solanaRecipient = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const recipientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function repositoryFixture(initialTransfer?: PendingTransfer, language: 'es' | 'en' = 'es'): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId,
    mode: 'typed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language,
    generation: 1,
    messages: [],
    ...(initialTransfer ? { pendingTransfer: { ...initialTransfer, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } : {}),
  };
  let transferStatus: 'previewed' | 'broadcasting' | 'submitted' | 'uncertain' | 'confirmed' | 'reverted' | 'receipt_invalid' | 'cancelled' | undefined = initialTransfer ? 'previewed' : undefined;

  const repository = {
    async create() { return snapshot; },
    async get(requestUserId: string, id: string) {
      return requestUserId === userId && id === snapshot.id ? { ...snapshot, messages: [...snapshot.messages] } : undefined;
    },
    async inspect(requestUserId: string, id: string) { return this.get(requestUserId, id); },
    async appendMessage(_requestUserId: string, _id: string, message: ConversationSnapshot['messages'][number]) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(_requestUserId: string, incoming: ConversationSnapshot, _count: number) {
      snapshot = {
        ...incoming,
        pendingTransfer: incoming.pendingTransfer
          ? { ...incoming.pendingTransfer, previewId: incoming.pendingTransfer.previewId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
          : undefined,
        revision: incoming.revision + 1,
      };
      transferStatus = snapshot.pendingTransfer ? 'previewed' : transferStatus;
      return snapshot;
    },
    async updateState(_requestUserId: string, _id: string, _revision: number, state: ConversationState) {
      snapshot = { ...snapshot, ...state, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setProgress(_requestUserId: string, _id: string, progress: WalletProgress) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setPendingTransfer(_requestUserId: string, _id: string, transfer: NonNullable<ConversationSnapshot['pendingTransfer']>) {
      snapshot = { ...snapshot, pendingTransfer: { ...transfer, previewId: transfer.previewId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, revision: snapshot.revision + 1 };
      transferStatus = 'previewed';
      return snapshot;
    },
    async clearPendingTransfer() { transferStatus = 'cancelled'; snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, revision: snapshot.revision + 1 }; return snapshot; },
    async cancelPendingTransfer(_requestUserId: string, _id: string, previewId: string) {
      if (transferStatus !== 'previewed' || snapshot.pendingTransfer?.previewId !== previewId) return 'stale_preview' as const;
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
      const claimedTransfer = snapshot.pendingTransfer;
      if (!claimedTransfer) return { status: 'missing' as const };
      return { status: 'claimed' as const, transfer: { ...claimedTransfer, previewId: claimedTransfer.previewId! } };
    },
    async releasePendingTransferClaim() { transferStatus = 'previewed'; snapshot = { ...snapshot, transferResolutionState: undefined }; },
    async markPendingTransferUncertain() { transferStatus = 'uncertain'; snapshot = { ...snapshot, transferResolutionState: 'uncertain', revision: snapshot.revision + 1 }; },
    async setLastTransactionHash(_requestUserId: string, _id: string, hash: string) { snapshot = { ...snapshot, lastTransactionHash: hash }; },
    async markTransferSubmitted(_requestUserId: string, _id: string, hash: string) { transferStatus = 'submitted'; snapshot = { ...snapshot, lastTransactionHash: hash, revision: snapshot.revision + 1 }; },
    async finalizeTransfer(_requestUserId: string, _id: string, result: { status: 'confirmed' | 'reverted' | 'receipt_invalid'; transactionHash: string }) {
      transferStatus = result.status;
      snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, lastTransactionHash: result.transactionHash, revision: snapshot.revision + 1 };
    },
    async setMode() { return snapshot.revision + 1; },
    async acquireLiveLease() { throw new Error('not used'); },
    async renewLiveLease() { return false; },
    async releaseLiveLease() { return false; },
  };

  return repository as unknown as ConversationRepository;
}

function walletFixture(): WalletProvider {
  return new FixtureWalletProvider();
}

async function events(service: ReturnType<typeof createWalletConversationService>, input: Parameters<ReturnType<typeof createWalletConversationService>['handleTurnStream']>[0]): Promise<ConversationEvent[]> {
  const result: ConversationEvent[] = [];
  for await (const event of service.handleTurnStream(input)) result.push(event);
  return result;
}

describe('WalletConversationService', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;

  beforeEach(() => {
    process.env.AGENT_RUNTIME = 'deterministic';
  });

  it('streams a canonical preview through the injected wallet provider', async () => {
    const repository = repositoryFixture();
    const service = createWalletConversationService({ conversations: repository, wallet: walletFixture() });
    const streamed = await events(service, { conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'spoken-segment', reason: 'started' }));
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'spoken-segment', reason: 'decision' }));
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'turn-completed', result: expect.objectContaining({ status: 'confirmation_required', preview: expect.objectContaining({ recipient, amount: '10', token: 'SOL' }) }) }));
  });

  it('clarifies an incomplete financial turn before invoking the provider', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const preview = vi.spyOn(wallet, 'previewTransfer');
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      clock: { now: () => 1_000 },
    });

    const result = await service.handleTurn({
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId,
      text: 'Send 10 to Ana',
    });

    expect(result).toMatchObject({ status: 'clarification_required' });
    expect(preview).not.toHaveBeenCalled();
  });

  it('atomically resolves a preview and persists a trustworthy terminal result', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    const preview = await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    expect(preview.status).toBe('confirmation_required');
    const resolved = await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' });
    expect(resolved).toMatchObject({ status: 'sent', transaction: { transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u) } });
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('fails closed when the provider cannot establish broadcast evidence', async () => {
    // An English session: this assertion pins the frozen ENGLISH copy (the
    // Spanish copy of the same code is pinned in the language describe below).
    const repository = repositoryFixture(undefined, 'en');
    const wallet = walletFixture();
    vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue({ kind: 'uncertain', reason: 'provider detail must stay private' });
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirm the transfer' })).resolves.toMatchObject({ status: 'error', code: 'broadcast_uncertain', message: expect.stringContaining('uncertain') });
  });

  describe('not_dispatched cause mapping', () => {
    // The provider states WHY it refused. A policy refusal is definitive and
    // can never succeed on retry, so telling the user the wallet is
    // "temporarily unavailable" is a lie that invites a pointless retry.
    async function confirmWith(
      outcome: Extract<BroadcastOutcome, { kind: 'not_dispatched' }>,
    ) {
      const repository = repositoryFixture();
      const wallet = walletFixture();
      vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue(outcome);
      const service = createWalletConversationService({ conversations: repository, wallet });
      await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
      return service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' });
    }

    it('reports a policy refusal as policy_rejected, never wallet_unavailable', async () => {
      const result = await confirmWith({
        kind: 'not_dispatched',
        reason: 'Privy denied the Solana dispatch by policy (policy_violation).',
        cause: 'policy_rejected',
      });

      // The session is Spanish (the confirm turn is Spanish), so the refusal
      // the user reads must be Spanish too.
      expect(result).toMatchObject({
        status: 'error',
        code: 'policy_rejected',
        message: 'La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.',
      });
      expect(result.message).not.toBe('This transfer does not meet the wallet safety policy.');
      // The provider's own detail is diagnostic context, never user copy.
      expect(result.message).not.toMatch(/Privy|policy_violation/);
    });

    it('keeps provider_unavailable mapped to wallet_unavailable', async () => {
      const result = await confirmWith({
        kind: 'not_dispatched',
        reason: 'The wallet provider is down.',
        cause: 'provider_unavailable',
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'wallet_unavailable',
        message: 'La billetera no está disponible en este momento. Probá de nuevo en un rato.',
      });
      expect(result.message).not.toBe('The wallet is temporarily unavailable.');
      expect(result.message).not.toMatch(/provider is down/);
    });

    it('reports our own malformed request as internal_error, not as a wallet fault', async () => {
      const result = await confirmWith({
        kind: 'not_dispatched',
        reason: 'A persisted preview ID is required before signing.',
        cause: 'invalid_request',
      });

      // invalid_tool_result would blame the wallet ("The wallet returned an
      // invalid transfer result") for a request WE built.
      expect(result).toMatchObject({
        status: 'error',
        code: 'internal_error',
        message: 'No pude completar la conversación.',
      });
      expect(result.message).not.toBe('The conversation could not be completed.');
      expect(result.message).not.toMatch(/preview ID/);
    });
  });

  describe('Spanish spoken copy for conversation errors', () => {
    const ENGLISH_POLICY_REFUSAL = 'This transfer does not meet the wallet safety policy.';
    const ENGLISH_WALLET_UNAVAILABLE = 'The wallet is temporarily unavailable.';
    // Retry guidance: the temporary outage MUST invite a retry, the permanent
    // policy refusal MUST NOT.
    const RETRY_GUIDANCE = /prob[áa]|intent[áa]|de nuevo|otra vez/iu;

    // The error copy for an `es` session is published by the financial result
    // path (runFinancialTransfer), so the observable seam is the progress
    // publisher — the same channel the UI speaks. Filtering on reason "result"
    // isolates exactly the localized result copy.
    async function spokenResultLines(
      outcome: Extract<BroadcastOutcome, { kind: 'not_dispatched' }>,
    ): Promise<string[]> {
      const repository = repositoryFixture();
      const wallet = walletFixture();
      vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue(outcome);
      const published: ConversationEvent[] = [];
      const progress: ConversationProgressPublisher = {
        publish: (event) => { published.push(event); },
      };
      const service = createWalletConversationService({ conversations: repository, wallet, progress });
      await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
      await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' });
      return published
        .filter((event): event is Extract<ConversationEvent, { type: 'spoken-segment' }> => event.type === 'spoken-segment' && event.reason === 'result')
        .map((event) => event.text);
    }

    it('speaks a policy refusal in Spanish, never the English safe message', async () => {
      const spoken = await spokenResultLines({
        kind: 'not_dispatched',
        reason: 'Privy denied the Solana dispatch by policy (policy_violation).',
        cause: 'policy_rejected',
      });

      const line = spoken.join(' ');
      expect(line).toMatch(/no se realiz/iu);
      expect(spoken).not.toContain(ENGLISH_POLICY_REFUSAL);
    });

    it('distinguishes a permanent policy refusal from a temporary outage in Spanish', async () => {
      const refusal = await spokenResultLines({
        kind: 'not_dispatched',
        reason: 'Privy denied the Solana dispatch by policy (policy_violation).',
        cause: 'policy_rejected',
      });
      const outage = await spokenResultLines({
        kind: 'not_dispatched',
        reason: 'The wallet provider is down.',
        cause: 'provider_unavailable',
      });

      const refusalLine = refusal.join(' ');
      const outageLine = outage.join(' ');

      expect(refusalLine).not.toBe(outageLine);
      // The refusal is final: it never invites the user to retry.
      expect(refusalLine).not.toMatch(RETRY_GUIDANCE);
      // The outage is temporary: it does invite a retry.
      expect(outageLine).toMatch(RETRY_GUIDANCE);
      expect(outageLine).not.toContain(ENGLISH_WALLET_UNAVAILABLE);
    });

    it('speaks a malformed request as a Spanish internal error, never the English safe message', async () => {
      const spoken = await spokenResultLines({
        kind: 'not_dispatched',
        reason: 'A persisted preview ID is required before signing.',
        cause: 'invalid_request',
      });

      expect(spoken.join(' ')).toMatch(/no pude completar la conversación/iu);
      expect(spoken).not.toContain('The conversation could not be completed.');
    });
  });

  describe('language-aware result messages', () => {
    // The frontend renders `turn.message` verbatim into an otherwise Spanish
    // screen, so the backend must send the SESSION language. These expected
    // strings are pinned by hand on purpose: a silent English default here is
    // the defect these tests exist to catch.
    const ENGLISH_CONFIRMED = 'Transfer confirmed.';
    const ENGLISH_CANCELLED = 'Transfer cancelled.';
    const ENGLISH_POLICY_REFUSAL = 'This transfer does not meet the wallet safety policy.';
    const ENGLISH_WALLET_UNAVAILABLE = 'The wallet is temporarily unavailable.';
    const ENGLISH_INTERNAL = 'The conversation could not be completed.';
    const ENGLISH_BROADCAST_UNCERTAIN =
      'The broadcast result is uncertain. Check the wallet history before taking another action.';

    const SPANISH_CONFIRMED = 'La transferencia quedó confirmada.';
    const SPANISH_CANCELLED = 'Transferencia cancelada.';
    const SPANISH_POLICY_REFUSAL =
      'La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.';
    const SPANISH_WALLET_UNAVAILABLE =
      'La billetera no está disponible en este momento. Probá de nuevo en un rato.';
    const SPANISH_BROADCAST_UNCERTAIN =
      'No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.';

    // Retry guidance: the temporary outage MUST invite a retry, the permanent
    // policy refusal MUST NOT.
    const RETRY_GUIDANCE = /prob[áa]|intent[áa]|de nuevo|otra vez/iu;
    // "temporarily": the outage IS temporary, the refusal is not.
    const TEMPORARY_MARKER = /temporar/iu;

    const refusalOutcome: Extract<BroadcastOutcome, { kind: 'not_dispatched' }> = {
      kind: 'not_dispatched',
      reason: 'Privy denied the Solana dispatch by policy (policy_violation).',
      cause: 'policy_rejected',
    };
    const outageOutcome: Extract<BroadcastOutcome, { kind: 'not_dispatched' }> = {
      kind: 'not_dispatched',
      reason: 'The wallet provider is down.',
      cause: 'provider_unavailable',
    };
    const malformedOutcome: Extract<BroadcastOutcome, { kind: 'not_dispatched' }> = {
      kind: 'not_dispatched',
      reason: 'A persisted preview ID is required before signing.',
      cause: 'invalid_request',
    };

    const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    // Both turn texts match the session language, so the language detector
    // cannot flip the session while the transfer is being resolved.
    async function transferredResult(
      language: 'es' | 'en',
      outcome?: Extract<BroadcastOutcome, { kind: 'not_dispatched' }>,
    ): Promise<ConversationTurnResult> {
      const repository = repositoryFixture(undefined, language);
      const wallet = walletFixture();
      if (outcome) vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue(outcome);
      const service = createWalletConversationService({ conversations: repository, wallet });
      await service.handleTurn({ conversationId, userId, text: `Send 10 USDT to ${recipient}` });
      return service.handleTurn({
        conversationId,
        userId,
        text: language === 'es' ? 'confirmar la transferencia' : 'confirm the transfer',
      });
    }

    async function cancelledResult(language: 'es' | 'en'): Promise<ConversationTurnResult> {
      const repository = repositoryFixture(undefined, language);
      const wallet = walletFixture();
      const service = createWalletConversationService({ conversations: repository, wallet });
      await service.handleTurn({ conversationId, userId, text: `Send 10 USDT to ${recipient}` });
      return service.handleTurn({
        conversationId,
        userId,
        text: language === 'es' ? 'cancelar la transferencia' : 'cancel the transfer',
      });
    }

    it('reports the completed transfer in Spanish for an es session, never the English money message', async () => {
      const result = await transferredResult('es');

      expect(result).toMatchObject({ status: 'sent', message: SPANISH_CONFIRMED });
      expect(result.message).not.toBe(ENGLISH_CONFIRMED);
    });

    it('reports the cancellation in Spanish for an es session', async () => {
      const result = await cancelledResult('es');

      expect(result).toEqual({ status: 'cancelled', message: SPANISH_CANCELLED });
      expect(result.message).not.toBe(ENGLISH_CANCELLED);
    });

    it('reports a policy refusal in Spanish for an es session, never the English copy', async () => {
      const result = await transferredResult('es', refusalOutcome);

      expect(result).toMatchObject({
        status: 'error',
        code: 'policy_rejected',
        message: SPANISH_POLICY_REFUSAL,
      });
      expect(result.message).not.toBe(ENGLISH_POLICY_REFUSAL);
    });

    it('reports a temporary outage in Spanish for an es session, never the English copy', async () => {
      const result = await transferredResult('es', outageOutcome);

      expect(result).toMatchObject({
        status: 'error',
        code: 'wallet_unavailable',
        message: SPANISH_WALLET_UNAVAILABLE,
      });
      expect(result.message).not.toBe(ENGLISH_WALLET_UNAVAILABLE);
    });

    it('reports an uncertain broadcast in Spanish for an es session', async () => {
      const repository = repositoryFixture();
      const wallet = walletFixture();
      vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue({
        kind: 'uncertain',
        reason: 'provider detail must stay private',
      });
      const service = createWalletConversationService({ conversations: repository, wallet });
      await service.handleTurn({ conversationId, userId, text: `Send 10 USDT to ${recipient}` });
      const result = await service.handleTurn({
        conversationId,
        userId,
        text: 'confirmar la transferencia',
      });

      expect(result).toMatchObject({
        status: 'error',
        code: 'broadcast_uncertain',
        message: SPANISH_BROADCAST_UNCERTAIN,
      });
      // The warning that matters must survive localization: check history
      // before trying another transfer.
      expect(result.message).toMatch(/historial/iu);
      expect(result.message).not.toBe(ENGLISH_BROADCAST_UNCERTAIN);
    });

    it('lets the persisted session language govern the decision path, which carries no turn text', async () => {
      // The voice path resolves a decision with no user text at all, so the
      // stored session language is the only thing the copy can follow.
      const repository = repositoryFixture(undefined, 'es');
      const wallet = walletFixture();
      const service = createWalletConversationService({ conversations: repository, wallet });
      await service.handleTurn({ conversationId, userId, text: `Send 10 USDT to ${recipient}` });

      const streamed: ConversationEvent[] = [];
      for await (const event of service.resolveDecision({
        conversationId,
        userId,
        previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        decision: 'cancel',
      })) streamed.push(event);

      const completed = streamed.find((event) => event.type === 'turn-completed');
      expect(completed).toMatchObject({
        result: { status: 'cancelled', message: SPANISH_CANCELLED },
      });
    });

    it('pins the English result contract for an en session', async () => {
      await expect(transferredResult('en')).resolves.toMatchObject({
        status: 'sent',
        message: ENGLISH_CONFIRMED,
      });
      await expect(cancelledResult('en')).resolves.toEqual({
        status: 'cancelled',
        message: ENGLISH_CANCELLED,
      });
      await expect(transferredResult('en', refusalOutcome)).resolves.toMatchObject({
        status: 'error',
        code: 'policy_rejected',
        message: ENGLISH_POLICY_REFUSAL,
      });
      await expect(transferredResult('en', outageOutcome)).resolves.toMatchObject({
        status: 'error',
        code: 'wallet_unavailable',
        message: ENGLISH_WALLET_UNAVAILABLE,
      });
      await expect(transferredResult('en', malformedOutcome)).resolves.toMatchObject({
        status: 'error',
        code: 'internal_error',
        message: ENGLISH_INTERNAL,
      });
    });

    it.each(['es', 'en'] as const)(
      'separates a permanent refusal from a temporary outage with opposite guidance (%s)',
      async (language) => {
        const refusal = await transferredResult(language, refusalOutcome);
        const outage = await transferredResult(language, outageOutcome);

        expect(refusal.status).toBe('error');
        expect(outage.status).toBe('error');
        expect(refusal.message).not.toBe(outage.message);

        if (language === 'es') {
          // The refusal is final: the transfer did not happen and retrying
          // will not help.
          expect(refusal.message).toMatch(/no se realiz/iu);
          expect(refusal.message).not.toMatch(RETRY_GUIDANCE);
          expect(refusal.message).not.toMatch(TEMPORARY_MARKER);
          // The outage is genuinely temporary: it does invite a retry.
          expect(outage.message).toMatch(RETRY_GUIDANCE);
          expect(outage.message).not.toBe(ENGLISH_POLICY_REFUSAL);
        } else {
          expect(refusal.message).toBe(ENGLISH_POLICY_REFUSAL);
          expect(outage.message).toBe(ENGLISH_WALLET_UNAVAILABLE);
          expect(refusal.message).not.toMatch(TEMPORARY_MARKER);
          expect(outage.message).toMatch(TEMPORARY_MARKER);
        }
      },
    );
  });

  describe('safeErrorMessage language table', () => {
    // The Spanish table must cover EVERY code. A missing entry would send the
    // English string to a Spanish speaker, which is the defect being fixed.
    const CODES: ConversationErrorCode[] = [
      'conversation_not_found',
      'conversation_forbidden',
      'stale_revision',
      'pending_confirmation',
      'no_pending_preview',
      'stale_preview',
      'recipient_revalidation_required',
      'policy_rejected',
      'broadcast_in_progress',
      'broadcast_uncertain',
      'transaction_receipt_invalid',
      'transfer_reverted',
      'invalid_tool_result',
      'wallet_unavailable',
      'internal_error',
    ];
    const RETRY_GUIDANCE = /prob[áa]|intent[áa]|de nuevo|otra vez/iu;

    it.each(CODES)('has non-empty Spanish copy for %s that is not the English string', (code) => {
      const english = safeErrorMessage(code);
      const spanish = safeErrorMessage(code, 'es');

      expect(spanish.trim().length).toBeGreaterThan(0);
      expect(spanish).not.toBe(english);
    });

    it('defaults to English so a caller without a session language keeps today\'s behaviour', () => {
      for (const code of CODES) {
        expect(safeErrorMessage(code)).toBe(safeErrorMessage(code, 'en'));
      }
    });

    it('keeps the English contract byte-identical for the two money-critical codes', () => {
      expect(safeErrorMessage('policy_rejected')).toBe(
        'This transfer does not meet the wallet safety policy.',
      );
      expect(safeErrorMessage('wallet_unavailable')).toBe(
        'The wallet is temporarily unavailable.',
      );
    });

    it('keeps the Spanish refusal permanent and the Spanish outage retryable', () => {
      const refusal = safeErrorMessage('policy_rejected', 'es');
      const outage = safeErrorMessage('wallet_unavailable', 'es');

      // A refusal is final: the transfer did not happen, retrying changes
      // nothing, and it is never described as temporary.
      expect(refusal).toMatch(/no se realiz/iu);
      expect(refusal).toMatch(/no va a cambiar/iu);
      expect(refusal).not.toMatch(RETRY_GUIDANCE);
      expect(refusal).not.toMatch(/temporar/iu);
      // An outage is temporary, so inviting a retry there is honest.
      expect(outage).not.toBe(refusal);
      expect(outage).toMatch(RETRY_GUIDANCE);
    });
  });

  it('no longer applies a local transfer policy: the provider is reached with no policy env vars', async () => {
    // The local transfer-policy gate (with its two policy environment
    // variables) was deleted; the provider policy attached to the wallet is the
    // single enforcement point. With no local policy configured the transfer
    // must reach the wallet provider instead of being rejected before any side
    // effect.
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const preview = vi.spyOn(wallet, 'previewTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` })).resolves.toMatchObject({ status: 'confirmation_required' });
    expect(preview).toHaveBeenCalledOnce();
  });

  it('revalidates the recipient after the atomic claim and before dispatch', async () => {
    const transfer: PendingTransfer = {
      network: 'sepolia', token: 'USDT', to: recipient, amount: '10', wallet: 'agent-demo',
      preview: { network: 'sepolia', token: 'USDT', recipient, amount: '10', estimatedFee: '0.0003 ETH' },
      recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', recipientVersion: 2,
      previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const repository = repositoryFixture(transfer);
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const memory = { userId, service: { getRecipientForVersion: vi.fn().mockResolvedValue(undefined) } } as never;
    const service = createWalletConversationService({ conversations: repository, wallet, memory });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' })).resolves.toMatchObject({ status: 'error', code: 'recipient_revalidation_required' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(['reverted', 'receipt_invalid'] as const)('records %s finality as terminal without rebroadcasting', async (status) => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    vi.spyOn(wallet, 'waitForFinality').mockResolvedValue({ status, network: 'sepolia', transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' })).resolves.toMatchObject({ status: 'error', code: status === 'reverted' ? 'transfer_reverted' : 'transaction_receipt_invalid' });
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('uses the same decision path for cancellation without invoking the provider', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'cancelar la transferencia' })).resolves.toEqual({ status: 'cancelled', message: 'Transferencia cancelada.' });
    expect(broadcast).not.toHaveBeenCalled();
  });

      it('maps a superseded previewId to stale_preview on confirm (V1)', async () => {
        const transfer: PendingTransfer = {
          network: 'sepolia', token: 'USDT', to: recipient, amount: '10', wallet: 'agent-demo',
          preview: { network: 'sepolia', token: 'USDT', recipient, amount: '10', estimatedFee: '0.0003 ETH' },
          previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        };
        const repository = repositoryFixture(transfer);
        const wallet = walletFixture();
        const service = createWalletConversationService({ conversations: repository, wallet });
        const events: ConversationEvent[] = [];
        for await (const event of service.resolveDecision({
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId,
          previewId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          decision: 'confirm',
        })) events.push(event);
        const completed = events.find((event) => event.type === 'turn-completed');
        expect(completed).toMatchObject({ result: { status: 'error', code: 'stale_preview' } });
      });

      it('maps a missing claim to stale_preview, never broadcast_in_progress (V5)', async () => {
        const repository = {
          get: async () => ({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, mode: 'typed' as const,
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
            revision: 1, language: 'es' as const, generation: 1, messages: [],
            pendingTransfer: { previewId: 'p-1' },
          }),
          claimPendingTransfer: async () => ({ status: 'missing' as const }),
          cancelPendingTransfer: async () => 'already_resolved' as const,
        } as unknown as ConversationRepository;
        const wallet = walletFixture();
        const service = createWalletConversationService({ conversations: repository, wallet });
        const events: ConversationEvent[] = [];
        for await (const event of service.resolveDecision({
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          userId,
          previewId: 'p-1',
          decision: 'confirm',
        })) events.push(event);
        const completed = events.find((event) => event.type === 'turn-completed');
        expect(completed).toMatchObject({ result: { status: 'error', code: 'stale_preview' } });
      });

      it('allows only one spoken or touch confirmation to claim the preview', async () => {
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
        const registry = new FinancialTaskRegistry();
        const service = createWalletConversationService({ conversations: repository, wallet, financialTasks: registry });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });

    const [spoken, touch] = await Promise.all([
      service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' }),
      service.resolveDecision({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', decision: 'confirm' }),
    ]);
    await registry.drain({ timeoutMs: 1000 });

    expect(broadcast).toHaveBeenCalledOnce();
    expect(spoken).toMatchObject({ status: 'answer' });
    const touchEvents: ConversationEvent[] = [];
    for await (const event of touch) touchEvents.push(event);
    expect(touchEvents.some((event) => event.type === 'turn-completed')).toBe(true);
    expect(registry.has('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
  });

      afterEach(() => {
        if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
        else process.env.AGENT_RUNTIME = previousRuntime;
      });
    });

    describe('WalletConversationService.previewTransfer', () => {
      const previousNetwork = process.env.WDK_NETWORK;
      const previousToken = process.env.WDK_TOKEN;
      const previousWallet = process.env.WDK_WALLET_NAME;

      afterEach(() => {
        if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
        else process.env.WDK_NETWORK = previousNetwork;
        if (previousToken === undefined) delete process.env.WDK_TOKEN;
        else process.env.WDK_TOKEN = previousToken;
        if (previousWallet === undefined) delete process.env.WDK_WALLET_NAME;
        else process.env.WDK_WALLET_NAME = previousWallet;
      });

      const previewInput = {
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId,
        amount: '10',
        recipientId,
        recipientVersion: 2,
      };

      // A versioned contact of the only network the product serves: the demo
      // path resolves the configured network (solana-devnet) for a contact that
      // declares none, and claim-time revalidation requires the contact's
      // address and network to be valid for it.
      const memoryThatResolves = () => ({
        userId,
        service: {
          getRecipientForVersion: vi.fn().mockResolvedValue({
            id: recipientId,
            userId,
            version: 2,
            address: solanaRecipient,
            name: 'Lucas Gutiérrez',
            normalizedName: 'lucas gutiérrez',
            description: 'Amigo del equipo',
            status: 'active',
            embeddingModelRevision: 'rev',
            network: 'solana-devnet',
          }),
        },
      } as never);

      it('persists a pending transfer and emits a state revision on the service publish path', async () => {
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const published: ConversationEvent[] = [];
        const progress: ConversationProgressPublisher = { publish: (event) => { published.push(event); } };
        const service = createWalletConversationService({
          conversations: repository,
          wallet,
          memory: memoryThatResolves(),
          progress,
        });

        const result = await service.previewTransfer(previewInput);

        expect(result).toMatchObject({
          status: 'confirmation_required',
          message: expect.stringContaining('Lucas Gutiérrez'),
          preview: { recipient: solanaRecipient, amount: '10', token: 'SOL' },
        });
        expect(published).toContainEqual(expect.objectContaining({ type: 'state-revision' }));
      });

      it('fails closed to recipient_revalidation_required when the recipient version is stale', async () => {
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const preview = vi.spyOn(wallet, 'previewTransfer');
        const memory = {
          userId,
          service: { getRecipientForVersion: vi.fn().mockResolvedValue(undefined) },
        } as never;
        const service = createWalletConversationService({ conversations: repository, wallet, memory });

        await expect(service.previewTransfer(previewInput)).resolves.toMatchObject({
          status: 'error',
          code: 'recipient_revalidation_required',
        });
        expect(preview).not.toHaveBeenCalled();
      });

      it('fails closed to recipient_revalidation_required when memory is unavailable (V3)', async () => {
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const service = createWalletConversationService({ conversations: repository, wallet });

        await expect(service.previewTransfer(previewInput)).resolves.toMatchObject({
          status: 'error',
          code: 'recipient_revalidation_required',
        });
      });

      it('routes a versioned Solana devnet contact through an exact native SOL preview without broadcasting', async () => {
        process.env.WDK_NETWORK = 'sepolia';
        process.env.WDK_TOKEN = 'USDT';
        process.env.WDK_WALLET_NAME = 'privy-user';
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const solanaWallet = walletFixture();
        const preview = vi.spyOn(solanaWallet, 'previewTransfer');
        const broadcast = vi.spyOn(solanaWallet, 'broadcastTransfer');
        const walletForUser = vi.fn(async (_user: string, chain?: string | (() => string)) =>
          chain === 'solana' || (typeof chain === 'function' && chain() === 'solana') ? solanaWallet : wallet);
        const setPending = vi.spyOn(repository, 'setPendingTransfer');
        const memory = {
          userId,
          service: {
            getRecipientForVersion: vi.fn().mockResolvedValue({
              id: recipientId,
              userId,
              version: 2,
              address: solanaRecipient,
              name: 'Lucas Gutiérrez',
              normalizedName: 'lucas gutiérrez',
              description: 'Amigo del equipo',
              status: 'active',
              embeddingModelRevision: 'rev',
              network: 'solana-devnet',
            }),
          },
        } as never;
        const service = createWalletConversationService({ conversations: repository, wallet, walletForUser, memory });

        await expect(service.previewTransfer({ ...previewInput, amount: '0.01' })).resolves.toMatchObject({
          status: 'confirmation_required',
          preview: { network: 'solana-devnet', token: 'SOL', recipient: solanaRecipient, amount: '0.01' },
        });
        expect(preview).toHaveBeenCalledWith(expect.objectContaining({
          network: 'solana-devnet', token: 'SOL', to: solanaRecipient, amount: '0.01', wallet: 'privy-user',
        }));
        expect(walletForUser).toHaveBeenCalledWith(userId, 'solana');
        expect(setPending).toHaveBeenCalledWith(userId, previewInput.conversationId, expect.objectContaining({
          network: 'solana-devnet', token: 'SOL', amount: '0.01',
        }));
        expect(broadcast).not.toHaveBeenCalled();
      });

      it('publishes state revisions across preview, claim, and finality (V8.4)', async () => {
        const repository = repositoryFixture();
        const wallet = walletFixture();
        const published: ConversationEvent[] = [];
        const progress: ConversationProgressPublisher = { publish: (event) => { published.push(event); } };
        const registry = new FinancialTaskRegistry();
        const service = createWalletConversationService({
          conversations: repository,
          wallet,
          memory: memoryThatResolves(),
          progress,
          financialTasks: registry,
        });

        const preview = await service.previewTransfer(previewInput);
        expect(preview.status).toBe('confirmation_required');
        const previewRevisions = published.filter((event) => event.type === 'state-revision').length;
        expect(previewRevisions).toBeGreaterThanOrEqual(1);

        const current = await repository.get(userId, previewInput.conversationId);
        const previewId = current?.pendingTransfer?.previewId;
        expect(previewId).toBeTruthy();
        const events: ConversationEvent[] = [];
        for await (const event of service.resolveDecision({
          conversationId: previewInput.conversationId,
          userId,
          previewId: previewId!,
          decision: 'confirm',
          waitForFinancialTask: true,
        })) events.push(event);
        await registry.drain({ timeoutMs: 1000 });

        const finalRevisions = published.filter((event) => event.type === 'state-revision').length;
        expect(finalRevisions).toBeGreaterThan(previewRevisions);
        expect(events.some((event) => event.type === 'turn-completed')).toBe(true);
        const finalSnapshot = await repository.get(userId, previewInput.conversationId);
        expect(finalSnapshot?.pendingTransfer).toBeUndefined();
        expect(finalSnapshot?.lastTransactionHash).toMatch(/^0x[0-9a-f]{64}$/u);
      });
    });
