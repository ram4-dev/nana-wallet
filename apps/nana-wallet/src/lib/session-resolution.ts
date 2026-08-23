export type SessionSubmission =
  | { kind: "new"; message: string }
  | {
      kind: "resolution";
      message: "confirmar la transferencia" | "cancelar la transferencia";
    }
  | { kind: "blocked" };

const CONFIRMATION_PHRASES = new Set([
  "confirm",
  "confirmar",
  "confirmar transferencia",
  "confirmar la transferencia",
]);

const CANCELLATION_PHRASES = new Set([
  "cancel",
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
    .normalize("NFC")
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
