import { Send, Volume2, VolumeX } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

import { AgenteAvatar } from "@/components/agente/AgenteAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConversationState, ConversationTurnResult } from "@/lib/api-types";
import type { LiveVoiceState } from "./voice/live-voice-reducer";

export type AgentScreenProps = {
  voiceState: LiveVoiceState;
  conversationState: ConversationState | null;
  liveMode: boolean;
  turn?: ConversationTurnResult | null;
  message?: string | null;
  text: string;
  isActionPending?: boolean;
  onTextChange: (text: string) => void;
  onTypedSubmit: () => void;
  onAvatarPress: () => void;
  onEndConversation?: (acknowledgeUnresolvedFinancialWork?: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isNative?: boolean;
  isRecording?: boolean;
  isMuted?: boolean;
  onToggleOutputMute?: () => void;
  recordingHint?: string | null;
  lastTranscript?: string | null;
  isEnding?: boolean;
};

function voiceLabel(state: LiveVoiceState): string {
  switch (state.phase) {
    case "listening":
      return "Te estoy escuchando";
    case "muted":
      return "Micrófono pausado";
    case "speaking":
      return "Nani está hablando";
    case "thinking":
      return "Estoy resolviéndolo";
    case "reconnecting":
      return "Reconectando";
    case "paused":
      return "Sesión pausada. Tocá para continuar";
    case "connecting":
      return "Conectando con Nani";
    case "binding":
      return "Preparando la conversación";
    case "failed":
      return state.reason.message;
    case "request_waiting":
      return "Tu solicitud está esperando";
    default:
      return "Nani está lista";
  }
}

function avatarState(
  state: LiveVoiceState,
): "listo" | "escuchando" | "pensando" | "esperando_confirmacion" | "no_entendi" {
  if (state.phase === "listening") return "escuchando";
  if (["thinking", "connecting", "binding", "reconnecting"].includes(state.phase))
    return "pensando";
  if (state.phase === "failed") return "no_entendi";
  return "listo";
}

export function AgentScreen(props: AgentScreenProps) {
  const [acknowledgingEnd, setAcknowledgingEnd] = useState(false);
  const pending = props.conversationState?.pendingTransfer;
  const transaction = props.conversationState?.transaction;
  const progress = props.conversationState?.progress;
  const unresolvedFinancialWork = Boolean(
    pending ||
    ["working", "verifying", "uncertain"].includes(props.conversationState?.activity ?? ""),
  );
  const textDisabled = props.liveMode;
  const avatarIsPressed = props.isNative
    ? Boolean(props.isRecording)
    : props.voiceState.phase === "listening";
  const avatarDisabled = props.isNative
    ? !props.isRecording && Boolean(props.isActionPending)
    : ["connecting", "binding", "reconnecting", "thinking", "request_waiting"].includes(
        props.voiceState.phase,
      );
  const buttonLabel = props.isNative
    ? props.isRecording
      ? "Terminar de hablar con Nani"
      : "Hablar con Nani"
    : props.voiceState.phase === "speaking"
      ? "Interrumpir a Nani"
      : voiceLabel(props.voiceState);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onTypedSubmit();
  };

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col items-center overflow-hidden px-4 !pt-[max(0.75rem,env(safe-area-inset-top))] !pb-[calc(7.25rem+env(safe-area-inset-bottom))] sm:px-6">
      <h1 className="shrink-0 text-center text-2xl leading-tight font-extrabold sm:text-3xl">
        <span className="block">Hola, soy Nani.</span>
        <span className="mt-1 block">Hablame.</span>
      </h1>
      <div className="relative mt-3 flex shrink-0 flex-col items-center">
        <button
          type="button"
          className={`agent-stage press agent-stage--${props.voiceState.phase} relative flex size-[clamp(7.5rem,25dvh,12rem)] items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-ring focus-visible:ring-offset-4 disabled:cursor-wait disabled:opacity-80`}
          data-live-phase={props.voiceState.phase}
          aria-label={buttonLabel}
          aria-pressed={avatarIsPressed}
          aria-busy={["connecting", "binding", "thinking", "reconnecting"].includes(
            props.voiceState.phase,
          )}
          onClick={props.onAvatarPress}
          disabled={avatarDisabled}
        >
          <AgenteAvatar
            estado={avatarState(props.voiceState)}
            livePhase={props.voiceState.phase}
            size={192}
          />
          {props.isNative && props.isRecording ? (
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
          <span
            className="rounded-full bg-secondary px-4 py-2 text-sm font-bold text-secondary-foreground"
            role="status"
            aria-live="polite"
          >
            {props.isNative && props.isRecording
              ? "Te estoy escuchando"
              : voiceLabel(props.voiceState)}
          </span>
          {props.isNative && props.onToggleOutputMute ? (
            <Button
              type="button"
              variant="ghost"
              className="press size-11 shrink-0 rounded-full text-muted-foreground"
              aria-label={props.isMuted ? "Activar la voz de Nani" : "Silenciar la voz de Nani"}
              aria-pressed={props.isMuted}
              onClick={props.onToggleOutputMute}
            >
              {props.isMuted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </Button>
          ) : null}
        </div>
        {props.onEndConversation && props.liveMode && !acknowledgingEnd ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-1 min-h-10 text-sm"
            onClick={() => {
              if (unresolvedFinancialWork) setAcknowledgingEnd(true);
              else props.onEndConversation?.(false);
            }}
            disabled={props.isEnding}
          >
            Terminar conversación
          </Button>
        ) : null}
      </div>

      {acknowledgingEnd ? (
        <section
          className="mt-3 w-full rounded-2xl border border-warning bg-warning-surface p-4 text-warning-surface-foreground"
          role="alertdialog"
          aria-labelledby="end-live-title"
          aria-describedby="end-live-description"
        >
          <h2 id="end-live-title" className="font-extrabold">
            Hay una acción financiera pendiente
          </h2>
          <p id="end-live-description" className="mt-1 text-sm font-bold">
            Terminar la voz no cancela la transferencia ni su verificación. Podés seguirla desde la
            conversación escrita.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12 font-extrabold"
              onClick={() => setAcknowledgingEnd(false)}
              autoFocus
            >
              Seguir hablando
            </Button>
            <Button
              type="button"
              className="min-h-12 whitespace-normal font-extrabold"
              onClick={() => props.onEndConversation?.(true)}
              disabled={props.isEnding}
            >
              Terminar voz
            </Button>
          </div>
        </section>
      ) : null}

      {props.recordingHint ? (
        <p
          className="mt-3 shrink-0 rounded-2xl border border-border bg-warning-surface px-4 py-3 text-center text-base font-bold text-warning-surface-foreground"
          role="status"
        >
          {props.recordingHint}
        </p>
      ) : null}

      <div
        className="mt-3 min-h-0 w-full flex-1 space-y-3 overflow-y-auto overscroll-contain pb-2 [scrollbar-gutter:stable]"
        aria-live="polite"
      >
        {progress ? (
          <section className="surface-card p-4" role="status">
            <p className="text-base font-extrabold">
              {progress.label ?? "Estoy trabajando en tu solicitud."}
            </p>
          </section>
        ) : null}
        {props.lastTranscript &&
        !props.liveMode &&
        props.turn?.status === "confirmation_required" ? (
          <div className="rounded-2xl bg-secondary px-4 py-3">
            <p className="text-sm font-bold text-muted-foreground">Nani entendió:</p>
            <p className="mt-0.5 text-base font-extrabold">“{props.lastTranscript}”</p>
          </div>
        ) : null}
        {props.turn && !props.liveMode ? (
          <section className="surface-card p-4">
            <p>{props.turn.message}</p>
            {props.turn.status === "confirmation_required" ? (
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="font-bold">Monto</dt>
                <dd className="text-right">
                  {props.turn.preview.amount} {props.turn.preview.token}
                </dd>
                <dt className="font-bold">Destino</dt>
                <dd className="truncate text-right">{props.turn.preview.recipient}</dd>
                <dt className="font-bold">Red</dt>
                <dd className="text-right">{props.turn.preview.network}</dd>
                <dt className="font-bold">Costo</dt>
                <dd className="text-right">{props.turn.preview.estimatedFee}</dd>
              </dl>
            ) : null}
          </section>
        ) : null}
        {pending ? (
          <section className="surface-card p-4" aria-label="Vista previa de transferencia">
            <p className="text-base font-extrabold">Revisá esta transferencia</p>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="font-bold">Monto</dt>
              <dd className="text-right">
                {pending.amount} {pending.token}
              </dd>
              <dt className="font-bold">Destino</dt>
              <dd className="truncate text-right" title={pending.recipient}>
                {pending.recipient}
              </dd>
              <dt className="font-bold">Red</dt>
              <dd className="text-right">{pending.network}</dd>
              <dt className="font-bold">Costo</dt>
              <dd className="text-right">{pending.estimatedFee}</dd>
            </dl>
          </section>
        ) : null}
        {pending ? (
          <div className="grid w-full grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="press min-h-12 whitespace-normal text-base font-extrabold"
              onClick={props.onCancel}
              disabled={props.isActionPending}
            >
              Cancelar
            </Button>
            <Button
              className="press min-h-12 whitespace-normal text-base font-extrabold"
              onClick={props.onConfirm}
              disabled={props.isActionPending}
            >
              Confirmar
            </Button>
          </div>
        ) : null}
        {transaction ? (
          <section className="surface-card p-4" aria-label="Transferencia verificada" role="status">
            <p className="text-base font-extrabold">Transferencia confirmada</p>
            <a
              className="mt-2 block truncate text-sm font-bold text-primary underline"
              href={transaction.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {transaction.transactionHash}
            </a>
          </section>
        ) : null}
        {props.message ? (
          <p
            className="rounded-2xl border border-border bg-destructive-surface px-4 py-3 text-base font-bold text-destructive-surface-foreground"
            role="alert"
          >
            {props.message}
          </p>
        ) : null}
        {props.conversationState?.error ? (
          <p
            className="rounded-2xl border border-border bg-destructive-surface px-4 py-3 text-base font-bold text-destructive-surface-foreground"
            role="alert"
          >
            {props.conversationState.error.message}
          </p>
        ) : null}
      </div>

      <form
        className="mt-2 flex w-full shrink-0 items-center gap-1 rounded-full border border-input bg-card p-1 focus-within:ring-4 focus-within:ring-ring/20"
        onSubmit={onSubmit}
      >
        <Input
          value={props.text}
          onChange={(event) => props.onTextChange(event.target.value)}
          placeholder={textDisabled ? "La voz está activa" : "Escribime acá"}
          aria-label="Mensaje para el agente"
          aria-disabled={textDisabled}
          disabled={textDisabled}
          className="h-10 min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2 text-base shadow-none focus-visible:ring-0 md:text-base"
        />
        <Button
          type="submit"
          size="icon"
          className="press size-10 shrink-0 rounded-full"
          aria-label="Enviar mensaje"
          disabled={textDisabled || !props.text.trim()}
        >
          <Send className="size-5" strokeWidth={2.4} />
        </Button>
      </form>
    </main>
  );
}
