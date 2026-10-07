import type { LanguageModel } from "ai";
import {
  handleMessage,
  type HandleMessageOptions,
} from "../agent/wallet-agent.js";
import {
  canonicalizeTransferPreview,
  type CreateDelegatedGrantInput,
  type CreateDelegatedGrantResult,
  type SendTokenInput,
} from "../agent/definition.js";
import { getWalletAgentConfig } from "../agent/instructions.js";
import type {
  ConversationTurnResult,
  PendingTransfer,
  TransferPreview,
} from "../contracts/http.js";
import { appendMessage, type ConversationSession } from "./session-state.js";
import {
  errorFromCode,
  safeErrorMessage,
  type ConversationErrorCode,
} from "./errors.js";
import type { ConversationRepository } from "./repository.js";
import {
  createNarrationPolicy,
  narrateFinancialFact,
  type NarrationPolicy,
} from "./narration-policy.js";
import type { ConversationSnapshot, WalletProgress } from "./types.js";
import type { RecipientMemoryRuntime } from "../memory/runtime.js";
import {
  explorerUrlFor,
  type WalletProvider,
  type TransferRequest,
} from "../wallet/provider.js";
import {
  bindWalletForUser,
  walletChainFamilyForNetwork,
  type WalletForUser,
} from "../wallet/privy-user-provider.js";
import { validateWalletTransferPolicy } from "../wallet/agent-tools.js";
import {
  GrantWalletUnavailableError,
  InvalidGrantInputError,
  type GrantCreator,
} from "../wallet/grants/consumption.js";
import { isValidRecipientAddress } from "../memory/address.js";
import type { FinancialTaskRegistry } from "./financial-task-registry.js";
import {
  assessFinancialIntent,
  clarificationForInterpretation,
  isInterpretationAcceptance,
  isInterpretationRejection,
  parsePossibleFinancialIntent,
  type PendingInterpretation,
} from "./interpretation.js";
import { detectConversationLanguage } from "./language.js";
import {
  evaluateContextRenewal,
  shouldRenewContext,
  type ContextBudget,
} from "./context-renewal.js";
import {
  isCancellation,
  isConfirmation,
} from "../livekit/resolution-phrases.js";

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
  decision: "confirm" | "cancel";
  signal?: AbortSignal;
  waitForFinancialTask?: boolean;
  /**
   * slice3-grant-execution: internal authorization source. Default "user"
   * (explicit user confirm/cancel); "delegated_grant" marks a grant-covered
   * execution resolved by the server gate, so no fabricated user "confirm"
   * message is appended and narration/audit stay accurate.
   */
  authorizedBy?: "user" | "delegated_grant";
  /**
   * AD-10: identity of the grant reservation claimed for THIS execution
   * (set by the delegated-grant path when a candidate wins the ledger
   * claim). Threaded into runFinancialTransfer so a definitive
   * non-dispatch settles the EXACT reservation — never released without
   * this complete identity (fail closed, retain).
   */
  claimedGrantId?: string;
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
      status: "preview_created";
      preview: PendingTransfer["preview"];
      previewId?: string;
      revision: number;
    }
  | {
      status: "error";
      error: "invalid_tool_result" | "pending_confirmation";
      message: string;
    };

export type ConversationActivity =
  | "idle"
  | "working"
  | "awaiting_confirmation"
  | "verifying"
  | "uncertain"
  | "request_waiting";

export type ConversationEvent =
  | { type: "state-revision"; revision: number; activity: ConversationActivity }
  | {
      type: "spoken-segment";
      id: string;
      text: string;
      reason:
        | "started"
        | "delayed"
        | "decision"
        | "result"
        | "answer"
        | "uncertain";
    }
  | { type: "turn-completed"; result: ConversationTurnResult };

export type ConversationProgressPublisher = {
  publish(event: ConversationEvent): Promise<void> | void;
};

export interface WalletConversationService {
  handleTurn(input: HandleTurnInput): Promise<ConversationTurnResult>;
  handleTurnStream(input: HandleTurnInput): AsyncIterable<ConversationEvent>;
  resolveDecision(
    input: ResolveDecisionInput,
  ): AsyncIterable<ConversationEvent>;
  previewTransfer(input: PreviewTransferInput): Promise<ConversationTurnResult>;
  persistNativeToolState(
    input: PersistNativeToolStateInput,
  ): Promise<ConversationSnapshot>;
  persistNativePreview(
    input: PersistNativePreviewInput,
  ): Promise<NativePreviewCommandResult | Record<string, unknown>>;
  appendNativeMessage(input: {
    conversationId: string;
    userId: string;
    role: "user" | "assistant";
    text: string;
  }): Promise<void>;
  /**
   * DGC-6: create a delegated grant through conversation (Nani voice/text).
   * The model supplies only the versioned recipient and the SOL limits; the
   * chain, rolling window, expiry, and recipient address are resolved here.
   * The result is model-facing and narrates the honest `policyReady` state.
   */
  createDelegatedGrant(
    input: CreateDelegatedGrantInput,
  ): Promise<CreateDelegatedGrantResult>;
}

export type WalletConversationDependencies = {
  conversations: ConversationRepository;
  wallet: WalletProvider;
  walletForUser?: WalletForUser;
  memory?: RecipientMemoryRuntime;
  /**
   * PMU-014: per-request memory runtime for the RESOLVED user. Takes
   * precedence over the fixed `memory` demo tenant when provided.
   */
  memoryForUser?: (userId: string) => RecipientMemoryRuntime | undefined;
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
  grantGate?: {
    evaluate(input: {
      userId: string;
      conversationId: string;
      text: string;
      language: string;
      /** Server-captured request timestamp (epoch ms) from service entry. */
      requestAt: number;
      pendingTransfer: {
        network: string;
        token: string;
        recipient: string;
        amount: string;
      };
    }): Promise<{
      covered: boolean;
      source?: "delegated_grant";
      grantId?: string;
      /** Exact smallest-unit amount (AD-6 claim input). Required when covered. */
      amountSmallestUnits?: string;
      /**
       * ALL statically eligible candidates in Q3 order (AD-4/AD-6): the
       * service claims them sequentially; each rejection falls back to
       * the next.
       */
      orderedCandidates?: Array<{
        grantId: string;
        amountSmallestUnits: string;
      }>;
    } | null>;
  };
  /**
   * slice3-grant-execution (AD-6): the atomic ledger claim — the sole
   * execution authority. Invoked for delegated-grant authorizations BEFORE
   * the single-winner attempt claim; a rejection or error must close the
   * path with no attempt claim and no broadcast. Replay returns the same
   * budget claim; the broadcast still requires winning the attempt gate.
   */
  grantLedger?: {
    claim(input: {
      grantId: string;
      userId: string;
      amount: string;
      idempotencyKey: string;
    }): Promise<{ consumed: boolean; replay?: boolean; reason?: string }>;
    /**
     * AD-10: atomic owned-CAS settlement (attempt CAS + ledger release +
     * `released` audit in ONE user-scoped transaction). Optional for
     * callers that do not settle grants; absent ⇒ no-op.
     */
    settle?(input: {
      userId: string;
      conversationId: string;
      attemptId: string;
      claimId: string;
      grantId: string;
      idempotencyKey: string;
      reason: string;
    }): Promise<void>;
  };
  /**
   * DGC-6: delegated-grant creation seam (Nani). Absent ⇒ grant creation fails
   * closed with `grant_creation_unavailable` instead of inventing a grant.
   */
  grantCreator?: GrantCreator;
};

/** Rolling consumption window for conversation-created grants (one day). */
const GRANT_WINDOW_SECONDS = 86_400;
/** Server-computed grant lifetime (7 days). The model never supplies it. */
const GRANT_TTL_MS = 7 * 86_400_000;
/** Mirror of the HTTP route ceiling: 0.01 SOL = 10,000,000 lamports. */
const GRANT_MAX_PER_TRANSFER_LAMPORTS = 10_000_000n;

/**
 * Parse a positive decimal SOL amount (at most 9 decimals) into lamports.
 * String math only: no float rounding can ever invent or lose a lamport. Returns
 * null for anything non-positive or malformed so callers fail closed.
 */
function solToLamports(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,9})?$/u.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const lamports =
    BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
  return lamports > 0n ? lamports.toString() : null;
}

/** Honest, localized narration for a successful creation (policy state included). */
function grantedMessage(
  language: "es" | "en",
  recipientName: string,
  maxPerTransferSol: string,
  maxCumulativeSol: string,
  policyReady: boolean,
): string {
  if (language === "es") {
    return policyReady
      ? `Listo. Creé una autorización para ${recipientName}: hasta ${maxPerTransferSol} SOL por transferencia y ${maxCumulativeSol} SOL en total, válida por 7 días.`
      : `Creé la autorización para ${recipientName} (hasta ${maxPerTransferSol} SOL por transferencia), pero su política de ejecución todavía no está lista, así que no puede usarse hasta que se complete la configuración.`;
  }
  return policyReady
    ? `Done. I created a grant for ${recipientName}: up to ${maxPerTransferSol} SOL per transfer and ${maxCumulativeSol} SOL in total, valid for 7 days.`
    : `I created the grant for ${recipientName} (up to ${maxPerTransferSol} SOL per transfer), but its execution policy is not ready yet, so it cannot be used until provisioning completes.`;
}

const GRANT_ERROR_COPY = {
  en: {
    recipient_revalidation_required:
      "I could not confirm that contact, so I did not create the grant. Please select the recipient again.",
    recipient_not_solana:
      "Delegated grants only support Solana recipients, so I did not create one for this contact.",
    invalid_amount:
      "The SOL limits are invalid: use positive amounts with at most 9 decimals, and a cumulative limit at least as large as the per-transfer limit.",
    amount_over_ceiling:
      "The per-transfer limit cannot exceed 0.01 SOL, so I did not create the grant.",
    wallet_unavailable:
      "No ready Solana wallet is available for this account, so I could not create the grant.",
    grant_creation_unavailable:
      "Grant creation is unavailable in this session.",
    internal_error:
      "I could not create the grant right now. Please try again.",
  },
  es: {
    recipient_revalidation_required:
      "No pude confirmar ese contacto, así que no creé la autorización. Elegí el destinatario de nuevo.",
    recipient_not_solana:
      "Las autorizaciones delegadas solo funcionan con destinatarios de Solana, así que no creé ninguna para este contacto.",
    invalid_amount:
      "Los límites en SOL no son válidos: usá montos positivos con hasta 9 decimales y un límite acumulado al menos igual al límite por transferencia.",
    amount_over_ceiling:
      "El límite por transferencia no puede superar 0.01 SOL, así que no creé la autorización.",
    wallet_unavailable:
      "No hay una billetera Solana lista para esta cuenta, así que no pude crear la autorización.",
    grant_creation_unavailable:
      "La creación de autorizaciones no está disponible en esta sesión.",
    internal_error:
      "No pude crear la autorización ahora. Probá de nuevo.",
  },
} as const;

function grantErrorResult(
  language: "es" | "en",
  code: keyof (typeof GRANT_ERROR_COPY)["en"],
): CreateDelegatedGrantResult {
  return { status: "error", code, message: GRANT_ERROR_COPY[language][code] };
}

export function createWalletConversationService(
  dependencies: WalletConversationDependencies,
): WalletConversationService {
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const narration = dependencies.narration ?? createNarrationPolicy({ clock });
  const walletForUser = (userId: string, network?: string): WalletProvider =>
    dependencies.walletForUser
      ? bindWalletForUser(dependencies.walletForUser, userId, () =>
          walletChainFamilyForNetwork(
            network ?? getWalletAgentConfig().network,
          ),
        )
      : dependencies.wallet;

  async function* handleTurnStream(
    input: HandleTurnInput,
    requestAt = clock.now(),
  ): AsyncIterable<ConversationEvent> {
    let snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) {
      yield* completedError(input, "conversation_not_found");
      return;
    }

    const language = detectConversationLanguage(input.text, snapshot.language);
    if (
      language !== snapshot.language &&
      dependencies.conversations.setLanguage
    ) {
      const state = await dependencies.conversations.setLanguage(
        input.userId,
        input.conversationId,
        language,
      );
      snapshot = { ...snapshot, ...state, language };
    } else {
      snapshot = { ...snapshot, language };
    }

    if (snapshot.pendingInterpretation) {
      if (isInterpretationRejection(input.text)) {
        const result: ConversationTurnResult = {
          status: "answer",
          message:
            language === "es"
              ? "Descarté esa interpretación. Te escucho."
              : "I discarded that interpretation. I am listening.",
        };
        await clearInterpretation(
          snapshot,
          input.userId,
          dependencies.conversations,
        );
        await appendConversationMessage(
          snapshot,
          input.userId,
          "user",
          input.text,
          dependencies.conversations,
        );
        await appendServiceMessage(
          snapshot,
          input.userId,
          result.message,
          dependencies.conversations,
        );
        yield* emitSpoken(result.message, "answer");
        yield event({ type: "turn-completed", result });
        return;
      }
      if (isInterpretationAcceptance(input.text)) {
        const interpretation = snapshot.pendingInterpretation;
        const assessment = assessFinancialIntent(interpretation);
        if (assessment.decision === "clarify") {
          const message = clarificationForInterpretation(
            interpretation,
            language,
          );
          yield* emitSpoken(message, "answer");
          yield event({
            type: "turn-completed",
            result: {
              status: "clarification_required",
              message,
              candidates: [],
            },
          });
          return;
        }
        await clearInterpretation(
          snapshot,
          input.userId,
          dependencies.conversations,
        );
        const acceptedText =
          interpretation.sourceText ?? renderInterpretation(interpretation);
        yield* handleTurnStream({ ...input, text: acceptedText }, requestAt);
        return;
      }
      await clearInterpretation(
        snapshot,
        input.userId,
        dependencies.conversations,
      );
      snapshot = { ...snapshot, pendingInterpretation: undefined };
    }

    if (snapshot.pendingTransfer && isConfirmation(input.text)) {
      yield* resolveDecision({
        conversationId: input.conversationId,
        userId: input.userId,
        previewId: snapshot.pendingTransfer.previewId ?? "",
        decision: "confirm",
        signal: input.signal,
      });
      return;
    }
    if (snapshot.pendingTransfer && isCancellation(input.text)) {
      yield* resolveDecision({
        conversationId: input.conversationId,
        userId: input.userId,
        previewId: snapshot.pendingTransfer.previewId ?? "",
        decision: "cancel",
        signal: input.signal,
      });
      return;
    }

    const possibleIntent = parsePossibleFinancialIntent(input.text);
    if (possibleIntent) {
      const assessment = assessFinancialIntent(possibleIntent);
      if (assessment.decision === "clarify") {
        const interpretation = {
          ...assessment.interpretation,
          sourceText: input.text,
        };
        await persistInterpretation(
          snapshot,
          input.userId,
          dependencies.conversations,
          interpretation,
        );
        await appendConversationMessage(
          snapshot,
          input.userId,
          "user",
          input.text,
          dependencies.conversations,
        );
        const message = clarificationForInterpretation(
          interpretation,
          language,
        );
        await appendServiceMessage(
          snapshot,
          input.userId,
          message,
          dependencies.conversations,
        );
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(message, "answer");
        yield event({
          type: "turn-completed",
          result: { status: "clarification_required", message, candidates: [] },
        });
        return;
      }
    }

    let workingSnapshot = snapshot;
    if (looksLikeTransfer(input.text)) {
      workingSnapshot = await setProgress(workingSnapshot, {
        phase: "working",
      });
      yield* emit(stateEvent(workingSnapshot));
      yield* emitSpoken(
        narrateFinancialFact({
          language: workingSnapshot.language,
          phase: "started",
        }),
        "started",
      );
    }

    const persistedMessageCount = workingSnapshot.messages.length;
    let result: ConversationTurnResult;
    try {
      const options: HandleMessageOptions = {
        ...(dependencies.model ? { model: dependencies.model } : {}),
        // PMU-014: scope memory to the RESOLVED per-request user; the fixed
        // demo runtime remains only as a backwards-compatible fallback.
        ...(dependencies.memoryForUser
          ? dependencies.memoryForUser(input.userId)
          : dependencies.memory
            ? { recipientMemory: dependencies.memory }
            : {}),
        walletProvider: walletForUser(input.userId),
        ...(input.signal ? { abortSignal: input.signal } : {}),
        language: workingSnapshot.language,
        // DGC-6: thread the same service seam into the text agent so its
        // `create_grant` tool uses the exact recipient/amount guard logic.
        grantService: { createDelegatedGrant },
      };
      result = sanitizeResult(
        await handleMessage(workingSnapshot, input.text, options),
      );
      await dependencies.conversations.saveSnapshot(
        input.userId,
        workingSnapshot,
        persistedMessageCount,
      );
    } catch (error) {
      result = errorResult(error);
      await appendServiceMessage(
        workingSnapshot,
        input.userId,
        result.message,
        dependencies.conversations,
      );
    }

    const updated =
      (await dependencies.conversations.get(
        input.userId,
        input.conversationId,
      )) ?? workingSnapshot;
    const renewed = await renewContextIfSafe(updated);
    const visible = renewed ?? updated;
    if (result.status === "confirmation_required") {
      const pending = visible.pendingTransfer;
      if (dependencies.grantGate && pending?.previewId) {
        // AD-10: winner reservation identity, hoisted so the settle path
        // inside resolveDecision → runFinancialTransfer can use it.
        let claimedGrantId: string | undefined;
        let decision: {
          covered: boolean;
          source?: "delegated_grant";
          grantId?: string;
          amountSmallestUnits?: string;
          orderedCandidates?: Array<{
            grantId: string;
            amountSmallestUnits: string;
          }>;
        } | null = null;
        try {
          decision = await dependencies.grantGate.evaluate({
            userId: input.userId,
            conversationId: input.conversationId,
            text: input.text,
            language: visible.language,
            requestAt,
            pendingTransfer: {
              network: pending.preview.network,
              token: pending.preview.token,
              recipient: pending.preview.recipient,
              amount: pending.preview.amount,
            },
          });
        } catch {
          decision = null;
        }
        if (decision?.covered) {
          // AD-6 sequencing: the atomic ledger claim happens BEFORE the
          // single-winner attempt claim. Candidates are claimed
          // sequentially in Q3 order (AD-4): the first candidate whose
          // claim succeeds is consumed; each rejection (revoked, expired,
          // window/budget exhaustion) falls back to the next candidate —
          // every rejection is audited by the ledger itself. A missing
          // ledger, exhausted candidate list, or any ledger error closes
          // the delegated-grant path with NO attempt claim and NO
          // broadcast (fail closed). A same-key replay returns the same
          // budget claim but never authorizes a broadcast by itself —
          // the broadcast still requires winning claimPendingTransfer.
          const candidates =
            decision.orderedCandidates && decision.orderedCandidates.length > 0
              ? decision.orderedCandidates
              : typeof decision.grantId === "string" &&
                  typeof decision.amountSmallestUnits === "string" &&
                  /^\d+$/.test(decision.amountSmallestUnits)
                ? [
                    {
                      grantId: decision.grantId,
                      amountSmallestUnits: decision.amountSmallestUnits,
                    },
                  ]
                : [];
          const ledger = dependencies.grantLedger;
          let claimed = false;
          if (ledger && candidates.length > 0) {
            for (const candidate of candidates) {
              const { grantId, amountSmallestUnits } = candidate;
              if (
                typeof grantId !== "string" ||
                grantId.length === 0 ||
                typeof amountSmallestUnits !== "string" ||
                !/^\d+$/.test(amountSmallestUnits)
              ) {
                continue; // malformed candidate context ⇒ try next
              }
              try {
                const claim = await ledger.claim({
                  grantId,
                  userId: input.userId,
                  amount: amountSmallestUnits,
                  // Durable persisted attempt id
                  // (conversation_transfer_attempts.id).
                  idempotencyKey: `grant-exec:${input.userId}:${pending.previewId}`,
                });
                if (claim.consumed === true) {
                  claimed = true;
                  // Preserve the winner's reservation identity for the
                  // settle path (AD-10): only the EXACT claimed grant may
                  // be released on definitive non-dispatch.
                  claimedGrantId = grantId;
                  break; // winning candidate charged; proceed to attempt
                }
                // Rejected ⇒ audited by the ledger; try next candidate.
              } catch {
                break; // ledger error ⇒ fail closed
              }
            }
          }
          if (!claimed) {
            decision = null; // exhausted/failed ⇒ degrade to preview flow
          }
        }
        if (decision?.covered) {
          for await (const gateEvent of resolveDecision({
            conversationId: input.conversationId,
            userId: input.userId,
            previewId: pending.previewId,
            decision: "confirm",
            signal: input.signal,
            authorizedBy: decision.source ?? "delegated_grant",
            claimedGrantId,
            // The covered turn must resolve to its TERMINAL result in
            // this turn: wait for the financial task instead of the
            // generic "Transfer is being processed." answer.
            waitForFinancialTask: true,
          })) {
            yield gateEvent;
          }
          return;
        }
      }
      const withProgress = await setProgress(visible, {
        phase: "awaiting_confirmation",
        label: "Transfer preview ready for confirmation",
      });
      yield* emit(stateEvent(withProgress));
      yield* emitSpoken(
        narrateFinancialFact({
          language: withProgress.language,
          phase: "awaiting_confirmation",
          amount: result.preview.amount,
          token: result.preview.token,
        }),
        "decision",
      );
    } else {
      yield* emit(stateEvent(visible));
      yield* emitSpoken(
        spokenResultMessage(result, visible.language),
        result.status === "error" ? "uncertain" : "answer",
      );
    }
    yield event({ type: "turn-completed", result });
  }

  async function* resolveDecision(
    input: ResolveDecisionInput,
  ): AsyncIterable<ConversationEvent> {
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) {
      yield* completedError(
        {
          conversationId: input.conversationId,
          userId: input.userId,
          text: "",
        },
        "conversation_not_found",
      );
      return;
    }
    const pending = snapshot.pendingTransfer;
    if (!pending || pending.previewId !== input.previewId) {
      const result = errorResult(errorFromCode("stale_preview"));
      yield* emit(stateEvent(snapshot));
      yield* emitSpoken(result.message, "answer");
      yield event({ type: "turn-completed", result });
      return;
    }

    if (input.decision === "cancel") {
      const cancellation =
        await dependencies.conversations.cancelPendingTransfer(
          input.userId,
          input.conversationId,
          input.previewId,
        );
      if (cancellation !== "cancelled") {
        const result = errorResult(
          errorFromCode(
            cancellation === "stale_preview"
              ? "stale_preview"
              : "broadcast_in_progress",
          ),
        );
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(result.message, "answer");
        yield event({ type: "turn-completed", result });
        return;
      }
      const result: ConversationTurnResult = {
        status: "cancelled",
        message: "Transfer cancelled.",
      };
      await appendConversationMessage(
        snapshot,
        input.userId,
        "user",
        input.decision,
        dependencies.conversations,
      );
      await appendServiceMessage(
        snapshot,
        input.userId,
        result.message,
        dependencies.conversations,
      );
      const updated =
        (await dependencies.conversations.get(
          input.userId,
          input.conversationId,
        )) ?? snapshot;
      yield* emit(stateEvent(updated));
      yield* emitSpoken(
        spokenResultMessage(result, updated.language),
        "result",
      );
      yield event({ type: "turn-completed", result });
      return;
    }

    const claim = await dependencies.conversations.claimPendingTransfer(
      input.userId,
      input.conversationId,
      input.previewId,
    );
    if (claim.status !== "claimed") {
      // REVIEW FIX V5: a claim over a missing/superseded attempt is `stale_preview`,
      // never `broadcast_in_progress` — the preview no longer exists to be broadcast.
      const code: ConversationErrorCode =
        claim.status === "uncertain"
          ? "broadcast_uncertain"
          : claim.status === "missing"
            ? "stale_preview"
            : "broadcast_in_progress";
      const result = errorResult(errorFromCode(code));
      yield* emit(stateEvent(snapshot));
      yield* emitSpoken(
        result.message,
        claim.status === "uncertain" ? "uncertain" : "answer",
      );
      yield event({ type: "turn-completed", result });
      return;
    }

    // slice3-grant-execution: a grant-covered execution resolved by the
    // server gate appends NO fabricated user "confirm" message — the
    // user's original request plus the active grant is the authorization.
    if (input.authorizedBy !== "delegated_grant") {
      await appendConversationMessage(
        snapshot,
        input.userId,
        "user",
        input.decision,
        dependencies.conversations,
      );
    }
    const claimed = claim.transfer;
    const run = async (): Promise<void> => {
      await runFinancialTransfer({
        ...input,
        claimed,
        claimId: claim.claimId,
        snapshot,
      });
    };
    if (dependencies.financialTasks) {
      const started = dependencies.financialTasks.start({
        operationId: input.previewId,
        run,
      });
      if (started === "already_running") {
        const result = errorResult(errorFromCode("broadcast_in_progress"));
        yield* emit(stateEvent(snapshot));
        yield* emitSpoken(result.message, "answer");
        yield event({ type: "turn-completed", result });
        return;
      }
      const broadcasting =
        (await dependencies.conversations.get(
          input.userId,
          input.conversationId,
        )) ?? snapshot;
      yield* emit(stateEvent(broadcasting));
      yield* emitSpoken(
        narrateFinancialFact({
          language: broadcasting.language,
          phase: "broadcasting",
        }),
        "started",
      );
      const result: ConversationTurnResult = {
        status: "answer",
        message: "Transfer is being processed.",
      };
      if (input.waitForFinancialTask) {
        await dependencies.financialTasks.wait(input.previewId);
        const completed =
          (await dependencies.conversations.get(
            input.userId,
            input.conversationId,
          )) ?? snapshot;
        yield* emit(stateEvent(completed));
        yield event({
          type: "turn-completed",
          result: resultFromFinancialState(completed),
        });
        return;
      }
      yield event({ type: "turn-completed", result });
      return;
    }

    const result = await runFinancialTransfer({
      ...input,
      claimed,
      claimId: claim.claimId,
      snapshot,
    });
    const updated =
      (await dependencies.conversations.get(
        input.userId,
        input.conversationId,
      )) ?? snapshot;
    yield* emit(stateEvent(updated));
    yield* emitSpoken(
      result.message,
      result.status === "error"
        ? "uncertain"
        : result.status === "sent"
          ? "result"
          : "answer",
    );
    yield event({ type: "turn-completed", result });
  }

  /**
   * REVIEW FIX V2 — reusable preview entry point. The realtime voice `send_token`
   * calls this (never duplicating guard logic in livekit): it revalidates the
   * versioned recipient, applies the wallet policy, persists the pending transfer
   * through the repository, and emits the state revision via the same publish path
   * the text service uses (financialTasks + progress) so the frontend card appears.
   */
  async function previewTransfer(
    input: PreviewTransferInput,
  ): Promise<ConversationTurnResult> {
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) return errorResult(errorFromCode("conversation_not_found"));

    const recipient = await resolveRecipientForTransfer(
      input.userId,
      input.recipientId,
      input.recipientVersion,
    );
    if (!recipient.ok)
      return errorResult(errorFromCode("recipient_revalidation_required"));

    const config = getWalletAgentConfig();
    const network = recipient.network ?? config.network;
    const token = recipient.network === "solana-devnet" ? "SOL" : config.token;
    const transferRequest: TransferRequest = {
      network,
      token,
      to: recipient.address,
      amount: input.amount,
      wallet: config.wallet,
    };
    const policyError = validateWalletTransferPolicy(
      { ...transferRequest, dryRun: false },
      policyConfigForTransfer(transferRequest, config),
    );
    if (policyError) return errorResult(errorFromCode("policy_rejected"));

    let preview: TransferPreview;
    try {
      preview = await walletForUser(
        input.userId,
        transferRequest.network,
      ).previewTransfer(transferRequest);
    } catch {
      return errorResult(errorFromCode("wallet_unavailable"));
    }

    const pendingTransfer: PendingTransfer = {
      ...transferRequest,
      preview,
      recipientId: input.recipientId,
      recipientVersion: input.recipientVersion,
    };
    const state = await dependencies.conversations.setPendingTransfer(
      input.userId,
      input.conversationId,
      pendingTransfer,
    );
    await publish(stateEvent(state));

    const message =
      snapshot.language === "es"
        ? `Preparé una transferencia de ${input.amount} ${config.token} para ${recipient.name}. Confirmá para continuar.`
        : `Prepared a ${input.amount} ${config.token} transfer for ${recipient.name}. Confirm to continue.`;
    return { status: "confirmation_required", message, preview };
  }

  /**
   * DGC-6: create a delegated grant through conversation (Nani voice/text).
   * Deterministic gates only: the versioned recipient is revalidated
   * server-side and MUST be a Solana devnet contact, amounts are positive SOL
   * with at most 9 decimals and a per-transfer ceiling of 0.01 SOL, and the
   * rolling window / expiry are server-computed. Wallet identity, chain, and
   * address are never model-supplied. Failures map to typed, narratable
   * results instead of throwing.
   */
  async function createDelegatedGrant(
    input: CreateDelegatedGrantInput,
  ): Promise<CreateDelegatedGrantResult> {
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    const language: "es" | "en" =
      snapshot?.language === "es" ? "es" : "en";

    if (!dependencies.grantCreator) {
      return grantErrorResult(language, "grant_creation_unavailable");
    }

    // Reuse the exact preview-path revalidation: a stale/foreign recipient and
    // any raw address the model tried to supply can never reach the ledger.
    const recipient = await resolveRecipientForTransfer(
      input.userId,
      input.recipientId,
      input.recipientVersion,
    );
    if (!recipient.ok) {
      return grantErrorResult(language, "recipient_revalidation_required");
    }
    if (recipient.network !== "solana-devnet") {
      return grantErrorResult(language, "recipient_not_solana");
    }

    const perTransferLamports = solToLamports(input.maxPerTransferSol);
    const cumulativeLamports = solToLamports(input.maxCumulativeSol);
    if (perTransferLamports === null || cumulativeLamports === null) {
      return grantErrorResult(language, "invalid_amount");
    }
    if (BigInt(perTransferLamports) > GRANT_MAX_PER_TRANSFER_LAMPORTS) {
      return grantErrorResult(language, "amount_over_ceiling");
    }
    if (BigInt(cumulativeLamports) < BigInt(perTransferLamports)) {
      return grantErrorResult(language, "invalid_amount");
    }

    try {
      const created = await dependencies.grantCreator.create({
        userId: input.userId,
        chain: "solana",
        recipients: [recipient.address],
        maxPerTransfer: perTransferLamports,
        maxCumulative: cumulativeLamports,
        windowSeconds: GRANT_WINDOW_SECONDS,
        expiresAt: new Date(clock.now() + GRANT_TTL_MS),
      });
      return {
        status: "created",
        message: grantedMessage(
          language,
          recipient.name,
          input.maxPerTransferSol,
          input.maxCumulativeSol,
          created.policyReady,
        ),
        grantId: created.grantId,
        maxPerTransfer: input.maxPerTransferSol,
        policyReady: created.policyReady,
      };
    } catch (error) {
      if (error instanceof GrantWalletUnavailableError) {
        return grantErrorResult(language, "wallet_unavailable");
      }
      if (error instanceof InvalidGrantInputError) {
        return grantErrorResult(language, "invalid_amount");
      }
      return grantErrorResult(language, "internal_error");
    }
  }

  async function resolveRecipientForTransfer(
    userId: string,
    recipientId: string,
    recipientVersion: number,
  ): Promise<{ ok: true; address: string; name: string; network?: "solana-devnet" } | { ok: false }> {
    if (!recipientId || recipientVersion === undefined || recipientVersion <= 0)
      return { ok: false };
    if (!dependencies.memory) return { ok: false };
    const current = await dependencies.memory.service.getRecipientForVersion(
      userId,
      recipientId,
      recipientVersion,
    );
    if (
      !current ||
      current.id !== recipientId ||
      current.version !== recipientVersion ||
      !isValidRecipientAddress(current.address, current.network)
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      address: current.address,
      name: current.name,
      ...(current.network === "solana-devnet" ? { network: "solana-devnet" as const } : {}),
    };
  }

  async function publish(current: ConversationEvent): Promise<void> {
    await dependencies.progress?.publish(current);
    dependencies.financialTasks?.publish(current);
  }

  async function* emit(
    current: ConversationEvent,
  ): AsyncIterable<ConversationEvent> {
    await publish(current);
    yield current;
  }

  async function* emitSpoken(
    text: string,
    reason:
      | "started"
      | "delayed"
      | "decision"
      | "result"
      | "answer"
      | "uncertain",
  ): AsyncIterable<ConversationEvent> {
    const input = { reason, text };
    if (!narration.shouldNarrate(input)) return;
    narration.remember(input);
    const current: ConversationEvent = {
      type: "spoken-segment",
      id: crypto.randomUUID(),
      text,
      reason,
    };
    await publish(current);
    yield current;
  }

  async function runFinancialTransfer(input: {
    conversationId: string;
    userId: string;
    previewId: string;
    claimId?: string;
    claimedGrantId?: string;
    authorizedBy?: "user" | "delegated_grant";
    claimed: PendingTransfer & { previewId: string };
    snapshot: ConversationSnapshot;
  }): Promise<ConversationTurnResult> {
    const { conversationId, userId, claimed, snapshot } = input;
    const transfer = toTransferRequest(claimed);
    const policyError = validateWalletTransferPolicy(
      { ...transfer, dryRun: false },
      policyConfigForTransfer(transfer, getWalletAgentConfig()),
    );
    const recipientValid = await isClaimedRecipientValid(
      claimed,
      dependencies.memory,
    );
    if (policyError || !recipientValid) {
      // AD-10: preflight rejection is a definitive non-dispatch —
      // settle the reservation ONLY with complete grant identity on
      // the delegated-grant path. Without it: fail closed, retain
      // (never release with empty identities). The legacy
      // broadcasting→previewed reset is replaced here.
      if (
        input.authorizedBy === "delegated_grant" &&
        input.claimId &&
        input.claimedGrantId &&
        dependencies.grantLedger?.settle
      ) {
        await dependencies.grantLedger.settle({
          userId,
          conversationId,
          attemptId: input.previewId,
          claimId: input.claimId,
          grantId: input.claimedGrantId,
          idempotencyKey: `grant-exec:${userId}:${input.previewId}`,
          reason: policyError
            ? "policy_rejected"
            : "recipient_revalidation_required",
        });
        // The reservation key is retired. Any retry must create a new
        // persisted preview and claim a fresh reservation.
        await dependencies.conversations.clearPendingTransfer(
          userId,
          conversationId,
        );
      } else if (input.authorizedBy !== "delegated_grant") {
        // Preserve the existing explicit-user retry behavior. Slice 3's
        // terminal cancellation and fresh-preview rule applies to grants.
        await dependencies.conversations.releasePendingTransferClaim(
          userId,
          conversationId,
        );
      }
      const result = errorResult(
        errorFromCode(
          policyError ? "policy_rejected" : "recipient_revalidation_required",
        ),
      );
      await appendServiceMessage(
        snapshot,
        userId,
        result.message,
        dependencies.conversations,
      );
      const updated =
        (await dependencies.conversations.get(userId, conversationId)) ??
        snapshot;
      await publish(stateEvent(updated));
      await publishSpoken(
        spokenResultMessage(result, updated.language),
        "answer",
      );
      return result;
    }

    const broadcasting =
      (await dependencies.conversations.get(userId, conversationId)) ??
      snapshot;
    const broadcastingState = await setProgress(broadcasting, {
      phase: "broadcasting",
      label: "Transfer is being broadcast.",
    });
    await publish(stateEvent(broadcastingState));
    await publishSpoken(
      narrateFinancialFact({
        language: broadcastingState.language,
        phase: "broadcasting",
      }),
      "started",
    );

    let broadcast;
    try {
      broadcast = await walletForUser(
        userId,
        transfer.network,
      ).broadcastTransfer(transfer);
    } catch (error) {
      broadcast = {
        kind: "uncertain" as const,
        reason:
          error instanceof Error ? error.message : "Wallet provider failed.",
      };
    }

    if (broadcast.kind === "not_dispatched") {
      // AD-10: definitive non-dispatch — settle ONLY with complete
      // grant identity on the delegated-grant path; otherwise retain
      // (fail closed, no empty-identity release). The stale pending
      // transfer is cleared so any retry requires a FRESH persisted
      // preview (the cancelled attempt is never re-opened).
      if (
        input.authorizedBy === "delegated_grant" &&
        input.claimId &&
        input.claimedGrantId &&
        dependencies.grantLedger?.settle
      ) {
        await dependencies.grantLedger.settle({
          userId,
          conversationId,
          attemptId: input.previewId,
          claimId: input.claimId,
          grantId: input.claimedGrantId,
          idempotencyKey: `grant-exec:${userId}:${input.previewId}`,
          reason: "not_dispatched",
        });
        // The settled key is retired: retries require a fresh persisted
        // preview and reservation; the cancelled attempt is never reopened.
        await dependencies.conversations.clearPendingTransfer(
          userId,
          conversationId,
        );
      } else if (input.authorizedBy !== "delegated_grant") {
        // Keep legacy explicit-user behavior independent of grant policy.
        await dependencies.conversations.releasePendingTransferClaim(
          userId,
          conversationId,
        );
      }
      const result = errorResult(errorFromCode("wallet_unavailable"));
      const failed = await setProgress(
        (await dependencies.conversations.get(userId, conversationId)) ??
          snapshot,
        { phase: "failed", label: result.message },
      );
      await appendServiceMessage(
        snapshot,
        userId,
        result.message,
        dependencies.conversations,
      );
      await publish(stateEvent(failed));
      await publishSpoken(
        spokenResultMessage(result, failed.language),
        "result",
      );
      return result;
    }
    if (broadcast.kind === "uncertain") {
      await dependencies.conversations.markPendingTransferUncertain(
        userId,
        conversationId,
      );
      const result = errorResult(errorFromCode("broadcast_uncertain"));
      const uncertain = await setProgress(
        (await dependencies.conversations.get(userId, conversationId)) ??
          snapshot,
        { phase: "uncertain", label: result.message },
      );
      await appendServiceMessage(
        snapshot,
        userId,
        result.message,
        dependencies.conversations,
      );
      await publish(stateEvent(uncertain));
      await publishSpoken(
        spokenResultMessage(result, uncertain.language),
        "uncertain",
      );
      return result;
    }

    const transaction = broadcast.transaction;
    await dependencies.conversations.markTransferSubmitted(
      userId,
      conversationId,
      transaction.transactionHash,
      transaction,
    );
    const verifying = await setProgress(
      (await dependencies.conversations.get(userId, conversationId)) ??
        snapshot,
      {
        phase: "verifying",
        transactionHash: transaction.transactionHash,
        label: "Verifying the transaction.",
      },
    );
    await publish(stateEvent(verifying));
    await publishSpoken(
      narrateFinancialFact({
        language: verifying.language,
        phase: "verifying",
      }),
      "started",
    );

    let finality;
    try {
      finality = await walletForUser(
        userId,
        transaction.network,
      ).waitForFinality({ transaction });
    } catch (error) {
      finality = {
        status: "receipt_invalid" as const,
        transactionHash: transaction.transactionHash,
        network: transaction.network,
        reason:
          error instanceof Error ? error.message : "Receipt validation failed.",
      };
    }

    if (finality.status === "confirmed") {
      await dependencies.conversations.finalizeTransfer(
        userId,
        conversationId,
        {
          status: "confirmed",
          transactionHash: transaction.transactionHash,
          receiptResult: finality,
        },
      );
      const result: ConversationTurnResult = {
        status: "sent",
        message: "Transfer confirmed.",
        transaction,
      };
      await appendServiceMessage(
        snapshot,
        userId,
        result.message,
        dependencies.conversations,
      );
      const completed = await setProgress(
        (await dependencies.conversations.get(userId, conversationId)) ??
          snapshot,
        {
          phase: "completed",
          transactionHash: transaction.transactionHash,
          label: "Transfer confirmed.",
        },
      );
      await publish(stateEvent(completed));
      await publishSpoken(
        narrateFinancialFact({
          language: completed.language,
          phase: "completed",
        }),
        "result",
      );
      return result;
    }

    const isReverted = finality.status === "reverted";
    const code: ConversationErrorCode = isReverted
      ? "transfer_reverted"
      : "transaction_receipt_invalid";
    await dependencies.conversations.finalizeTransfer(userId, conversationId, {
      status: isReverted ? "reverted" : "receipt_invalid",
      transactionHash: transaction.transactionHash,
      receiptResult: finality,
      failure: finality.reason,
    });
    const result = errorResult(errorFromCode(code));
    await appendServiceMessage(
      snapshot,
      userId,
      result.message,
      dependencies.conversations,
    );
    const failed = await setProgress(
      (await dependencies.conversations.get(userId, conversationId)) ??
        snapshot,
      {
        phase: "failed",
        transactionHash: transaction.transactionHash,
        label: result.message,
      },
    );
    await publish(stateEvent(failed));
    await publishSpoken(spokenResultMessage(result, failed.language), "result");
    return result;
  }

  async function publishSpoken(
    text: string,
    reason:
      | "started"
      | "delayed"
      | "decision"
      | "result"
      | "answer"
      | "uncertain",
  ): Promise<void> {
    const input = { reason, text };
    if (!narration.shouldNarrate(input)) return;
    narration.remember(input);
    await publish({
      type: "spoken-segment",
      id: crypto.randomUUID(),
      text,
      reason,
    });
  }

  function resultFromFinancialState(
    snapshot: ConversationSnapshot,
  ): ConversationTurnResult {
    if (
      snapshot.progress?.phase === "completed" &&
      snapshot.lastTransactionHash
    ) {
      const transaction = snapshot.transaction ?? {
        network: snapshot.pendingTransfer?.network ?? "sepolia",
        transactionHash: snapshot.lastTransactionHash,
        explorerUrl: explorerUrlFor(
          snapshot.pendingTransfer?.network ?? "sepolia",
          snapshot.lastTransactionHash,
        ),
      };
      return { status: "sent", message: "Transfer confirmed.", transaction };
    }
    if (snapshot.progress?.phase === "uncertain")
      return errorResult(errorFromCode("broadcast_uncertain"));
    if (snapshot.progress?.phase === "failed") {
      return errorResult(
        errorFromCode(
          snapshot.progress.label
            ?.toLocaleLowerCase("en-US")
            .includes("reverted")
            ? "transfer_reverted"
            : "transaction_receipt_invalid",
        ),
      );
    }
    return { status: "answer", message: "Transfer is being processed." };
  }

  async function handleTurn(
    input: HandleTurnInput,
  ): Promise<ConversationTurnResult> {
    let result: ConversationTurnResult = {
      status: "error",
      message: safeErrorMessage("internal_error"),
      code: "internal_error",
    };
    for await (const current of handleTurnStream(input)) {
      if (current.type === "turn-completed") result = current.result;
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
        status: "error",
        error: "pending_confirmation",
        message:
          "A transfer preview must be confirmed before it can be broadcast.",
      };
    }
    if (snapshot.pendingTransfer || snapshot.transferResolutionState) {
      return {
        status: "error",
        error: "pending_confirmation",
        message:
          "A transfer is waiting for your decision. Confirm or cancel it before preparing another transfer.",
      };
    }
    if (isToolError(input.output)) return input.output;
    const preview = canonicalizeTransferPreview(input.input, input.output);
    if (!preview) {
      return {
        status: "error",
        error: "invalid_tool_result",
        message: safeErrorMessage("invalid_tool_result"),
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
          phase: "awaiting_confirmation",
          label: "Transfer preview ready for confirmation",
        },
      },
      snapshot.messages.length,
    );
    await publish(stateEvent(persisted));
    return {
      status: "preview_created",
      preview,
      previewId: persisted.pendingTransfer?.previewId,
      revision: persisted.revision,
    };
  }

  async function appendNativeMessage(input: {
    conversationId: string;
    userId: string;
    role: "user" | "assistant";
    text: string;
  }): Promise<void> {
    if (!input.text.trim()) return;
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) throw new Error("conversation_not_found");
    await dependencies.conversations.appendMessage(
      input.userId,
      input.conversationId,
      {
        role: input.role,
        content: input.text,
      },
    );
  }

  async function nativeSnapshot(
    input: PersistNativeToolStateInput,
  ): Promise<ConversationSnapshot> {
    if (
      input.session.id !== input.conversationId ||
      !input.conversationId ||
      !input.userId
    ) {
      throw new Error("Native tool session does not match its conversation.");
    }
    const snapshot = await dependencies.conversations.get(
      input.userId,
      input.conversationId,
    );
    if (!snapshot) throw new Error("conversation_not_found");
    return snapshot;
  }

  async function setProgress(
    snapshot: ConversationSnapshot,
    progress: WalletProgress,
  ): Promise<ConversationSnapshot> {
    if (!dependencies.conversations.setProgress) return snapshot;
    const state = await dependencies.conversations.setProgress(
      snapshot.userId,
      snapshot.id,
      progress,
    );
    return { ...snapshot, ...state };
  }

  async function renewContextIfSafe(
    snapshot: ConversationSnapshot,
  ): Promise<ConversationSnapshot | undefined> {
    const configuration = dependencies.contextRenewal;
    if (!configuration || !dependencies.conversations.renewContext)
      return undefined;
    const estimatedTokens = configuration.estimateTokens(snapshot);
    if (!Number.isFinite(estimatedTokens)) return undefined;
    if (!shouldRenewContext(estimatedTokens, configuration.budget, snapshot))
      return undefined;
    const summary = await configuration.summarize(snapshot);
    const decision = evaluateContextRenewal({
      estimatedTokens,
      budget: configuration.budget,
      state: snapshot,
      summary,
      summaryThroughSequence: snapshot.messages.length,
    });
    if (decision.status !== "ready") return undefined;
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
    createDelegatedGrant,
    persistNativeToolState,
    persistNativePreview,
    appendNativeMessage,
  };
}

async function appendServiceMessage(
  snapshot: ConversationSnapshot,
  userId: string,
  text: string,
  repository: ConversationRepository,
): Promise<void> {
  await appendConversationMessage(
    snapshot,
    userId,
    "assistant",
    text,
    repository,
  );
}

async function appendConversationMessage(
  snapshot: ConversationSnapshot,
  userId: string,
  role: "user" | "assistant",
  text: string,
  repository: ConversationRepository,
): Promise<void> {
  appendMessage(snapshot, { role, content: text });
  await repository.appendMessage(userId, snapshot.id, { role, content: text });
}

function event(current: ConversationEvent): ConversationEvent {
  return current;
}

type ActivityState = Pick<
  ConversationSnapshot,
  | "pendingTransfer"
  | "pendingInterpretation"
  | "transferResolutionState"
  | "progress"
> & { revision: number };

function stateEvent(snapshot: ActivityState): ConversationEvent {
  return {
    type: "state-revision",
    revision: snapshot.revision,
    activity: activityFor(snapshot),
  };
}

function activityFor(snapshot: ActivityState): ConversationActivity {
  if (snapshot.pendingInterpretation) return "request_waiting";
  if (snapshot.transferResolutionState === "uncertain") return "uncertain";
  if (snapshot.transferResolutionState === "broadcasting") return "verifying";
  if (
    snapshot.progress?.phase === "working" ||
    snapshot.progress?.phase === "broadcasting"
  )
    return "working";
  if (snapshot.progress?.phase === "verifying") return "verifying";
  if (snapshot.pendingTransfer) return "awaiting_confirmation";
  return "idle";
}

async function persistInterpretation(
  snapshot: ConversationSnapshot,
  userId: string,
  repository: ConversationRepository,
  interpretation: PendingInterpretation,
): Promise<void> {
  snapshot.pendingInterpretation = interpretation;
  if (repository.setPendingInterpretation) {
    const state = await repository.setPendingInterpretation(
      userId,
      snapshot.id,
      interpretation,
    );
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
    const state = await repository.clearPendingInterpretation(
      userId,
      snapshot.id,
    );
    Object.assign(snapshot, state);
  }
}

function renderInterpretation(interpretation: PendingInterpretation): string {
  return `send ${valueForRender(interpretation.amount)} ${valueForRender(interpretation.token)} to ${valueForRender(interpretation.recipient)}`;
}

function valueForRender(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : (value?.[0] ?? "");
}

function spokenResultMessage(
  result: ConversationTurnResult,
  language: "es" | "en",
): string {
  if (language === "en") return result.message;
  if (result.status === "sent") return "La transferencia quedó confirmada.";
  if (result.status === "cancelled") return "Transferencia cancelada.";
  if (result.status === "error") {
    const messages: Record<string, string> = {
      broadcast_uncertain:
        "No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.",
      transfer_reverted: "La transferencia fue revertida en la red.",
      transaction_receipt_invalid:
        "La transferencia fue enviada, pero no pude verificar el comprobante.",
      pending_confirmation:
        "Hay una transferencia esperando tu decisión. Confirmala o cancelala antes de enviar otra instrucción.",
    };
    return messages[result.code] ?? result.message;
  }
  return result.message;
}

function errorResult(
  error: unknown,
): Extract<ConversationTurnResult, { status: "error" }> {
  if (
    !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
    )
  ) {
    // Unexpected failures must be visible in the process log; the generic
    // internal_error response alone made live diagnostics impossible.
    console.error(
      "[conversation] unexpected turn failure:",
      error instanceof Error ? error.stack : error,
    );
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const code = error.code as ConversationErrorCode;
    return { status: "error", code, message: safeErrorMessage(code) };
  }
  return {
    status: "error",
    code: "internal_error",
    message: safeErrorMessage("internal_error"),
  };
}

function sanitizeResult(
  result: ConversationTurnResult,
): ConversationTurnResult {
  if (result.status !== "error") return result;
  const supported = new Set<ConversationErrorCode>([
    "conversation_not_found",
    "conversation_forbidden",
    "stale_revision",
    "pending_confirmation",
    "no_pending_preview",
    "stale_preview",
    "recipient_revalidation_required",
    "policy_rejected",
    "broadcast_in_progress",
    "broadcast_uncertain",
    "transaction_receipt_invalid",
    "transfer_reverted",
    "invalid_tool_result",
    "wallet_unavailable",
    "internal_error",
  ]);
  const code = supported.has(result.code as ConversationErrorCode)
    ? (result.code as ConversationErrorCode)
    : "internal_error";
  return { status: "error", code, message: safeErrorMessage(code) };
}

function isToolError(output: unknown): output is Record<string, unknown> {
  return Boolean(
    output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      typeof (output as { error?: unknown }).error === "string" &&
      typeof (output as { message?: unknown }).message === "string",
  );
}

async function* completedError(
  _input: HandleTurnInput,
  code: ConversationErrorCode,
): AsyncIterable<ConversationEvent> {
  const result = errorResult(errorFromCode(code));
  yield {
    type: "spoken-segment",
    id: crypto.randomUUID(),
    text: result.message,
    reason: "answer",
  };
  yield { type: "turn-completed", result };
}

function toTransferRequest(transfer: PendingTransfer): TransferRequest {
  return {
    network: transfer.network,
    token: transfer.token,
    to: transfer.to,
    amount: transfer.amount,
    wallet: transfer.wallet,
    // CAR-006: the typed confirm flow must carry the persisted previewId so
    // the provider derives its Circle idempotency key from it.
    ...(transfer.previewId ? { previewId: transfer.previewId } : {}),
  };
}

function policyConfigForTransfer(
  transfer: Pick<TransferRequest, "network" | "token">,
  config: ReturnType<typeof getWalletAgentConfig>,
) {
  if (transfer.network === "solana-devnet" && transfer.token === "SOL") {
    return { ...config, network: "solana-devnet", token: "SOL" };
  }
  return config;
}

async function isClaimedRecipientValid(
  transfer: PendingTransfer,
  memory?: RecipientMemoryRuntime,
): Promise<boolean> {
  if (!transfer.recipientId || transfer.recipientVersion === undefined)
    return true;
  if (!memory) return false;
  const current = await memory.service.getRecipientForVersion(
    memory.userId,
    transfer.recipientId,
    transfer.recipientVersion,
  );
  const expectedNetwork = transfer.network === "solana-devnet" ? "solana-devnet" : undefined;
  return Boolean(
    current &&
      current.id === transfer.recipientId &&
      current.version === transfer.recipientVersion &&
      current.network === expectedNetwork &&
      isValidRecipientAddress(current.address, current.network) &&
      current.address === transfer.to,
  );
}

function looksLikeTransfer(text: string): boolean {
  return /\b(send|transfer|pay|mand[aá]|transfer[ií]|envi[aá])\b/iu.test(text);
}
