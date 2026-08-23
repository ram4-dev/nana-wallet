import { CheckCircle2, Clock3, HelpCircle, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  confirmMoneyIntent,
  createIdempotencyKey,
  getErrorMessage,
  isAmbiguousError,
} from "@/lib/api";
import type { ConfirmableIntent, PaymentResult } from "@/lib/api-types";

type ConfirmarPlataProps = {
  intent: ConfirmableIntent;
  onCancel: () => void | Promise<void>;
  onCloseReceipt: (result: PaymentResult) => void;
  onExpired: () => void;
  /** Se llama cuando el usuario sale sin saber si la plata se movió. Debe refrescar saldo y movimientos. */
  onUnknownOutcome: () => void;
};

function secondsUntil(expiresAt: string) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function ConfirmarPlata({
  intent,
  onCancel,
  onCloseReceipt,
  onExpired,
  onUnknownOutcome,
}: ConfirmarPlataProps) {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(intent.expiresAt));
  const [idempotencyKey] = useState(createIdempotencyKey);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [unknownMessage, setUnknownMessage] = useState<string | null>(null);
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  useEffect(() => {
    // Mientras hay una confirmación viajando, el reloj del cliente NO puede vencer la operación.
    // Si lo hiciera, la pantalla saltaría a "empezá de nuevo" con la plata ya moviéndose,
    // y el abuelo terminaría pidiendo la misma transferencia dos veces.
    // La única fuente de verdad de que venció es el backend, con CONFIRMACION_VENCIDA.
    if (result || expiredMessage || unknownMessage || isConfirming || secondsLeft <= 0) return;
    const timer = window.setTimeout(() => {
      const next = secondsUntil(intent.expiresAt);
      setSecondsLeft(next);
      if (next === 0) {
        setExpiredMessage("Se terminó el tiempo para confirmar. Volvé a preparar la operación.");
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [expiredMessage, intent.expiresAt, isConfirming, result, secondsLeft, unknownMessage]);

  async function handleConfirm() {
    if (isConfirming) return;
    setIsConfirming(true);
    setErrorMessage(null);
    try {
      const confirmed = await confirmMoneyIntent(intent, idempotencyKey);
      setResult(confirmed);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFIRMACION_VENCIDA") {
        setExpiredMessage(error.message);
      } else if (isAmbiguousError(error)) {
        // No sabemos si la plata se movió. No podemos ofrecer "cancelar" como si no hubiera pasado nada.
        setUnknownMessage(getErrorMessage(error));
      } else {
        setErrorMessage(getErrorMessage(error));
      }
    } finally {
      setIsConfirming(false);
    }
  }

  function handleReturnAfterExpiry() {
    if (isConfirming) return;
    onExpired();
  }

  function handleCancel() {
    if (isConfirming) return;
    void onCancel();
  }

  return (
    <AlertDialog open>
      <AlertDialogContent className="inset-0 top-0 left-0 z-[100] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none border-0 bg-secondary p-0 sm:rounded-none">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-6 py-8">
          {result ? (
            <div className="flex flex-1 flex-col justify-center" role="status">
              <CheckCircle2 className="mx-auto size-20 text-success" aria-hidden="true" />
              <AlertDialogTitle className="mt-6 text-center text-3xl font-extrabold">
                {result.receipt.headline}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="surface-card mt-8 space-y-5 p-6 text-foreground">
                  <p className="text-center text-4xl font-extrabold">
                    {result.receipt.amountDisplay}
                  </p>
                  <p className="text-xl font-bold">{result.receipt.atHuman}</p>
                  <p className="text-lg">Comprobante: {result.receipt.reference}</p>
                  <p className="text-xl font-extrabold">{result.receipt.newBalanceDisplay}</p>
                </div>
              </AlertDialogDescription>
              <Button
                className="press mt-8 min-h-16 w-full text-lg font-extrabold"
                onClick={() => onCloseReceipt(result)}
              >
                Cerrar comprobante
              </Button>
            </div>
          ) : unknownMessage ? (
            <div
              className="flex flex-1 flex-col items-center justify-center text-center"
              role="alert"
            >
              <HelpCircle className="size-20 text-warning" aria-hidden="true" />
              <AlertDialogTitle className="mt-6 text-3xl font-extrabold">
                No sabemos si se hizo
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="mt-4 space-y-4 text-lg leading-relaxed text-foreground">
                  <p>{unknownMessage}</p>
                  <p className="font-bold">
                    Se cortó la comunicación justo cuando mandábamos la orden. Puede que se haya
                    hecho y puede que no.
                  </p>
                  <p className="rounded-2xl bg-warning-surface text-warning-surface-foreground border border-border p-4 font-bold">
                    Si tocás "Reintentar operación" no se va a duplicar. Es la misma operación, no
                    una nueva.
                  </p>
                </div>
              </AlertDialogDescription>
              <div className="mt-8 flex w-full flex-col gap-6">
                <Button
                  className="press min-h-16 w-full text-lg font-extrabold"
                  onClick={() => void handleConfirm()}
                  disabled={isConfirming}
                >
                  Reintentar operación
                </Button>
                <Button
                  variant="outline"
                  className="press min-h-16 w-full text-lg font-extrabold"
                  onClick={onUnknownOutcome}
                  disabled={isConfirming}
                >
                  Ver mi plata
                </Button>
              </div>
            </div>
          ) : isConfirming ? (
            <div
              className="flex flex-1 flex-col items-center justify-center text-center"
              role="status"
            >
              <Loader2 className="size-20 animate-spin text-primary" aria-hidden="true" />
              <AlertDialogTitle className="mt-6 text-3xl font-extrabold">
                Nana está haciendo la operación
              </AlertDialogTitle>
              <AlertDialogDescription className="mt-4 text-lg leading-relaxed text-foreground">
                Esperá un momento. Te mostramos el comprobante apenas termine.
              </AlertDialogDescription>
            </div>
          ) : expiredMessage || secondsLeft <= 0 ? (
            <div
              className="flex flex-1 flex-col items-center justify-center text-center"
              role="alert"
            >
              <Clock3 className="size-20 text-warning" aria-hidden="true" />
              <AlertDialogTitle className="mt-6 text-3xl font-extrabold">
                Hay que empezar de nuevo
              </AlertDialogTitle>
              <AlertDialogDescription className="mt-4 text-lg leading-relaxed text-foreground">
                {expiredMessage ??
                  "Se terminó el tiempo para confirmar. Volvé a preparar la operación."}
              </AlertDialogDescription>
              <Button
                className="press mt-8 min-h-16 w-full text-lg font-extrabold"
                onClick={handleReturnAfterExpiry}
              >
                Volver al comienzo
              </Button>
            </div>
          ) : (
            <>
              <header className="text-center">
                <ShieldCheck className="mx-auto size-14 text-primary" aria-hidden="true" />
                <p className="mt-3 text-lg font-bold text-primary">Revisá antes de confirmar</p>
                <AlertDialogTitle className="mt-2 text-3xl leading-tight font-extrabold">
                  {intent.confirmation.headline}
                </AlertDialogTitle>
              </header>

              <AlertDialogDescription asChild>
                <div className="surface-card mt-7 space-y-6 p-6 text-foreground">
                  <div>
                    <p className="text-lg font-bold text-muted-foreground">A quién</p>
                    <p className="mt-1 text-2xl font-extrabold">
                      {intent.confirmation.detailLines[0] ?? intent.confirmation.headline}
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-muted-foreground">Cuánto</p>
                    <p className="mt-1 text-4xl font-extrabold tracking-tight">
                      {intent.confirmation.amountDisplay}
                    </p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-muted-foreground">De qué cuenta</p>
                    <p className="mt-1 text-2xl font-extrabold">
                      {intent.confirmation.fromAccountDisplay}
                    </p>
                  </div>
                  {intent.confirmation.detailLines.slice(1).map((line) => (
                    <p key={line} className="text-lg">
                      {line}
                    </p>
                  ))}
                  {intent.confirmation.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="rounded-2xl bg-warning-surface text-warning-surface-foreground border border-border p-4 text-lg font-bold"
                    >
                      {warning}
                    </p>
                  ))}
                </div>
              </AlertDialogDescription>

              <p
                className="mt-5 flex items-center justify-center gap-2 text-lg font-bold"
                aria-live="polite"
              >
                <Clock3 className="size-6" aria-hidden="true" />
                Tenés {formatCountdown(secondsLeft)} para decidir
              </p>

              {errorMessage ? (
                <p
                  className="mt-5 rounded-2xl bg-destructive-surface text-destructive-surface-foreground border border-border p-4 text-lg font-bold"
                  role="alert"
                >
                  {errorMessage}
                </p>
              ) : null}

              <div className="mt-6 grid grid-cols-2 gap-6">
                <Button
                  variant="outline"
                  className="press min-h-16 whitespace-normal px-4 text-lg font-extrabold"
                  onClick={handleCancel}
                  disabled={isConfirming}
                >
                  {intent.confirmation.cancelLabel}
                </Button>
                <Button
                  className="press min-h-16 whitespace-normal px-4 text-lg font-extrabold"
                  onClick={() => void handleConfirm()}
                  disabled={isConfirming}
                >
                  {intent.confirmation.confirmLabel}
                </Button>
              </div>
            </>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
