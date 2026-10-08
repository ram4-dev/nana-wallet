import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgenteAvatar } from "@/components/agente/AgenteAvatar";
import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, createConversationTurnSender, getErrorMessage, queryKeys } from "@/lib/api";
import { ARC_TESTNET_CHAIN_ID } from "@/lib/api-types";
import type { ConversationTurnResult } from "@/lib/api-types";
import {
  runExclusiveConversationAction,
  shouldLockAfterConversationResolution,
  UNKNOWN_CONVERSATION_OUTCOME_MESSAGE,
} from "@/lib/session-action-lock";
import { classifySessionSubmission, getSessionControlState } from "@/lib/session-resolution";
import { AgentAudioUnlock } from "@/features/agent/AgentAudioUnlock";
import { useLiveVoiceSession } from "@/features/agent/useLiveVoiceSession";
import { useConversationState } from "@/features/agent/useConversationState";
import { createLiveKitWebClient } from "@/features/agent/voice/livekit-web-client";
import type { LiveVoiceEvent } from "@/features/agent/voice/live-voice-reducer";
import { useNotificationsFeed } from "@/features/notifications/useNotificationsFeed";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Agente | Nana Wallet" },
      {
        name: "description",
        content:
          "Hablá con tu agente y resolvé pagos, transferencias y recordatorios sin complicaciones.",
      },
      { property: "og:title", content: "Agente | Nana Wallet" },
      {
        property: "og:description",
        content: "Tu asistente de confianza para pagar y transferir en pesos.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  pendingComponent: () => <RoutePending label="Estamos preparando al agente" />,
  errorComponent: ({ error, reset }) => <RouteError error={error} onRetry={reset} />,
  component: AgentePage,
});

function AgentePage() {
  const queryClient = useQueryClient();
  const notifications = useNotificationsFeed();
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const sessionActionLockRef = useRef(false);
  const confirmationPendingRef = useRef(false);
  const sessionActionsLockedRef = useRef(false);
  const [turn, setTurn] = useState<ConversationTurnResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [isSessionActionPending, setIsSessionActionPending] = useState(false);
  const [isConfirmationPending, setIsConfirmationPending] = useState(false);
  const [areSessionActionsLocked, setAreSessionActionsLocked] = useState(false);
  const [isEndingLive, setIsEndingLive] = useState(false);
  const [showEndLiveAcknowledgement, setShowEndLiveAcknowledgement] = useState(false);
  const liveDispatchRef = useRef<(event: LiveVoiceEvent) => void>(() => undefined);
  const conversationRevisionRef = useRef<(revision: number) => void>(() => undefined);
  const conversationRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const conversation = useConversationState(conversationId, (id) => {
    conversationIdRef.current = id;
    setConversationId(id);
  });
  // Every platform — browser and packaged WebView — speaks through LiveKit. There
  // is no recorded-voice transport for the native shell to fall back to.
  const voiceClient = useMemo(
    () =>
      createLiveKitWebClient({
        getConversationId: () => conversationIdRef.current,
        onConversationBound: (id) => {
          conversationIdRef.current = id;
          setConversationId(id);
        },
        onAgentState: (state) => {
          const accepted = [
            "connecting",
            "initializing",
            "idle",
            "listening",
            "thinking",
            "speaking",
            "failed",
          ] as const;
          if (accepted.includes(state as (typeof accepted)[number])) {
            liveDispatchRef.current({
              type: "AGENT_STATE",
              state: state as (typeof accepted)[number],
            });
          }
        },
        onRevision: (revision) => conversationRevisionRef.current(revision),
        onConnectionLost: () =>
          liveDispatchRef.current({ type: "CONNECTION_LOST", now: Date.now() }),
        onReconnected: () => {
          void conversationRefreshRef.current().finally(() => {
            liveDispatchRef.current({ type: "RECONNECTED" });
          });
        },
      }),
    [],
  );
  const liveVoice = useLiveVoiceSession(voiceClient, {
    onConversationBound: (id) => {
      conversationIdRef.current = id;
      setConversationId(id);
    },
    onTypedFallback: (reason) => setMessage(reason.message),
  });
  liveDispatchRef.current = liveVoice.dispatch;
  conversationRevisionRef.current = (revision) => {
    conversation.refreshRevision(revision);
    notifications.refreshFromConversationRevision(revision);
  };
  conversationRefreshRef.current = conversation.refresh;
  const sendConversationTurn = useMemo(
    () =>
      createConversationTurnSender(
        () => conversationIdRef.current,
        (nextConversationId) => {
          conversationIdRef.current = nextConversationId;
          setConversationId(nextConversationId);
        },
      ),
    [],
  );

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const userId = meQuery.data?.userId;

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements(userId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills(userId) });
    // WP-014: money refreshes also invalidate the personal balances cache
    // for the CURRENT user only (user-scoped key root "balances").
    if (userId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.balances(userId, ARC_TESTNET_CHAIN_ID),
      });
    }
  }

  // WP-014: the authoritative conversation state reaching a confirmed
  // transaction invalidates balances exactly once per transaction hash.
  // This covers the text path (sent turn → state), the button decision
  // (decide → refresh(revision)) and the voice path (refreshRevision),
  // without extra dispatches and without touching preview/confirm/idempotency.
  const lastInvalidatedTransactionRef = useRef<string | null>(null);
  const confirmedTransactionHash = conversation.state?.transaction?.transactionHash ?? null;
  useEffect(() => {
    if (!confirmedTransactionHash || !userId) return;
    if (lastInvalidatedTransactionRef.current === confirmedTransactionHash) return;
    lastInvalidatedTransactionRef.current = confirmedTransactionHash;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.balances(userId, ARC_TESTNET_CHAIN_ID),
    });
  }, [confirmedTransactionHash, userId, queryClient]);

  function lockUnknownOutcome() {
    confirmationPendingRef.current = false;
    sessionActionsLockedRef.current = true;
    setIsConfirmationPending(false);
    setAreSessionActionsLocked(true);
    setTurn(null);
    setMessage(UNKNOWN_CONVERSATION_OUTCOME_MESSAGE);
    refreshMoneyQueries();
  }

  function sendTurn(nextMessage: string, kind: "new" | "resolution" = "new") {
    if (sessionActionsLockedRef.current) return;
    if (kind === "new" && confirmationPendingRef.current) return;

    const request = runExclusiveConversationAction(sessionActionLockRef, async () => {
      setIsSessionActionPending(true);
      setMessage(null);
      try {
        const nextTurn = await sendConversationTurn(nextMessage);
        void conversation.refresh();
        if (kind === "resolution" && shouldLockAfterConversationResolution(nextTurn, "response")) {
          lockUnknownOutcome();
          return;
        }

        const nextConfirmationPending = nextTurn.status === "confirmation_required";
        confirmationPendingRef.current = nextConfirmationPending;
        setIsConfirmationPending(nextConfirmationPending);
        setTurn(nextTurn);
        setMessage(nextTurn.status === "error" ? nextTurn.message : null);
        if (nextTurn.status === "sent") refreshMoneyQueries();
      } catch (error) {
        if (kind === "resolution" && shouldLockAfterConversationResolution(error, "thrown")) {
          lockUnknownOutcome();
        } else {
          setMessage(getErrorMessage(error));
        }
      } finally {
        setIsSessionActionPending(false);
      }
    });

    void request;
  }

  function submitSessionText(rawMessage: string) {
    const cleanText = rawMessage.trim();
    if (!cleanText) return;

    const submission = classifySessionSubmission(cleanText, confirmationPendingRef.current);
    if (submission.kind === "blocked") {
      setMessage(
        "Hay una transferencia esperando tu decisión. Escribí “confirmar la transferencia” o “cancelar la transferencia”.",
      );
      return;
    }

    sendTurn(submission.message, submission.kind);
  }

  function sendText() {
    const cleanText = text.trim();
    if (!cleanText) return;

    setText("");
    setLastTranscript(null);
    submitSessionText(cleanText);
  }

  function rejectProposal() {
    if (!conversation.state?.pendingTransfer) {
      sendTurn("cancelar la transferencia", "resolution");
      return;
    }
    void resolveDecision("cancel");
  }

  function confirmProposal() {
    if (!conversation.state?.pendingTransfer) {
      sendTurn("confirmar la transferencia", "resolution");
      return;
    }
    void resolveDecision("confirm");
  }

  async function resolveDecision(decision: "confirm" | "cancel") {
    const response = await conversation[decision]();
    if (response) {
      setTurn(null);
      setMessage(null);
      setIsConfirmationPending(false);
      confirmationPendingRef.current = false;
      void conversation.refresh(response.revision);
    }
  }

  async function endLiveConversation(acknowledgeUnresolvedFinancialWork = false) {
    if (conversation.state?.mode !== "live") return;
    const hasUnresolvedFinancialWork = Boolean(
      conversation.state.pendingTransfer ||
      ["working", "verifying", "uncertain"].includes(conversation.state.activity ?? ""),
    );
    if (hasUnresolvedFinancialWork && !acknowledgeUnresolvedFinancialWork) {
      setShowEndLiveAcknowledgement(true);
      return;
    }
    setIsEndingLive(true);
    const ended = await conversation.endLive(acknowledgeUnresolvedFinancialWork);
    if (ended) {
      setShowEndLiveAcknowledgement(false);
      await liveVoice.endConversation();
    }
    setIsEndingLive(false);
  }

  if (meQuery.isPending) return <RoutePending label="Estamos preparando al agente" />;
  if (meQuery.isError) {
    return <RouteError error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  const livePhase = liveVoice.state.phase;
  const liveSessionActive = livePhase !== "idle" && livePhase !== "failed";
  const isAgentWorking =
    isSessionActionPending ||
    conversation.state?.activity === "working" ||
    conversation.state?.activity === "verifying" ||
    livePhase === "connecting" ||
    livePhase === "binding" ||
    livePhase === "thinking";
  const agentState =
    livePhase === "listening"
      ? "escuchando"
      : livePhase === "speaking"
        ? "listo"
        : livePhase === "reconnecting" || livePhase === "failed" || livePhase === "thinking"
          ? "pensando"
          : isAgentWorking
            ? "pensando"
            : turn?.status === "confirmation_required"
              ? "esperando_confirmacion"
              : turn?.status === "error"
                ? "no_entendi"
                : "listo";
  const agentStatus =
    livePhase === "connecting"
      ? "Conectando con Nani"
      : livePhase === "binding"
        ? "Preparando la conversación"
        : livePhase === "listening"
          ? "Te estoy escuchando"
          : livePhase === "muted"
            ? "Micrófono pausado"
            : livePhase === "speaking"
              ? "Nani está hablando"
              : livePhase === "reconnecting"
                ? "Reconectando"
                : livePhase === "paused"
                  ? "Sesión pausada. Tocá para continuar"
                  : livePhase === "request_waiting"
                    ? "Tu solicitud está esperando"
                    : livePhase === "failed"
                      ? liveVoice.state.reason.message
                      : isAgentWorking
                        ? "Estoy resolviéndolo"
                        : turn?.status === "confirmation_required"
                          ? "Esperando que revises"
                          : turn?.status === "error"
                            ? "No te entendí bien"
                            : turn
                              ? "Estoy listo para ayudarte"
                              : null;
  const controls = getSessionControlState({
    isAgentWorking,
    isConfirmationPending,
    areSessionActionsLocked,
  });
  const textDisabled = controls.textDisabled || liveSessionActive;
  const canonicalPreview = conversation.state?.pendingTransfer;
  const displayedTurn =
    turn?.status === "confirmation_required" && canonicalPreview
      ? { ...turn, preview: canonicalPreview }
      : (turn ??
        (canonicalPreview
          ? {
              status: "confirmation_required" as const,
              message: "Revisá esta transferencia antes de confirmar.",
              preview: canonicalPreview,
            }
          : null));

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col items-center overflow-hidden px-4 !pt-[max(0.75rem,env(safe-area-inset-top))] !pb-[calc(7.25rem+env(safe-area-inset-bottom))] sm:px-6">
      <h1 className="shrink-0 text-center text-2xl leading-tight font-extrabold sm:text-3xl">
        <span className="block">Hola, soy Nani.</span>
        <span className="mt-1 block">Hablame.</span>
      </h1>

      <div className="relative mt-2 flex shrink-0 flex-col items-center sm:mt-3">
        <button
          type="button"
          className={`agent-stage press agent-stage--${livePhase} relative flex size-[clamp(7.5rem,25dvh,12rem)] items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-80 ${
            livePhase === "listening" ? "listening" : ""
          }`}
          data-live-phase={livePhase}
          aria-label={
            livePhase === "speaking" ? "Interrumpir a Nani" : (agentStatus ?? "Hablar con Nani")
          }
          aria-busy={["connecting", "binding", "thinking", "reconnecting"].includes(livePhase)}
          aria-pressed={livePhase === "listening"}
          onClick={() => void liveVoice.handleAvatarPress()}
          disabled={[
            "connecting",
            "binding",
            "reconnecting",
            "thinking",
            "request_waiting",
          ].includes(livePhase)}
        >
          <AgenteAvatar estado={agentState} livePhase={livePhase} size={192} />
        </button>

        <div className="mt-2 flex items-center gap-2">
          {agentStatus ? (
            <span className="rounded-full bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground sm:text-base">
              {agentStatus}
            </span>
          ) : null}
        </div>
        {liveSessionActive && !showEndLiveAcknowledgement ? (
          <Button
            type="button"
            variant="ghost"
            className="press min-h-10 text-sm"
            onClick={() => void endLiveConversation()}
            disabled={isEndingLive}
          >
            Terminar conversación
          </Button>
        ) : null}
      </div>

      <AgentAudioUnlock
        blocked={liveSessionActive && liveVoice.audioBlocked}
        intro={liveVoice.agentTranscript}
        onUnlock={() => void liveVoice.unlockAudio()}
      />

      {liveSessionActive && showEndLiveAcknowledgement ? (
        <section
          className="mt-3 w-full rounded-2xl border border-warning bg-warning-surface p-4 text-warning-surface-foreground"
          role="alertdialog"
          aria-labelledby="end-live-title"
          aria-describedby="end-live-description"
        >
          <p id="end-live-title" className="font-extrabold">
            Hay una acción financiera pendiente
          </p>
          <p id="end-live-description" className="mt-1 text-sm font-bold">
            Terminar la voz no cancela la transferencia ni su verificación.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12 whitespace-normal font-extrabold"
              onClick={() => setShowEndLiveAcknowledgement(false)}
              autoFocus
            >
              Seguir hablando
            </Button>
            <Button
              type="button"
              className="min-h-12 whitespace-normal font-extrabold"
              onClick={() => void endLiveConversation(true)}
              disabled={isEndingLive}
            >
              Terminar voz
            </Button>
          </div>
        </section>
      ) : null}

      <div
        className="mt-3 min-h-0 w-full flex-1 space-y-3 overflow-y-auto overscroll-contain pb-2 [scrollbar-gutter:stable]"
        aria-live="polite"
      >
        {conversation.state?.progress ? (
          <section className="surface-card p-4" role="status">
            <p className="text-base font-extrabold">
              {conversation.state.progress.label ?? "Estoy trabajando en tu solicitud."}
            </p>
          </section>
        ) : null}
        {displayedTurn ? (
          <section className="surface-card p-4">
            {lastTranscript && !liveSessionActive && turn?.status === "confirmation_required" ? (
              <div className="mb-3 rounded-2xl bg-secondary px-4 py-3">
                <p className="text-sm font-bold text-muted-foreground">Nani entendió:</p>
                <p className="mt-0.5 text-base font-extrabold">“{lastTranscript}”</p>
              </div>
            ) : null}
            <p className="text-base leading-snug">{displayedTurn.message}</p>
            {displayedTurn.status === "confirmation_required" ? (
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm sm:text-base">
                <dt className="font-bold">Monto</dt>
                <dd className="text-right">
                  {displayedTurn.preview.amount} {displayedTurn.preview.token}
                </dd>
                <dt className="font-bold">Destino</dt>
                <dd className="truncate text-right" title={displayedTurn.preview.recipient}>
                  {displayedTurn.preview.recipient}
                </dd>
                <dt className="font-bold">Red</dt>
                <dd className="text-right">{displayedTurn.preview.network}</dd>
                <dt className="font-bold">Costo</dt>
                <dd className="text-right">{displayedTurn.preview.estimatedFee}</dd>
              </dl>
            ) : null}
          </section>
        ) : null}

        {displayedTurn?.status === "confirmation_required" || canonicalPreview ? (
          <div className="grid w-full grid-cols-1">
            <Button
              variant="outline"
              className="press min-h-12 whitespace-normal text-base font-extrabold"
              onClick={rejectProposal}
              disabled={
                isSessionActionPending || areSessionActionsLocked || conversation.isActionPending
              }
            >
              Cancelar
            </Button>
            <Button
              className="press mt-2 min-h-12 whitespace-normal text-base font-extrabold"
              onClick={confirmProposal}
              disabled={
                isSessionActionPending || areSessionActionsLocked || conversation.isActionPending
              }
            >
              Confirmar
            </Button>
          </div>
        ) : null}

        {message ? (
          <p
            className="rounded-2xl bg-destructive-surface text-destructive-surface-foreground border border-border px-4 py-3 text-base font-bold"
            role="alert"
          >
            {message}
          </p>
        ) : null}
        {conversation.error || conversation.state?.error ? (
          <p
            className="rounded-2xl border border-border bg-destructive-surface px-4 py-3 text-base font-bold"
            role="alert"
          >
            {conversation.error ?? conversation.state?.error?.message}
          </p>
        ) : null}
        {conversation.state?.transaction ? (
          <section className="surface-card p-4" role="status">
            <p className="text-base font-extrabold">Transferencia confirmada</p>
            <a
              className="mt-2 block truncate text-sm font-bold text-primary underline"
              href={conversation.state.transaction.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {conversation.state.transaction.transactionHash}
            </a>
          </section>
        ) : null}
      </div>

      <form
        className="mt-2 flex w-full shrink-0 items-center gap-1 rounded-full border border-input bg-card p-1 focus-within:ring-4 focus-within:ring-ring/20"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            liveSessionActive
              ? "La voz está activa"
              : isConfirmationPending
                ? "Confirmar o cancelar"
                : "Escribime acá"
          }
          aria-label="Mensaje para el agente"
          disabled={textDisabled}
          className="h-10 min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2 text-base shadow-none focus-visible:ring-0 md:text-base"
        />
        <Button
          type="submit"
          size="icon"
          className="press size-10 shrink-0 rounded-full"
          aria-label="Enviar mensaje"
          disabled={textDisabled || !text.trim()}
        >
          <Send className="size-5" strokeWidth={2.4} />
        </Button>
      </form>
    </main>
  );
}
