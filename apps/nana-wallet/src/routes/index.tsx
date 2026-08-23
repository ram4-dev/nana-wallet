import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Send } from "lucide-react";
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

  function sendText() {
    const cleanText = text.trim();
    if (!cleanText) return;
    setText("");
    setLastTranscript(null);
    sendTurn(cleanText);
  }

  async function startRecording() {
    if (
      isSessionActionPending ||
      isConfirmationPending ||
      areSessionActionsLocked ||
      sessionActionLockRef.current
    ) {
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
            sendTurn(cleanTranscript);
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
      setTurn(null);
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
    sendTurn("cancel", "resolution");
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
  const interactionDisabled =
    isAgentWorking || isConfirmationPending || areSessionActionsLocked || isRecording;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 pt-12 pb-40">
      <h1 className="text-center text-3xl leading-tight font-extrabold">
        <span className="block">Hola, soy Nani.</span>
        <span className="mt-2 block">Hablame.</span>
      </h1>

      <div className="relative mt-8 flex flex-col items-center">
        <button
          type="button"
          className={`agent-stage press relative flex h-64 w-64 items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-80 ${
            isRecording ? "listening" : ""
          }`}
          aria-label={isRecording ? "Terminar de hablar con Nani" : "Hablar con Nani"}
          aria-pressed={isRecording}
          onClick={handleMicrophone}
          disabled={
            !isRecording && (isAgentWorking || isConfirmationPending || areSessionActionsLocked)
          }
        >
          <AgenteAvatar estado={agentState} size={256} />
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

        {agentStatus ? (
          <span className="mt-3 rounded-full bg-secondary px-5 py-3 text-base font-bold text-secondary-foreground">
            {agentStatus}
          </span>
        ) : null}
      </div>

      {isRecording ? (
        <p
          className="mt-5 rounded-2xl bg-warning-surface text-warning-surface-foreground border border-border p-4 text-center text-lg font-bold"
          role="status"
        >
          Hablá con Nani y tocala cuando termines. Si no, se envía sola después de 20 segundos.
        </p>
      ) : null}

      <div className="mt-6 w-full space-y-4" aria-live="polite">
        {turn ? (
          <section className="surface-card p-5">
            {lastTranscript ? (
              <div className="mb-4 rounded-2xl bg-secondary p-4">
                <p className="text-base font-bold text-muted-foreground">Nani entendió:</p>
                <p className="mt-1 text-xl font-extrabold">“{lastTranscript}”</p>
              </div>
            ) : null}
            <p className="text-lg leading-relaxed">{turn.message}</p>
            {turn.status === "confirmation_required" ? (
              <dl className="mt-4 space-y-3 text-base">
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Monto</dt>
                  <dd>{turn.preview.amountFormatted}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Destino</dt>
                  <dd className="break-all text-right">{turn.preview.recipient}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Red</dt>
                  <dd>{turn.preview.network}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Costo estimado</dt>
                  <dd>{turn.preview.estimatedFeeFormatted}</dd>
                </div>
              </dl>
            ) : null}
            {turn.status === "sent" ? (
              <a
                className="mt-4 inline-block break-all font-bold text-primary underline"
                href={turn.transaction.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                Ver transacción {turn.transaction.transactionHash}
              </a>
            ) : null}
          </section>
        ) : null}

        {turn?.status === "confirmation_required" ? (
          <div className="grid grid-cols-2 gap-6">
            <Button
              variant="outline"
              className="press min-h-16 whitespace-normal text-lg font-extrabold"
              onClick={rejectProposal}
              disabled={isSessionActionPending || areSessionActionsLocked}
            >
              Cancelar
            </Button>
            <Button
              className="press min-h-16 whitespace-normal text-lg font-extrabold"
              onClick={() => sendTurn("confirm", "resolution")}
              disabled={isSessionActionPending || areSessionActionsLocked}
            >
              Confirmar
            </Button>
          </div>
        ) : null}

        {message ? (
          <p
            className="rounded-2xl bg-destructive-surface text-destructive-surface-foreground border border-border p-4 text-lg font-bold"
            role="alert"
          >
            {message}
          </p>
        ) : null}
      </div>

      <form
        className="mt-10 flex w-full items-center gap-1 rounded-full border border-input bg-card p-1 focus-within:ring-4 focus-within:ring-ring/20"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Escribime acá"
          aria-label="Mensaje para el agente"
          disabled={interactionDisabled}
          className="h-10 min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2 text-base shadow-none focus-visible:ring-0 md:text-base"
        />
        <Button
          type="submit"
          size="icon"
          className="press size-10 shrink-0 rounded-full"
          aria-label="Enviar mensaje"
          disabled={interactionDisabled || !text.trim()}
        >
          <Send className="size-5" strokeWidth={2.4} />
        </Button>
      </form>
    </main>
  );
}
