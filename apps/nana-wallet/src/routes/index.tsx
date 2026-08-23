import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgenteAvatar } from "@/components/agente/AgenteAvatar";
import { ConfirmarPlata } from "@/components/ConfirmarPlata";
import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import type { AgentTurn, AgentTurnInput, ConfirmableIntent } from "@/lib/api-types";

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

const agentStateLabels: Record<AgentTurn["agentState"], string> = {
  escuchando: "Estoy escuchando",
  pensando: "Estoy pensando",
  esperando_confirmacion: "Esperando que revises",
  listo: "Estoy listo para ayudarte",
  no_entendi: "No te entendí bien",
};

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  const [activeIntent, setActiveIntent] = useState<ConfirmableIntent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);

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

  const turnMutation = useMutation({
    mutationFn: api.agentTurn,
    onSuccess: (nextTurn) => {
      setSessionId(nextTurn.sessionId);
      setTurn(nextTurn);
      setActiveIntent(nextTurn.proposal);
      setMessage(null);
    },
    onError: (error) => {
      setMessage(getErrorMessage(error));
    },
  });

  function sendTurn(input: AgentTurnInput) {
    if (turnMutation.isPending) return;
    turnMutation.mutate({ sessionId, input });
  }

  function sendText() {
    const cleanText = text.trim();
    if (!cleanText) return;
    setText("");
    sendTurn({ kind: "text", text: cleanText });
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("Este teléfono no pudo abrir el micrófono. Podés escribirme abajo.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const supportsWebm = MediaRecorder.isTypeSupported("audio/webm");
      const recorder = new MediaRecorder(
        stream,
        supportsWebm ? { mimeType: "audio/webm" } : undefined,
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
        const mimeType = supportsWebm ? "audio/webm" : "audio/m4a";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);
        setIsPreparingAudio(true);
        void readBlobAsBase64(blob)
          .then((audioBase64) => {
            sendTurn({ kind: "audio", audioBase64, mimeType });
          })
          .catch(() => setMessage("No pude leer esa grabación. Probá de nuevo o escribime."))
          .finally(() => setIsPreparingAudio(false));
      };
      recorderRef.current = recorder;
      recorder.start();
      recordingTimeoutRef.current = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, MAX_RECORDING_MS);
      setIsRecording(true);
      setTurn(null);
      setActiveIntent(null);
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

  async function rejectProposal() {
    const turnId = turn?.turnId;
    setActiveIntent(null);
    setTurn(null);
    if (!turnId) return;
    try {
      await api.rejectAgentTurn(turnId);
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills });
  }

  function closeReceipt() {
    setActiveIntent(null);
    setTurn(null);
    refreshMoneyQueries();
  }

  /**
   * El usuario sale sin saber si la plata se movió. Cerramos igual que un recibo,
   * refrescando saldo y movimientos, para que lo primero que vea sea el estado real.
   */
  function closeAfterUnknownOutcome() {
    setActiveIntent(null);
    setTurn(null);
    setMessage("Fijate en tu saldo y en tus movimientos si la operación se hizo.");
    refreshMoneyQueries();
  }

  if (meQuery.isPending) return <RoutePending label="Estamos preparando al agente" />;
  if (meQuery.isError) {
    return <RouteError error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  const isAgentWorking = isPreparingAudio || turnMutation.isPending;
  const isAgentListening = isRecording || turn?.agentState === "escuchando";
  // Mientras graba, el avatar escucha aunque todavía no haya vuelto ningún turno.
  const agentState: AgentTurn["agentState"] = isAgentListening
    ? "escuchando"
    : isAgentWorking
      ? "pensando"
      : (turn?.agentState ?? "listo");
  const agentStatus = isRecording
    ? "Te estoy escuchando"
    : isAgentWorking
      ? "Estoy resolviéndolo"
      : turn
        ? agentStateLabels[turn.agentState]
        : "Tocá a Nani y hablale";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center px-6 pt-12 pb-40">
      <p className="mb-3 rounded-full bg-secondary px-4 py-2 text-sm font-extrabold tracking-[0.16em] text-primary">
        NANA WALLET
      </p>
      <h1 className="text-center text-3xl leading-tight font-extrabold">
        Hola, {meQuery.data.greetingName}
      </h1>
      <p className="mt-2 text-center text-lg text-muted-foreground">
        Pedime lo que necesites. Yo te ayudo.
      </p>

      <div className="relative mt-8 flex flex-col items-center">
        <button
          type="button"
          className={`agent-stage press relative flex h-64 w-64 items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-80 ${
            isAgentListening ? "listening" : ""
          }`}
          aria-label={isRecording ? "Terminar de hablar con Nana" : "Hablar con Nana"}
          aria-pressed={isRecording}
          onClick={handleMicrophone}
          disabled={isAgentWorking || Boolean(activeIntent)}
        >
          <AgenteAvatar estado={agentState} size={256} />
          {isAgentListening ? (
            <div className="sound-waves">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          ) : null}
        </button>

        <span className="mt-3 rounded-full bg-secondary px-5 py-3 text-base font-bold text-secondary-foreground">
          {agentStatus}
        </span>
      </div>

      {isRecording ? (
        <p
          className="mt-5 rounded-2xl bg-warning-surface text-warning-surface-foreground border border-border p-4 text-center text-lg font-bold"
          role="status"
        >
          Hablá con Nana y tocala cuando termines. Si no, se envía sola después de 20 segundos.
        </p>
      ) : null}

      <div className="mt-6 w-full space-y-4" aria-live="polite">
        {turn && !turn.proposal ? (
          <section className="surface-card p-5">
            {turn.transcript ? (
              <p className="mb-2 text-base font-bold text-muted-foreground">
                Entendí: “{turn.transcript}”
              </p>
            ) : null}
            <p className="text-lg leading-relaxed">{turn.say.text}</p>
          </section>
        ) : null}

        {turn?.suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            className="press min-h-14 w-full whitespace-normal text-lg font-bold"
            onClick={() => sendTurn({ kind: "text", text: suggestion })}
          >
            {suggestion}
          </Button>
        ))}

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
        className="surface-card mt-8 flex w-full items-center gap-2 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Escribime acá"
          aria-label="Mensaje para el agente"
          className="min-w-0 flex-1 rounded-xl bg-transparent px-2 py-3 text-lg focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={isRecording || isAgentWorking}
        />
        <Button
          type="submit"
          variant="ghost"
          className="press size-14 shrink-0 rounded-2xl text-primary"
          aria-label="Enviar mensaje"
          disabled={isRecording || isAgentWorking || !text.trim()}
        >
          <Send className="size-7" strokeWidth={2.4} />
        </Button>
      </form>

      {activeIntent ? (
        <ConfirmarPlata
          key={activeIntent.intentId}
          intent={activeIntent}
          onCancel={rejectProposal}
          onExpired={() => void rejectProposal()}
          onCloseReceipt={closeReceipt}
          onUnknownOutcome={closeAfterUnknownOutcome}
          transcript={turn?.transcript ?? null}
        />
      ) : null}
    </main>
  );
}
