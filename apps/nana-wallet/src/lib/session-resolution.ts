export type SessionSubmission =
  | { kind: "new"; message: string }
  | {
      kind: "resolution";
      message: "confirmar la transferencia" | "cancelar la transferencia";
    }
  | { kind: "blocked" };

const CONFIRMATION_PHRASES = new Set([
  "confirm",
  "i confirm",
  "yes confirm",
  "yes, confirm",
  "yes i confirm",
  "yes, i confirm",
  "confirm transfer",
  "confirm the transfer",
  "confirmar",
  "confirmo",
  "sí confirmo",
  "sí, confirmo",
  "si confirmo",
  "si, confirmo",
  "confirmar transferencia",
  "confirmar la transferencia",
  "confirmo la transferencia",
]);

export function getSessionControlState(input: {
  isAgentWorking: boolean;
  isConfirmationPending: boolean;
  areSessionActionsLocked: boolean;
  isRecording: boolean;
}) {
  return {
    microphoneDisabled: input.isAgentWorking || input.areSessionActionsLocked,
    textDisabled: input.isAgentWorking || input.areSessionActionsLocked || input.isRecording,
  };
}

const CANCELLATION_PHRASES = new Set([
  "cancel",
  "cancel transfer",
  "cancel the transfer",
  "cancel it",
  "no, cancel",
  "cancelar",
  "cancelo",
  "cancelar transferencia",
  "cancelar la transferencia",
  "cancelo la transferencia",
]);

function normalizeResolutionText(text: string) {
  return text
    .trim()
    .toLocaleLowerCase("es-AR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[.!]+$/u, "")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * While money is awaiting confirmation, only a bounded, explicit resolution
 * may leave the browser. New or ambiguous instructions remain local.
 */
export function classifySessionSubmission(
  text: string,
  confirmationPending: boolean,
): SessionSubmission {
  const cleanText = text.trim();
  if (!confirmationPending) return { kind: "new", message: cleanText };

  const normalized = normalizeResolutionText(cleanText);
  if (CONFIRMATION_PHRASES.has(normalized)) {
    return { kind: "resolution", message: "confirmar la transferencia" };
  }
  if (CANCELLATION_PHRASES.has(normalized)) {
    return { kind: "resolution", message: "cancelar la transferencia" };
  }
  return { kind: "blocked" };
}
