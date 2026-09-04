import type { LanguageModel } from 'ai';
import { handleMessage, type HandleMessageOptions } from '../agent/wallet-agent.js';
import {
  canonicalizeTransferPreview,
  type SendTokenInput,
} from '../agent/definition.js';
import { getWalletAgentConfig } from '../agent/instructions.js';
import type { ConversationTurnResult, PendingTransfer, TransferPreview } from '../contracts/http.js';
import { appendMessage, type ConversationSession } from './session-state.js';
import { errorFromCode, safeErrorMessage, type ConversationErrorCode } from './errors.js';
import type { ConversationRepository } from './repository.js';
import { createNarrationPolicy, narrateFinancialFact, type NarrationPolicy } from './narration-policy.js';
import type { ConversationSnapshot, WalletProgress } from './types.js';
import type { RecipientMemoryRuntime } from '../memory/runtime.js';
import type { WalletProvider, TransferRequest } from '../wallet/provider.js';
import { validateWalletTransferPolicy } from '../wallet/agent-tools.js';
import { isValidEvmAddress } from '../memory/address.js';
import type { FinancialTaskRegistry } from './financial-task-registry.js';
import {
  assessFinancialIntent,
  clarificationForInterpretation,
  isInterpretationAcceptance,
  isInterpretationRejection,
  parsePossibleFinancialIntent,
  type PendingInterpretation,
} from './interpretation.js';
import { detectConversationLanguage } from './language.js';
import { evaluateContextRenewal, shouldRenewContext, type ContextBudget } from './context-renewal.js';
import { isCancellation, isConfirmation } from '../livekit/resolution-phrases.js';

export type HandleTurnInput = {
  conversationId: string;
  userId: string;
  text: string;
  signal?: AbortSignal;
};

export type ResolveDecisionInput = {
  conversationId: string;
  userId: string;
  previewId: string;
  decision: 'confirm' | 'cancel';
  signal?: AbortSignal;
  waitForFinancialTask?: boolean;
};

export type PreviewTransferInput = {
  conversationId: string;
  userId: string;
  amount: string;
  recipientId: string;
  recipientVersion: number;
  /** Accepted for the voice schema but never persisted: the pending transfer stores no memo field. */
  memo?: string;
};

export type PersistNativeToolStateInput = {
  conversationId: string;
  userId: string;
  session: ConversationSession;
};

export type PersistNativePreviewInput = PersistNativeToolStateInput & {
  input: SendTokenInput;
  output: unknown;
};

export type NativePreviewCommandResult =
  | {
    status: 'preview_created';
    preview: PendingTransfer['preview'];
    previewId?: string;
    revision: number;
  }
  | {
    status: 'error';
    error: 'invalid_tool_result' | 'pending_confirmation';
    message: string;
  };

export type ConversationActivity = 'idle' | 'working' | 'awaiting_confirmation' | 'verifying' | 'uncertain' | 'request_waiting';

export type ConversationEvent =
  | { type: 'state-revision'; revision: number; activity: ConversationActivity }
  | { type: 'spoken-segment'; id: string; text: string; reason: 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain' }
  | { type: 'turn-completed'; result: ConversationTurnResult };

export type ConversationProgressPublisher = {
  publish(event: ConversationEvent): Promise<void> | void;
};

export interface WalletConversationService {
  handleTurn(input: HandleTurnInput): Promise<ConversationTurnResult>;
  handleTurnStream(input: HandleTurnInput): AsyncIterable<ConversationEvent>;
  resolveDecision(input: ResolveDecisionInput): AsyncIterable<ConversationEvent>;
  previewTransfer(input: PreviewTransferInput): Promise<ConversationTurnResult>;
  persistNativeToolState(input: PersistNativeToolStateInput): Promise<ConversationSnapshot>;
  persistNativePreview(input: PersistNativePreviewInput): Promise<NativePreviewCommandResult | Record<string, unknown>>;
  appendNativeMessage(input: {
    conversationId: string;
    userId: string;
    role: 'user' | 'assistant';
    text: string;
  }): Promise<void>;
}

export type WalletConversationDependencies = {
  conversations: ConversationRepository;
  wallet: WalletProvider;
  memory?: RecipientMemoryRuntime;
  model?: LanguageModel;
  clock?: { now(): number };
  progress?: ConversationProgressPublisher;
  narration?: NarrationPolicy;
  financialTasks?: FinancialTaskRegistry;
  contextRenewal?: {
    budget: ContextBudget;
    estimateTokens(snapshot: ConversationSnapshot): number;
    summarize(snapshot: ConversationSnapshot): Promise<unknown>;
  };
};

export function createWalletConversationService(dependencies: WalletConversationDependencies): WalletConversationService {
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const narration = dependencies.narration ?? createNarrationPolicy({ clock });

  async function* handleTurnStream(input: HandleTurnInput): AsyncIterable<ConversationEvent> {
    let snapshot = await dependencies.conversations.get(input.userId, input.conversationId);
    if (!snapshot) {
      yield* completedError(input, 'conversation_not_found');
      return;
    }

    const language = detectConversationLanguage(input.text, snapshot.language);
    if (language !== snapshot.language && dependencies.conversations.setLanguage) {
      const state = await dependencies.conversations.setLanguage(input.userId, input.conversationId, language);
      snapshot = { ...snapshot, ...state, language };
    } else {
      snapshot = { ...snapshot, language };
    }

    if (snapshot.pendingInterpretation) {
      if (isInterpretationRejection(input.text)) {
        const result: ConversationTurnResult = {
          status: 'answer',
          message: language === 'es' ? 'Descarté esa interpretación. Te escucho.' : 'I discarded that interpretation. I am listening.',
        };
        await clearInterpretation(snapshot, input.userId, dependencies.conversations);
        await appendConversationMessage(snapshot, input.userId, 'user', input.text, dependencies.conversations);
        await appendServiceMessage(snapshot, input.userId, result.message, dependencies.conversations);
        yield* emitSpoken(result.message, 'answer');
        yield event({ type: 'turn-completed', result });
        return;
      }
      if (isInterpretationAcceptance(input.text)) {
        const interpretation = snapshot.pendingInterpretation;
        const assessment = assessFinancialIntent(interpretation);
        if (assessment.decision === 'clarify') {
          const message = clarificationForInterpretation(interpretation, language);
          yield* emitSpoken(message, 'answer');
          yield event({ type: 'turn-completed', result: { status: 'clarification_required', message, candidates: [] } });
          return;
        }
        await clearInterpretation(snapshot, input.userId, dependencies.conversations);
        const acceptedText = interpretation.sourceText ?? renderInterpretation(interpretation);
        yield* handleTurnStream({ ...input, text: acceptedText });
        return;
      }
      await clearInterpretation(snapshot, input.userId, dependencies.conversations);
      snapshot = { ...snapshot, pendingInterpretation: undefined };
    }

    if (snapshot.pendingTransfer && isConfirmation(input.text)) {
      yield* resolveDecision({
        conversationId: input.conversationId,
        userId: input.userId,
        previewId: snapshot.pendingTransfer.previewId ?? '',
        decision: 'confirm',
        signal: input.signal,
      });
      return;
    }
    if (snapshot.pendingTransfer && isCancellation(input.text)) {
      yield* resolveDecision({
        conversationId: input.conversationId,
        userId: input.userId,
        previewId: snapshot.pendingTransfer.previewId ?? '',
        decision: 'cancel',
        signal: input.signal,
      });
      return;
    }

    const possibleIntent = parsePossibleFinancialIntent(input.text);
    if (possibleIntent) {
      const assessment = assessFinancialIntent(possibleIntent);
      if (assessment.decision === 'clarify') {
        const interpretation = { ...assessment.interpretation, sourceText: input.text };
        await persistInterpretation(snapshot, input.userId, dependencies.conversations, interpretation);
        await appendConversationMessage(snapshot, input.userId, 'user', input.text, dependencies.conversations);
        const message = clarificationForInterpretation(interpretation, language);
        await appendServiceMessage(snapshot, input.userId, message, dependencies.conversations);
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(message, 'answer');
        yield event({ type: 'turn-completed', result: { status: 'clarification_required', message, candidates: [] } });
        return;
      }
    }

    let workingSnapshot = snapshot;
    if (looksLikeTransfer(input.text)) {
      workingSnapshot = await setProgress(workingSnapshot, { phase: 'working' });
      yield* emit(stateEvent(workingSnapshot));
      yield* emitSpoken(narrateFinancialFact({ language: workingSnapshot.language, phase: 'started' }), 'started');
    }

    const persistedMessageCount = workingSnapshot.messages.length;
    let result: ConversationTurnResult;
    try {
      const options: HandleMessageOptions = {
        ...(dependencies.model ? { model: dependencies.model } : {}),
        ...(dependencies.memory ? { recipientMemory: dependencies.memory } : {}),
        walletProvider: dependencies.wallet,
        ...(input.signal ? { abortSignal: input.signal } : {}),
        language: workingSnapshot.language,
      };
      result = sanitizeResult(await handleMessage(workingSnapshot, input.text, options));
      await dependencies.conversations.saveSnapshot(input.userId, workingSnapshot, persistedMessageCount);
    } catch (error) {
      result = errorResult(error);
      await appendServiceMessage(workingSnapshot, input.userId, result.message, dependencies.conversations);
    }

    const updated = await dependencies.conversations.get(input.userId, input.conversationId) ?? workingSnapshot;
    const renewed = await renewContextIfSafe(updated);
    const visible = renewed ?? updated;
    if (result.status === 'confirmation_required') {
      const withProgress = await setProgress(visible, {
        phase: 'awaiting_confirmation',
        label: 'Transfer preview ready for confirmation',
      });
      yield* emit(stateEvent(withProgress));
      yield* emitSpoken(
        narrateFinancialFact({ language: withProgress.language, phase: 'awaiting_confirmation', amount: result.preview.amount, token: result.preview.token }),
        'decision',
      );
    } else {
      yield* emit(stateEvent(visible));
      yield* emitSpoken(spokenResultMessage(result, visible.language), result.status === 'error' ? 'uncertain' : 'answer');
    }
    yield event({ type: 'turn-completed', result });
  }

  async function* resolveDecision(input: ResolveDecisionInput): AsyncIterable<ConversationEvent> {
    const snapshot = await dependencies.conversations.get(input.userId, input.conversationId);
    if (!snapshot) {
      yield* completedError({ conversationId: input.conversationId, userId: input.userId, text: '' }, 'conversation_not_found');
      return;
    }
    const pending = snapshot.pendingTransfer;
    if (!pending || pending.previewId !== input.previewId) {
      const result = errorResult(errorFromCode('stale_preview'));
      yield* emit(stateEvent(snapshot));
      yield* emitSpoken(result.message, 'answer');
      yield event({ type: 'turn-completed', result });
      return;
    }

    if (input.decision === 'cancel') {
      const cancellation = await dependencies.conversations.cancelPendingTransfer(input.userId, input.conversationId, input.previewId);
      if (cancellation !== 'cancelled') {
        const result = errorResult(errorFromCode(cancellation === 'stale_preview' ? 'stale_preview' : 'broadcast_in_progress'));
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(result.message, 'answer');
        yield event({ type: 'turn-completed', result });
        return;
      }
      const result: ConversationTurnResult = { status: 'cancelled', message: 'Transfer cancelled.' };
      await appendConversationMessage(snapshot, input.userId, 'user', input.decision, dependencies.conversations);
      await appendServiceMessage(snapshot, input.userId, result.message, dependencies.conversations);
      const updated = await dependencies.conversations.get(input.userId, input.conversationId) ?? snapshot;
      yield* emit(stateEvent(updated));
      yield* emitSpoken(spokenResultMessage(result, updated.language), 'result');
      yield event({ type: 'turn-completed', result });
      return;
    }

    const claim = await dependencies.conversations.claimPendingTransfer(input.userId, input.conversationId, input.previewId);
    if (claim.status !== 'claimed') {
      // REVIEW FIX V5: a claim over a missing/superseded attempt is `stale_preview`,
      // never `broadcast_in_progress` — the preview no longer exists to be broadcast.
      const code: ConversationErrorCode = claim.status === 'uncertain' ? 'broadcast_uncertain' : claim.status === 'missing' ? 'stale_preview' : 'broadcast_in_progress';
      const result = errorResult(errorFromCode(code));
      yield* emit(stateEvent(snapshot));
      yield* emitSpoken(result.message, claim.status === 'uncertain' ? 'uncertain' : 'answer');
      yield event({ type: 'turn-completed', result });
      return;
    }

    await appendConversationMessage(snapshot, input.userId, 'user', input.decision, dependencies.conversations);
    const claimed = claim.transfer;
    const run = async (): Promise<void> => {
      await runFinancialTransfer({ ...input, claimed, snapshot });
    };
    if (dependencies.financialTasks) {
      const started = dependencies.financialTasks.start({ operationId: input.previewId, run });
      if (started === 'already_running') {
        const result = errorResult(errorFromCode('broadcast_in_progress'));
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(result.message, 'answer');
        yield event({ type: 'turn-completed', result });
        return;
      }
      const broadcasting = await dependencies.conversations.get(input.userId, input.conversationId) ?? snapshot;
      yield* emit(stateEvent(broadcasting));
      yield* emitSpoken(narrateFinancialFact({ language: broadcasting.language, phase: 'broadcasting' }), 'started');
      const result: ConversationTurnResult = { status: 'answer', message: 'Transfer is being processed.' };
      if (input.waitForFinancialTask) {
        await dependencies.financialTasks.wait(input.previewId);
        const completed = await dependencies.conversations.get(input.userId, input.conversationId) ?? snapshot;
        yield* emit(stateEvent(completed));
        yield event({ type: 'turn-completed', result: resultFromFinancialState(completed) });
        return;
      }
      yield event({ type: 'turn-completed', result });
      return;
    }

        const result = await runFinancialTransfer({ ...input, claimed, snapshot });
        const updated = await dependencies.conversations.get(input.userId, input.conversationId) ?? snapshot;
        yield* emit(stateEvent(updated));
        yield* emitSpoken(result.message, result.status === 'error' ? 'uncertain' : result.status === 'sent' ? 'result' : 'answer');
        yield event({ type: 'turn-completed', result });
      }

      /**
       * REVIEW FIX V2 — reusable preview entry point. The realtime voice `send_token`
       * calls this (never duplicating guard logic in livekit): it revalidates the
       * versioned recipient, applies the wallet policy, persists the pending transfer
       * through the repository, and emits the state revision via the same publish path
       * the text service uses (financialTasks + progress) so the frontend card appears.
       */
      async function previewTransfer(input: PreviewTransferInput): Promise<ConversationTurnResult> {
        const snapshot = await dependencies.conversations.get(input.userId, input.conversationId);
        if (!snapshot) return errorResult(errorFromCode('conversation_not_found'));

        const recipient = await resolveRecipientForTransfer(input.userId, input.recipientId, input.recipientVersion);
        if (!recipient.ok) return errorResult(errorFromCode('recipient_revalidation_required'));

        const config = getWalletAgentConfig();
        const transferRequest: TransferRequest = {
          network: config.network,
          token: config.token,
          to: recipient.address,
          amount: input.amount,
          wallet: config.wallet,
        };
        const policyError = validateWalletTransferPolicy({ ...transferRequest, dryRun: false }, config);
        if (policyError) return errorResult(errorFromCode('policy_rejected'));

        let preview: TransferPreview;
        try {
          preview = await dependencies.wallet.previewTransfer(transferRequest);
        } catch {
          return errorResult(errorFromCode('wallet_unavailable'));
        }

        const pendingTransfer: PendingTransfer = {
          ...transferRequest,
          preview,
          recipientId: input.recipientId,
          recipientVersion: input.recipientVersion,
        };
        const state = await dependencies.conversations.setPendingTransfer(input.userId, input.conversationId, pendingTransfer);
        await publish(stateEvent(state));

        const message = snapshot.language === 'es'
          ? `Preparé una transferencia de ${input.amount} ${config.token} para ${recipient.name}. Confirmá para continuar.`
          : `Prepared a ${input.amount} ${config.token} transfer for ${recipient.name}. Confirm to continue.`;
        return { status: 'confirmation_required', message, preview };
      }

      async function resolveRecipientForTransfer(
        userId: string,
        recipientId: string,
        recipientVersion: number,
      ): Promise<{ ok: true; address: string; name: string } | { ok: false }> {
        if (!recipientId || recipientVersion === undefined || recipientVersion <= 0) return { ok: false };
        if (!dependencies.memory) return { ok: false };
        const current = await dependencies.memory.service.getRecipientForVersion(userId, recipientId, recipientVersion);
        if (!current || current.id !== recipientId || current.version !== recipientVersion || !isValidEvmAddress(current.address)) {
          return { ok: false };
        }
        return { ok: true, address: current.address, name: current.name };
      }

      async function publish(current: ConversationEvent): Promise<void> {
    await dependencies.progress?.publish(current);
    dependencies.financialTasks?.publish(current);
  }

  async function* emit(current: ConversationEvent): AsyncIterable<ConversationEvent> {
    await publish(current);
    yield current;
  }

  async function* emitSpoken(text: string, reason: 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain'): AsyncIterable<ConversationEvent> {
    const input = { reason, text };
    if (!narration.shouldNarrate(input)) return;
    narration.remember(input);
    const current: ConversationEvent = { type: 'spoken-segment', id: crypto.randomUUID(), text, reason };
    await publish(current);
    yield current;
  }

  async function runFinancialTransfer(input: {
    conversationId: string;
    userId: string;
    previewId: string;
    claimed: PendingTransfer & { previewId: string };
    snapshot: ConversationSnapshot;
  }): Promise<ConversationTurnResult> {
    const { conversationId, userId, claimed, snapshot } = input;
    const transfer = toTransferRequest(claimed);
    const policyError = validateWalletTransferPolicy({ ...transfer, dryRun: false }, getWalletAgentConfig());
    const recipientValid = await isClaimedRecipientValid(claimed, dependencies.memory);
    if (policyError || !recipientValid) {
      await dependencies.conversations.releasePendingTransferClaim(userId, conversationId);
      await dependencies.conversations.clearPendingTransfer(userId, conversationId);
      const result = errorResult(errorFromCode(policyError ? 'policy_rejected' : 'recipient_revalidation_required'));
      await appendServiceMessage(snapshot, userId, result.message, dependencies.conversations);
      const updated = await dependencies.conversations.get(userId, conversationId) ?? snapshot;
      await publish(stateEvent(updated));
      await publishSpoken(spokenResultMessage(result, updated.language), 'answer');
      return result;
    }

    const broadcasting = await dependencies.conversations.get(userId, conversationId) ?? snapshot;
    const broadcastingState = await setProgress(broadcasting, { phase: 'broadcasting', label: 'Transfer is being broadcast.' });
    await publish(stateEvent(broadcastingState));
    await publishSpoken(narrateFinancialFact({ language: broadcastingState.language, phase: 'broadcasting' }), 'started');

    let broadcast;
    try {
      broadcast = await dependencies.wallet.broadcastTransfer(transfer);
    } catch (error) {
      broadcast = { kind: 'uncertain' as const, reason: error instanceof Error ? error.message : 'Wallet provider failed.' };
    }

    if (broadcast.kind === 'not_dispatched') {
      await dependencies.conversations.releasePendingTransferClaim(userId, conversationId);
      const result = errorResult(errorFromCode('wallet_unavailable'));
      const failed = await setProgress(await dependencies.conversations.get(userId, conversationId) ?? snapshot, { phase: 'failed', label: result.message });
      await appendServiceMessage(snapshot, userId, result.message, dependencies.conversations);
      await publish(stateEvent(failed));
      await publishSpoken(spokenResultMessage(result, failed.language), 'result');
      return result;
    }
    if (broadcast.kind === 'uncertain') {
      await dependencies.conversations.markPendingTransferUncertain(userId, conversationId);
      const result = errorResult(errorFromCode('broadcast_uncertain'));
      const uncertain = await setProgress(await dependencies.conversations.get(userId, conversationId) ?? snapshot, { phase: 'uncertain', label: result.message });
      await appendServiceMessage(snapshot, userId, result.message, dependencies.conversations);
      await publish(stateEvent(uncertain));
      await publishSpoken(spokenResultMessage(result, uncertain.language), 'uncertain');
      return result;
    }

    const transaction = broadcast.transaction;
    await dependencies.conversations.markTransferSubmitted(userId, conversationId, transaction.transactionHash, transaction);
    const verifying = await setProgress(await dependencies.conversations.get(userId, conversationId) ?? snapshot, { phase: 'verifying', transactionHash: transaction.transactionHash, label: 'Verifying the transaction.' });
    await publish(stateEvent(verifying));
      await publishSpoken(narrateFinancialFact({ language: verifying.language, phase: 'verifying' }), 'started');

    let finality;
    try {
      finality = await dependencies.wallet.waitForFinality({ transaction });
    } catch (error) {
      finality = { status: 'receipt_invalid' as const, transactionHash: transaction.transactionHash, network: 'sepolia' as const, reason: error instanceof Error ? error.message : 'Receipt validation failed.' };
    }

    if (finality.status === 'confirmed') {
      await dependencies.conversations.finalizeTransfer(userId, conversationId, { status: 'confirmed', transactionHash: transaction.transactionHash, receiptResult: finality });
      const result: ConversationTurnResult = { status: 'sent', message: 'Transfer confirmed.', transaction };
      await appendServiceMessage(snapshot, userId, result.message, dependencies.conversations);
      const completed = await setProgress(await dependencies.conversations.get(userId, conversationId) ?? snapshot, { phase: 'completed', transactionHash: transaction.transactionHash, label: 'Transfer confirmed.' });
      await publish(stateEvent(completed));
      await publishSpoken(narrateFinancialFact({ language: completed.language, phase: 'completed' }), 'result');
      return result;
    }

    const isReverted = finality.status === 'reverted';
    const code: ConversationErrorCode = isReverted ? 'transfer_reverted' : 'transaction_receipt_invalid';
    await dependencies.conversations.finalizeTransfer(userId, conversationId, { status: isReverted ? 'reverted' : 'receipt_invalid', transactionHash: transaction.transactionHash, receiptResult: finality, failure: finality.reason });
    const result = errorResult(errorFromCode(code));
    await appendServiceMessage(snapshot, userId, result.message, dependencies.conversations);
    const failed = await setProgress(await dependencies.conversations.get(userId, conversationId) ?? snapshot, { phase: 'failed', transactionHash: transaction.transactionHash, label: result.message });
    await publish(stateEvent(failed));
    await publishSpoken(spokenResultMessage(result, failed.language), 'result');
    return result;
  }

  async function publishSpoken(text: string, reason: 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain'): Promise<void> {
    const input = { reason, text };
    if (!narration.shouldNarrate(input)) return;
    narration.remember(input);
    await publish({ type: 'spoken-segment', id: crypto.randomUUID(), text, reason });
  }

  function resultFromFinancialState(snapshot: ConversationSnapshot): ConversationTurnResult {
    if (snapshot.progress?.phase === 'completed' && snapshot.lastTransactionHash) {
      const transaction = snapshot.transaction ?? {
        network: snapshot.pendingTransfer?.network ?? 'sepolia',
        transactionHash: snapshot.lastTransactionHash,
        explorerUrl: `https://sepolia.etherscan.io/tx/${snapshot.lastTransactionHash}`,
      };
      return { status: 'sent', message: 'Transfer confirmed.', transaction };
    }
    if (snapshot.progress?.phase === 'uncertain') return errorResult(errorFromCode('broadcast_uncertain'));
    if (snapshot.progress?.phase === 'failed') {
      return errorResult(errorFromCode(snapshot.progress.label?.toLocaleLowerCase('en-US').includes('reverted') ? 'transfer_reverted' : 'transaction_receipt_invalid'));
    }
    return { status: 'answer', message: 'Transfer is being processed.' };
  }

  async function handleTurn(input: HandleTurnInput): Promise<ConversationTurnResult> {
    let result: ConversationTurnResult = { status: 'error', message: safeErrorMessage('internal_error'), code: 'internal_error' };
    for await (const current of handleTurnStream(input)) {
      if (current.type === 'turn-completed') result = current.result;
    }
    return result;
  }

  async function persistNativeToolState(
    input: PersistNativeToolStateInput,
  ): Promise<ConversationSnapshot> {
    const snapshot = await nativeSnapshot(input);
    const persisted = await dependencies.conversations.saveSnapshot(
      input.userId,
      {
        ...snapshot,
        recipientMemory: input.session.recipientMemory,
      },
      snapshot.messages.length,
    );
    await publish(stateEvent(persisted));
    return persisted;
  }

  async function persistNativePreview(
    input: PersistNativePreviewInput,
  ): Promise<NativePreviewCommandResult | Record<string, unknown>> {
    const snapshot = await nativeSnapshot(input);
    if (!input.input.dryRun) {
      return {
        status: 'error',
        error: 'pending_confirmation',
        message: 'A transfer preview must be confirmed before it can be broadcast.',
      };
    }
    if (snapshot.pendingTransfer || snapshot.transferResolutionState) {
      return {
        status: 'error',
        error: 'pending_confirmation',
        message: 'A transfer is waiting for your decision. Confirm or cancel it before preparing another transfer.',
      };
    }
    if (isToolError(input.output)) return input.output;
    const preview = canonicalizeTransferPreview(input.input, input.output);
    if (!preview) {
      return {
        status: 'error',
        error: 'invalid_tool_result',
        message: safeErrorMessage('invalid_tool_result'),
      };
    }
    const selected = input.session.recipientMemory?.previewedRecipient;
    const persisted = await dependencies.conversations.saveSnapshot(
      input.userId,
      {
        ...snapshot,
        recipientMemory: input.session.recipientMemory,
        pendingTransfer: {
          network: input.input.network,
          token: input.input.token,
          to: input.input.to,
          amount: input.input.amount,
          wallet: input.input.wallet,
          preview,
          ...(selected
            ? {
              recipientId: selected.recipientId,
              recipientVersion: selected.version,
            }
            : {}),
        },
        progress: {
          phase: 'awaiting_confirmation',
          label: 'Transfer preview ready for confirmation',
        },
      },
      snapshot.messages.length,
    );
    await publish(stateEvent(persisted));
    return {
      status: 'preview_created',
      preview,
      previewId: persisted.pendingTransfer?.previewId,
      revision: persisted.revision,
    };
  }

  async function appendNativeMessage(input: {
    conversationId: string;
    userId: string;
    role: 'user' | 'assistant';
    text: string;
  }): Promise<void> {
    if (!input.text.trim()) return;
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) throw new Error('conversation_not_found');
    await dependencies.conversations.appendMessage(input.userId, input.conversationId, {
      role: input.role,
      content: input.text,
    });
  }

  async function nativeSnapshot(
    input: PersistNativeToolStateInput,
  ): Promise<ConversationSnapshot> {
    if (
      input.session.id !== input.conversationId ||
      !input.conversationId ||
      !input.userId
    ) {
      throw new Error('Native tool session does not match its conversation.');
    }
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) throw new Error('conversation_not_found');
    return snapshot;
  }

  async function setProgress(snapshot: ConversationSnapshot, progress: WalletProgress): Promise<ConversationSnapshot> {
    if (!dependencies.conversations.setProgress) return snapshot;
    const state = await dependencies.conversations.setProgress(snapshot.userId, snapshot.id, progress);
    return { ...snapshot, ...state };
  }

  async function renewContextIfSafe(snapshot: ConversationSnapshot): Promise<ConversationSnapshot | undefined> {
    const configuration = dependencies.contextRenewal;
    if (!configuration || !dependencies.conversations.renewContext) return undefined;
    const estimatedTokens = configuration.estimateTokens(snapshot);
    if (!Number.isFinite(estimatedTokens)) return undefined;
    if (!shouldRenewContext(estimatedTokens, configuration.budget, snapshot)) return undefined;
    const summary = await configuration.summarize(snapshot);
    const decision = evaluateContextRenewal({
      estimatedTokens,
      budget: configuration.budget,
      state: snapshot,
      summary,
      summaryThroughSequence: snapshot.messages.length,
    });
    if (decision.status !== 'ready') return undefined;
    return dependencies.conversations.renewContext({
      userId: snapshot.userId,
      conversationId: snapshot.id,
      expectedRevision: snapshot.revision,
      summary: decision.summary,
      summaryThroughSequence: decision.summaryThroughSequence,
    });
  }

  return {
    handleTurn,
    handleTurnStream,
    resolveDecision,
    previewTransfer,
    persistNativeToolState,
    persistNativePreview,
    appendNativeMessage,
  };
}

async function appendServiceMessage(snapshot: ConversationSnapshot, userId: string, text: string, repository: ConversationRepository): Promise<void> {
  await appendConversationMessage(snapshot, userId, 'assistant', text, repository);
}

async function appendConversationMessage(snapshot: ConversationSnapshot, userId: string, role: 'user' | 'assistant', text: string, repository: ConversationRepository): Promise<void> {
  appendMessage(snapshot, { role, content: text });
  await repository.appendMessage(userId, snapshot.id, { role, content: text });
}

function event(current: ConversationEvent): ConversationEvent {
  return current;
}

async function* spoken(text: string, reason: 'started' | 'delayed' | 'decision' | 'result' | 'answer' | 'uncertain', policy: NarrationPolicy): AsyncIterable<ConversationEvent> {
  const input = { reason, text };
  if (!policy.shouldNarrate(input)) return;
  policy.remember(input);
  yield event({ type: 'spoken-segment', id: crypto.randomUUID(), text, reason });
}

type ActivityState = Pick<
  ConversationSnapshot,
  'pendingTransfer' | 'pendingInterpretation' | 'transferResolutionState' | 'progress'
> & { revision: number };

function stateEvent(snapshot: ActivityState): ConversationEvent {
  return { type: 'state-revision', revision: snapshot.revision, activity: activityFor(snapshot) };
}

function activityFor(snapshot: ActivityState): ConversationActivity {
  if (snapshot.pendingInterpretation) return 'request_waiting';
  if (snapshot.transferResolutionState === 'uncertain') return 'uncertain';
  if (snapshot.transferResolutionState === 'broadcasting') return 'verifying';
  if (snapshot.progress?.phase === 'working' || snapshot.progress?.phase === 'broadcasting') return 'working';
  if (snapshot.progress?.phase === 'verifying') return 'verifying';
  if (snapshot.pendingTransfer) return 'awaiting_confirmation';
  return 'idle';
}

async function persistInterpretation(
  snapshot: ConversationSnapshot,
  userId: string,
  repository: ConversationRepository,
  interpretation: PendingInterpretation,
): Promise<void> {
  snapshot.pendingInterpretation = interpretation;
  if (repository.setPendingInterpretation) {
    const state = await repository.setPendingInterpretation(userId, snapshot.id, interpretation);
    Object.assign(snapshot, state);
  }
}

async function clearInterpretation(
  snapshot: ConversationSnapshot,
  userId: string,
  repository: ConversationRepository,
): Promise<void> {
  snapshot.pendingInterpretation = undefined;
  if (repository.clearPendingInterpretation) {
    const state = await repository.clearPendingInterpretation(userId, snapshot.id);
    Object.assign(snapshot, state);
  }
}

function renderInterpretation(interpretation: PendingInterpretation): string {
  return `send ${valueForRender(interpretation.amount)} ${valueForRender(interpretation.token)} to ${valueForRender(interpretation.recipient)}`;
}

function valueForRender(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value : value?.[0] ?? '';
}

function spokenResultMessage(result: ConversationTurnResult, language: 'es' | 'en'): string {
  if (language === 'en') return result.message;
  if (result.status === 'sent') return 'La transferencia quedó confirmada.';
  if (result.status === 'cancelled') return 'Transferencia cancelada.';
  if (result.status === 'error') {
    const messages: Record<string, string> = {
      broadcast_uncertain: 'No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.',
      transfer_reverted: 'La transferencia fue revertida en la red.',
      transaction_receipt_invalid: 'La transferencia fue enviada, pero no pude verificar el comprobante.',
      pending_confirmation: 'Hay una transferencia esperando tu decisión. Confirmala o cancelala antes de enviar otra instrucción.',
    };
    return messages[result.code] ?? result.message;
  }
  return result.message;
}

function errorResult(error: unknown): Extract<ConversationTurnResult, { status: 'error' }> {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code as ConversationErrorCode;
    return { status: 'error', code, message: safeErrorMessage(code) };
  }
  return { status: 'error', code: 'internal_error', message: safeErrorMessage('internal_error') };
}

function sanitizeResult(result: ConversationTurnResult): ConversationTurnResult {
  if (result.status !== 'error') return result;
  const supported = new Set<ConversationErrorCode>([
    'conversation_not_found', 'conversation_forbidden', 'stale_revision', 'pending_confirmation',
    'no_pending_preview', 'stale_preview', 'recipient_revalidation_required', 'policy_rejected',
    'broadcast_in_progress', 'broadcast_uncertain', 'transaction_receipt_invalid', 'transfer_reverted',
    'invalid_tool_result', 'wallet_unavailable', 'internal_error',
  ]);
  const code = supported.has(result.code as ConversationErrorCode) ? result.code as ConversationErrorCode : 'internal_error';
  return { status: 'error', code, message: safeErrorMessage(code) };
}

function isToolError(output: unknown): output is Record<string, unknown> {
  return Boolean(
    output &&
      typeof output === 'object' &&
      !Array.isArray(output) &&
      typeof (output as { error?: unknown }).error === 'string' &&
      typeof (output as { message?: unknown }).message === 'string',
  );
}

async function* completedError(input: HandleTurnInput, code: ConversationErrorCode): AsyncIterable<ConversationEvent> {
  const result = errorResult(errorFromCode(code));
  yield { type: 'spoken-segment', id: crypto.randomUUID(), text: result.message, reason: 'answer' };
  yield { type: 'turn-completed', result };
}

function toTransferRequest(transfer: PendingTransfer): TransferRequest {
  return {
    network: transfer.network,
    token: transfer.token,
    to: transfer.to,
    amount: transfer.amount,
    wallet: transfer.wallet,
  };
}

async function isClaimedRecipientValid(transfer: PendingTransfer, memory?: RecipientMemoryRuntime): Promise<boolean> {
  if (!transfer.recipientId || transfer.recipientVersion === undefined) return true;
  if (!memory) return false;
  const current = await memory.service.getRecipientForVersion(memory.userId, transfer.recipientId, transfer.recipientVersion);
  return Boolean(current && current.id === transfer.recipientId && current.version === transfer.recipientVersion && isValidEvmAddress(current.address) && current.address === transfer.to);
}

function looksLikeTransfer(text: string): boolean {
  return /\b(send|transfer|pay|mand[aá]|transfer[ií]|envi[aá])\b/iu.test(text);
}
