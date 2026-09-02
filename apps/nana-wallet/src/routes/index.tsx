import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Send, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

import { AgenteAvatar } from "@/components/agente/AgenteAvatar";
import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, createConversationTurnSender, getErrorMessage, queryKeys } from "@/lib/api";
import type { ConversationTurnResult } from "@/lib/api-types";
import {
  runExclusiveConversationAction,
  shouldLockAfterConversationResolution,
  UNKNOWN_CONVERSATION_OUTCOME_MESSAGE,
} from "@/lib/session-action-lock";
import { classifySessionSubmission, getSessionControlState } from "@/lib/session-resolution";
import { useVoicePlayback } from "@/lib/use-voice-playback";
import { useLiveVoiceSession } from "@/features/agent/useLiveVoiceSession";
import { useConversationState } from "@/features/agent/useConversationState";
import { createLiveKitWebClient } from "@/features/agent/voice/livekit-web-client";
import { createRecordedVoiceClient } from "@/features/agent/voice/recorded-voice-client";
import type { LiveVoiceEvent } from "@/features/agent/voice/live-voice-reducer";

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

const MAX_RECORDING_MS = 20_000;

function readBlobAsBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function AgentePage() {
  const isNative = Capacitor.isNativePlatform();
  const queryClient = useQueryClient();
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
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const startRecordingRef = useRef<() => Promise<void>>(async () => undefined);
  const stopRecordingRef = useRef<() => void>(() => undefined);
  const { isMuted, toggleMuted, speak: speakReply } = useVoicePlayback();
  const liveDispatchRef = useRef<(event: LiveVoiceEvent) => void>(() => undefined);
  const conversationRevisionRef = useRef<(revision: number) => void>(() => undefined);
  const conversationRefreshRef = useRef<() => Promise<void>>(async () => undefined);
  const conversation = useConversationState(conversationId, (id) => {
    conversationIdRef.current = id;
    setConversationId(id);
  });
  const voiceClient = useMemo(
    () =>
      isNative
        ? createRecordedVoiceClient({
            start: () => startRecordingRef.current(),
            stop: async () => stopRecordingRef.current(),
          })
        : createLiveKitWebClient({
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
    [isNative],
  );
  const liveVoice = useLiveVoiceSession(voiceClient, {
    onConversationBound: (id) => {
      conversationIdRef.current = id;
      setConversationId(id);
    },
    onTypedFallback: (reason) => setMessage(reason.message),
  });
  liveDispatchRef.current = liveVoice.dispatch;
  conversationRevisionRef.current = conversation.refreshRevision;
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

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      if (recordingTimeoutRef.current !== null) {
        window.clearTimeout(recordingTimeoutRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills });
  }

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
        void speakReply(nextTurn.message);
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

  async function startRecording() {
    if (isSessionActionPending || areSessionActionsLocked || sessionActionLockRef.current) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("Este teléfono no pudo abrir el micrófono. Podés escribirme abajo.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(
        stream,
        preferredMimeType ? { mimeType: preferredMimeType } : undefined,
      );
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (recordingTimeoutRef.current !== null) {
          window.clearTimeout(recordingTimeoutRef.current);
          recordingTimeoutRef.current = null;
        }
        const mimeType = recorder.mimeType || preferredMimeType || "audio/mp4";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);

        if (blob.size === 0) {
          setMessage("No llegué a escuchar nada. Tocá a Nani y probá de nuevo.");
          return;
        }

        setIsPreparingAudio(true);
        void readBlobAsBase64(blob)
          .then((audioBase64) => api.transcribeAgentAudio({ audioBase64, mimeType }))
          .then(({ transcript }) => {
            const cleanTranscript = transcript.trim();
            if (!cleanTranscript) {
              setMessage("No llegué a entenderte. Tocá a Nani y probá de nuevo.");
              return;
            }
            setLastTranscript(cleanTranscript);
            submitSessionText(cleanTranscript);
          })
          .catch((error) => setMessage(getErrorMessage(error)))
          .finally(() => setIsPreparingAudio(false));
      };
      recorderRef.current = recorder;
      recorder.start();
      recordingTimeoutRef.current = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORDING_MS);
      setIsRecording(true);
      if (!confirmationPendingRef.current) setTurn(null);
      setLastTranscript(null);
      setMessage(null);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setMessage("No pude usar el micrófono. Revisá el permiso o escribime abajo.");
    }
  }

  function handleMicrophone() {
    if (isRecording) {
      stopRecording();
      return;
    }
    void startRecording();
  }

  function stopRecording() {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
  }

  startRecordingRef.current = startRecording;
  stopRecordingRef.current = stopRecording;

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
  const liveSessionActive = !isNative && livePhase !== "idle" && livePhase !== "failed";
  const isAgentWorking =
    isPreparingAudio ||
    isSessionActionPending ||
    conversation.state?.activity === "working" ||
    conversation.state?.activity === "verifying" ||
    livePhase === "connecting" ||
    livePhase === "binding" ||
    livePhase === "thinking";
  const agentState =
    !isNative && livePhase === "listening"
      ? "escuchando"
      : !isNative && livePhase === "speaking"
        ? "listo"
        : !isNative &&
            (livePhase === "reconnecting" || livePhase === "failed" || livePhase === "thinking")
          ? "pensando"
          : isRecording
            ? "escuchando"
            : isAgentWorking
              ? "pensando"
              : turn?.status === "confirmation_required"
                ? "esperando_confirmacion"
                : turn?.status === "error"
                  ? "no_entendi"
                  : "listo";
  const agentStatus =
    !isNative && livePhase === "connecting"
      ? "Conectando con Nani"
      : !isNative && livePhase === "binding"
        ? "Preparando la conversación"
        : !isNative && livePhase === "listening"
          ? "Te estoy escuchando"
          : !isNative && livePhase === "muted"
            ? "Micrófono pausado"
            : !isNative && livePhase === "speaking"
              ? "Nani está hablando"
              : !isNative && livePhase === "reconnecting"
                ? "Reconectando"
                : !isNative && livePhase === "paused"
                  ? "Sesión pausada. Tocá para continuar"
                  : !isNative && livePhase === "request_waiting"
                    ? "Tu solicitud está esperando"
                    : !isNative && livePhase === "failed"
                      ? liveVoice.state.reason.message
                      : isRecording
                        ? "Te estoy escuchando"
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
    isRecording,
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
            isRecording || livePhase === "listening" ? "listening" : ""
          }`}
          data-live-phase={livePhase}
          aria-label={
            isNative
              ? isRecording
                ? "Terminar de hablar con Nani"
                : "Hablar con Nani"
              : livePhase === "speaking"
                ? "Interrumpir a Nani"
                : (agentStatus ?? "Hablar con Nani")
          }
          aria-busy={["connecting", "binding", "thinking", "reconnecting"].includes(livePhase)}
          aria-pressed={isNative ? isRecording : livePhase === "listening"}
          onClick={isNative ? handleMicrophone : () => void liveVoice.handleAvatarPress()}
          disabled={
            isNative
              ? !isRecording && controls.microphoneDisabled
              : ["connecting", "binding", "reconnecting", "thinking", "request_waiting"].includes(
                  livePhase,
                )
          }
        >
          <AgenteAvatar estado={agentState} livePhase={livePhase} size={192} />
          {isNative && isRecording ? (
            <div className="sound-waves" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          ) : null}
        </button>

        <div className="mt-2 flex items-center gap-2">
          {agentStatus ? (
            <span className="rounded-full bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground sm:text-base">
              {agentStatus}
            </span>
          ) : null}
          {isNative ? (
            <Button
              type="button"
              variant="ghost"
              className="press size-11 shrink-0 rounded-full text-muted-foreground"
              aria-label={isMuted ? "Activar la voz de Nani" : "Silenciar la voz de Nani"}
              aria-pressed={isMuted}
              onClick={toggleMuted}
            >
              {isMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </Button>
          ) : null}
        </div>
        {!isNative && liveSessionActive && !showEndLiveAcknowledgement ? (
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

      {!isNative && liveSessionActive && showEndLiveAcknowledgement ? (
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

      {isNative && isRecording ? (
        <p
          className="mt-3 shrink-0 rounded-2xl bg-warning-surface text-warning-surface-foreground border border-border px-4 py-3 text-center text-base font-bold"
          role="status"
        >
          Hablá y tocá a Nani al terminar. Se envía sola a los 20 segundos.
        </p>
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
