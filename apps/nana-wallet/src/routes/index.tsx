import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Calculator, Mic, Send, Volume2, VolumeX } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { RouteError, RoutePending } from "@/components/RouteStates";
import { Button } from "@/components/ui/button";
import { api, createSessionMessageSender, getErrorMessage, queryKeys } from "@/lib/api";
import type { SessionMessageResponse } from "@/lib/api-types";
import {
  runExclusiveSessionAction,
  shouldLockAfterSessionResolution,
  UNKNOWN_SESSION_OUTCOME_MESSAGE,
} from "@/lib/session-action-lock";
import { useVoicePlayback } from "@/lib/use-voice-playback";
import { useVoiceRecorder } from "@/lib/use-voice-recorder";

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

function AgentCharacter() {
  return (
    <div className="breathe relative h-64 w-60">
      <div className="agent-rubber absolute bottom-0 left-1/2 h-24 w-48 -translate-x-1/2 rounded-[4.5rem_4.5rem_2.5rem_2.5rem] bg-agent-dress" />
      <div className="absolute bottom-8 left-1/2 h-16 w-20 -translate-x-1/2 bg-card [clip-path:polygon(0_0,100%_0,50%_100%)]" />
      <div className="absolute bottom-5 left-1/2 h-14 w-5 -translate-x-1/2 bg-agent-glasses [clip-path:polygon(50%_0,100%_24%,72%_100%,28%_100%,0_24%)]" />
      <div className="agent-rubber absolute right-8 bottom-5 flex size-11 items-center justify-center rounded-xl bg-card text-primary">
        <Calculator className="size-6" strokeWidth={2.5} />
      </div>

      <div className="agent-rubber absolute top-24 left-7 h-12 w-8 rounded-full bg-agent-skin" />
      <div className="agent-rubber absolute top-24 right-7 h-12 w-8 rounded-full bg-agent-skin" />
      <div className="agent-rubber absolute top-7 left-8 h-20 w-12 -rotate-12 rounded-full bg-agent-hair-shadow" />
      <div className="agent-rubber absolute top-7 right-8 h-20 w-12 rotate-12 rounded-full bg-agent-hair-shadow" />
      <div className="absolute top-5 left-12 h-10 w-10 -rotate-12 rounded-full bg-agent-hair" />
      <div className="absolute top-5 right-12 h-10 w-10 rotate-12 rounded-full bg-agent-hair" />

      <div className="agent-rubber absolute top-8 left-1/2 h-40 w-40 -translate-x-1/2 rounded-[48%_48%_46%_46%] bg-agent-skin">
        <span className="absolute top-3 left-1/2 h-5 w-16 -translate-x-1/2 rounded-full bg-card/35 blur-[1px]" />
        <div className="absolute top-14 left-3 size-4 rounded-full bg-agent-blush/55" />
        <div className="absolute top-14 right-3 size-4 rounded-full bg-agent-blush/55" />

        <span className="absolute top-7 left-7 h-1.5 w-9 -rotate-6 rounded-full bg-agent-hair-shadow" />
        <span className="absolute top-7 right-7 h-1.5 w-9 rotate-6 rounded-full bg-agent-hair-shadow" />
        <div className="absolute top-9 left-6 flex size-11 items-center justify-center rounded-full border-[3px] border-agent-glasses bg-card/35">
          <span className="size-2.5 rounded-full bg-agent-glasses" />
        </div>
        <div className="absolute top-9 right-6 flex size-11 items-center justify-center rounded-full border-[3px] border-agent-glasses bg-card/35">
          <span className="size-2.5 rounded-full bg-agent-glasses" />
        </div>
        <span className="absolute top-[3.85rem] left-1/2 h-[3px] w-4 -translate-x-1/2 bg-agent-glasses" />
        <span className="absolute top-[4.15rem] left-1/2 h-5 w-3 -translate-x-1/2 rounded-full border-r-2 border-agent-skin-shadow/55" />

        <div className="absolute top-[5.65rem] left-1/2 h-5 w-10 -translate-x-1/2 rounded-b-full border-b-[3px] border-agent-mouth" />
        <span className="absolute top-[7.1rem] left-10 h-px w-5 rotate-6 bg-agent-skin-shadow/60" />
        <span className="absolute top-[7.1rem] right-10 h-px w-5 -rotate-6 bg-agent-skin-shadow/60" />
      </div>

      <div className="agent-rubber absolute top-[10.4rem] left-1/2 h-9 w-20 -translate-x-1/2 rounded-full bg-agent-skin" />
    </div>
  );
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
  const [isSessionActionPending, setIsSessionActionPending] = useState(false);
  const [isConfirmationPending, setIsConfirmationPending] = useState(false);
  const [areSessionActionsLocked, setAreSessionActionsLocked] = useState(false);
  const { isMuted, toggleMuted, speak: speakReply } = useVoicePlayback();
  const {
    isRecording,
    isTranscribing,
    toggle: toggleRecording,
  } = useVoiceRecorder(
    (transcribedText) => sendTurn(transcribedText),
    (voiceError) => setMessage(voiceError),
  );
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

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });

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

  function sendText() {
    const cleanText = text.trim();
    if (!cleanText) return;
    setText("");
    sendTurn(cleanText);
  }

  function rejectProposal() {
    sendTurn("cancel", "resolution");
  }

  function refreshMoneyQueries() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.wallet });
    void queryClient.invalidateQueries({ queryKey: queryKeys.movements });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bills });
  }

  if (meQuery.isPending) return <RoutePending label="Estamos preparando al agente" />;
  if (meQuery.isError) {
    return <RouteError error={meQuery.error} onRetry={() => void meQuery.refetch()} />;
  }

  const agentStatus = isRecording
    ? "Te estoy escuchando"
    : isTranscribing
      ? "Entendiendo lo que dijiste"
      : isSessionActionPending
        ? "Estoy pensando"
        : turn?.status === "confirmation_required"
          ? "Esperando que revises"
          : turn?.status === "error"
            ? "No te entendí bien"
            : turn
              ? "Estoy listo para ayudarte"
              : "Tu contador de confianza";

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
        <div
          className="agent-stage relative flex h-64 w-64 items-center justify-center"
          aria-hidden="true"
        >
          <AgentCharacter />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="rounded-full bg-secondary px-5 py-3 text-base font-bold text-secondary-foreground">
            {agentStatus}
          </span>
          <Button
            type="button"
            variant="ghost"
            className="press size-11 shrink-0 rounded-full text-muted-foreground"
            aria-label={isMuted ? "Activar la voz del agente" : "Silenciar la voz del agente"}
            aria-pressed={isMuted}
            onClick={toggleMuted}
          >
            {isMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </Button>
        </div>
      </div>

      <div className="mt-6 w-full space-y-4" aria-live="polite">
        {turn ? (
          <section className="surface-card p-5">
            <p className="text-lg leading-relaxed">{turn.message}</p>
            {turn.status === "confirmation_required" ? (
              <dl className="mt-4 space-y-2 text-base">
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Monto</dt>
                  <dd>
                    {turn.preview.amount} {turn.preview.token}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Destino</dt>
                  <dd className="break-all text-right">{turn.preview.recipient}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="font-bold">Red</dt>
                  <dd>{turn.preview.network}</dd>
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
            className="rounded-2xl bg-destructive/10 p-4 text-lg font-bold text-destructive"
            role="alert"
          >
            {message}
          </p>
        ) : null}
      </div>

      <form
        className="surface-card mt-8 flex w-full items-center gap-2 px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        <Button
          type="button"
          variant="ghost"
          className={`press size-14 shrink-0 rounded-2xl ${isRecording ? "animate-pulse bg-destructive/15 text-destructive" : "text-primary"}`}
          aria-label={
            isRecording ? "Tocá para enviar lo que dijiste" : "Tocá para hablarle al agente"
          }
          aria-pressed={isRecording}
          onClick={toggleRecording}
          disabled={
            isSessionActionPending ||
            isConfirmationPending ||
            areSessionActionsLocked ||
            isTranscribing
          }
        >
          <Mic className="size-7" strokeWidth={2.4} />
        </Button>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Escribime acá"
          aria-label="Mensaje para el agente"
          disabled={isSessionActionPending || isConfirmationPending || areSessionActionsLocked}
          className="min-w-0 flex-1 rounded-xl bg-transparent px-2 py-3 text-lg focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <Button
          type="submit"
          variant="ghost"
          className="press size-14 shrink-0 rounded-2xl text-primary"
          aria-label="Enviar mensaje"
          disabled={
            isSessionActionPending ||
            isConfirmationPending ||
            areSessionActionsLocked ||
            !text.trim()
          }
        >
          <Send className="size-7" strokeWidth={2.4} />
        </Button>
      </form>
    </main>
  );
}
