import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Send, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgenteAvatar } from "@/components/agente/AgenteAvatar";
import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, createSessionMessageSender, getErrorMessage, queryKeys } from "@/lib/api";
import type { SessionMessageResponse } from "@/lib/api-types";
import {
  runExclusiveSessionAction,
  shouldLockAfterSessionResolution,
  UNKNOWN_SESSION_OUTCOME_MESSAGE,
} from "@/lib/session-action-lock";
import { classifySessionSubmission, getSessionControlState } from "@/lib/session-resolution";
import { useVoicePlayback } from "@/lib/use-voice-playback";

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
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionActionLockRef = useRef(false);
  const confirmationPendingRef = useRef(false);
  const sessionActionsLockedRef = useRef(false);
  const [turn, setTurn] = useState<SessionMessageResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [isSessionActionPending, setIsSessionActionPending] = useState(false);
  const [isConfirmationPending, setIsConfirmationPending] = useState(false);
  const [areSessionActionsLocked, setAreSessionActionsLocked] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const { isMuted, toggleMuted, speak: speakReply } = useVoicePlayback();
  const sendSessionMessage = useMemo(
    () =>
      createSessionMessageSender(
        () => sessionIdRef.current,
        (nextSessionId) => {
          sessionIdRef.current = nextSessionId;
          setSessionId(nextSessionId);
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
    setMessage(UNKNOWN_SESSION_OUTCOME_MESSAGE);
    refreshMoneyQueries();
  }

  function sendTurn(nextMessage: string, kind: "new" | "resolution" = "new") {
    if (sessionActionsLockedRef.current) return;
    if (kind === "new" && confirmationPendingRef.current) return;

    const request = runExclusiveSessionAction(sessionActionLockRef, async () => {
      setIsSessionActionPending(true);
      setMessage(null);
      try {
        const nextTurn = await sendSessionMessage(nextMessage);
        if (kind === "resolution" && shouldLockAfterSessionResolution(nextTurn, "response")) {
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
        if (kind === "resolution" && shouldLockAfterSessionResolution(error, "thrown")) {
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
      if (recordingTimeoutRef.current !== null) {
        window.clearTimeout(recordingTimeoutRef.current);
        recordingTimeoutRef.current = null;
      }
      recorderRef.current?.stop();
      return;
    }
    void startRecording();
  }

  function rejectProposal() {
    sendTurn("cancelar la transferencia", "resolution");
  }

  if (meQuery.isPending) return <RoutePending label="Estamos preparando al agente" />;
  if (meQuery.isError) {
    return <RouteError error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  const isAgentWorking = isPreparingAudio || isSessionActionPending;
  const agentState = isRecording
    ? "escuchando"
    : isAgentWorking
      ? "pensando"
      : turn?.status === "confirmation_required"
        ? "esperando_confirmacion"
        : turn?.status === "error"
          ? "no_entendi"
          : "listo";
  const agentStatus = isRecording
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

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col items-center overflow-hidden px-4 !pt-[max(0.75rem,env(safe-area-inset-top))] !pb-[calc(7.25rem+env(safe-area-inset-bottom))] sm:px-6">
      <h1 className="shrink-0 text-center text-2xl leading-tight font-extrabold sm:text-3xl">
        <span className="block">Hola, soy Nani.</span>
        <span className="mt-1 block">Hablame.</span>
      </h1>

      <div className="relative mt-2 flex shrink-0 flex-col items-center sm:mt-3">
        <button
          type="button"
          className={`agent-stage press relative flex size-[clamp(7.5rem,25dvh,12rem)] items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-80 ${
            isRecording ? "listening" : ""
          }`}
          aria-label={isRecording ? "Terminar de hablar con Nani" : "Hablar con Nani"}
          aria-pressed={isRecording}
          onClick={handleMicrophone}
          disabled={!isRecording && controls.microphoneDisabled}
        >
          <AgenteAvatar estado={agentState} size={192} />
          {isRecording ? (
            <div className="sound-waves">
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
        </div>
      </div>

      {isRecording ? (
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
        {turn ? (
          <section className="surface-card p-4">
            {lastTranscript ? (
              <div className="mb-3 rounded-2xl bg-secondary px-4 py-3">
                <p className="text-sm font-bold text-muted-foreground">Nani entendió:</p>
                <p className="mt-0.5 text-base font-extrabold">“{lastTranscript}”</p>
              </div>
            ) : null}
            <p className="text-base leading-snug">{turn.message}</p>
            {turn.status === "confirmation_required" ? (
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm sm:text-base">
                <dt className="font-bold">Monto</dt>
                <dd className="text-right">
                  {turn.preview.amount} {turn.preview.token}
                </dd>
                <dt className="font-bold">Destino</dt>
                <dd className="truncate text-right" title={turn.preview.recipient}>
                  {turn.preview.recipient}
                </dd>
                <dt className="font-bold">Red</dt>
                <dd className="text-right">{turn.preview.network}</dd>
                <dt className="font-bold">Costo</dt>
                <dd className="text-right">{turn.preview.estimatedFee}</dd>
              </dl>
            ) : null}
          </section>
        ) : null}

        {turn?.status === "confirmation_required" ? (
          <div className="grid w-full grid-cols-1">
            <Button
              variant="outline"
              className="press min-h-12 whitespace-normal text-base font-extrabold"
              onClick={rejectProposal}
              disabled={isSessionActionPending || areSessionActionsLocked}
            >
              Cancelar
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
          placeholder={isConfirmationPending ? "Confirmar o cancelar" : "Escribime acá"}
          aria-label="Mensaje para el agente"
          disabled={controls.textDisabled}
          className="h-10 min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2 text-base shadow-none focus-visible:ring-0 md:text-base"
        />
        <Button
          type="submit"
          size="icon"
          className="press size-10 shrink-0 rounded-full"
          aria-label="Enviar mensaje"
          disabled={controls.textDisabled || !text.trim()}
        >
          <Send className="size-5" strokeWidth={2.4} />
        </Button>
      </form>
    </main>
  );
}
