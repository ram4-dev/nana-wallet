import type { NotDispatchedCause } from '../wallet/provider.js';

export type ConversationErrorCode =
  | 'conversation_not_found'
  | 'conversation_forbidden'
  | 'stale_revision'
  | 'pending_confirmation'
  | 'no_pending_preview'
  | 'stale_preview'
  | 'recipient_revalidation_required'
  | 'policy_rejected'
  | 'broadcast_in_progress'
  | 'broadcast_uncertain'
  | 'transaction_receipt_invalid'
  | 'transfer_reverted'
  | 'invalid_tool_result'
  | 'wallet_unavailable'
  | 'internal_error';

export type SafeMessageKey =
  | 'conversation.notFound'
  | 'conversation.stale'
  | 'transfer.pendingConfirmation'
  | 'transfer.noPendingPreview'
  | 'transfer.stalePreview'
  | 'transfer.recipientChanged'
  | 'transfer.policyRejected'
  | 'transfer.inProgress'
  | 'transfer.uncertain'
  | 'transfer.receiptInvalid'
  | 'transfer.reverted'
  | 'wallet.unavailable'
  | 'conversation.internal';

export class ConversationError extends Error {
  public constructor(
    public readonly code: ConversationErrorCode,
    public readonly safeMessageKey: SafeMessageKey,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConversationError';
  }
}

export function conversationError(
  code: ConversationErrorCode,
  safeMessageKey: SafeMessageKey,
  message: string,
  cause?: unknown,
): ConversationError {
  return new ConversationError(code, safeMessageKey, message, cause === undefined ? undefined : { cause });
}

/**
 * The Spanish copy of the same table. These lines are read by older,
 * Spanish-speaking users, usually about their money, so they are plain, short
 * and warm (Rioplatense, voseo) rather than clinical.
 *
 * `policy_rejected` and `wallet_unavailable` are deliberately different kinds
 * of message. A policy refusal is PERMANENT: the transfer did not happen and
 * repeating it changes nothing, so it must never say it is temporary. A wallet
 * outage IS temporary, so inviting a retry there is honest advice.
 */
const SAFE_MESSAGES_ES: Record<ConversationErrorCode, string> = {
  conversation_not_found: 'No encontré esta conversación. Empezá una nueva.',
  // No English case either: both languages mirror the generic internal copy.
  conversation_forbidden: 'No pude completar la conversación.',
  stale_revision: 'La conversación cambió. Actualizá y probá de nuevo.',
  pending_confirmation: 'Hay una transferencia esperando tu decisión. Confirmala o cancelala antes de enviar otra instrucción.',
  no_pending_preview: 'No hay ninguna transferencia esperando confirmación.',
  stale_preview: 'Esa transferencia ya no está vigente. Preparala de nuevo.',
  recipient_revalidation_required: 'El destinatario cambió o ya no es válido. Elegilo de nuevo.',
  policy_rejected: 'La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.',
  broadcast_in_progress: 'La transferencia ya se está enviando. Esperá a que termine.',
  broadcast_uncertain: 'No pude confirmar el resultado. Revisá el historial antes de intentar otra transferencia.',
  transaction_receipt_invalid: 'La transferencia fue enviada, pero no pude verificar el comprobante.',
  transfer_reverted: 'La transferencia fue revertida en la red.',
  invalid_tool_result: 'No pude entender la respuesta de la billetera. Probá de nuevo.',
  wallet_unavailable: 'La billetera no está disponible en este momento. Probá de nuevo en un rato.',
  internal_error: 'No pude completar la conversación.',
};

/**
 * The user-facing copy for a conversation error code.
 *
 * `language` defaults to `"en"` so callers that have no session language keep
 * today's behaviour. A caller that DOES know the session language must pass it:
 * the frontend renders this string verbatim, so defaulting here is the
 * difference between "Transfer confirmed." and "La transferencia quedó
 * confirmada." for a Spanish-speaking user.
 */
export function safeErrorMessage(
  code: ConversationErrorCode,
  language: "es" | "en" = "en",
): string {
  if (language === "es") {
    // The record is complete for every code; the fallback mirrors the generic
    // default of the English switch for a code that arrived untyped.
    return SAFE_MESSAGES_ES[code] ?? SAFE_MESSAGES_ES.internal_error;
  }
  switch (code) {
    case 'conversation_not_found': return 'Conversation not found.';
    case 'stale_revision': return 'Conversation state changed. Refresh and try again.';
    case 'pending_confirmation': return 'A transfer is waiting for your decision. Confirm or cancel it before sending another instruction.';
    case 'no_pending_preview': return 'There is no pending transfer to confirm.';
    case 'stale_preview': return 'This transfer preview is no longer current.';
    case 'recipient_revalidation_required': return 'Recipient changed or is no longer valid; resolve the recipient again.';
    case 'policy_rejected': return 'This transfer does not meet the wallet safety policy.';
    case 'broadcast_in_progress': return 'The confirmed transfer is already being broadcast.';
    case 'broadcast_uncertain': return 'The broadcast result is uncertain. Check the wallet history before taking another action.';
    case 'transaction_receipt_invalid': return 'The transaction was sent, but its receipt could not be verified.';
    case 'transfer_reverted': return 'The transfer reverted on the network.';
    case 'wallet_unavailable': return 'The wallet is temporarily unavailable.';
    case 'invalid_tool_result': return 'The wallet returned an invalid transfer result.';
    default: return 'The conversation could not be completed.';
  }
}

export function errorFromCode(code: ConversationErrorCode, cause?: unknown): ConversationError {
  const key: SafeMessageKey = code === 'conversation_not_found' ? 'conversation.notFound'
    : code === 'stale_revision' ? 'conversation.stale'
      : code === 'pending_confirmation' ? 'transfer.pendingConfirmation'
        : code === 'no_pending_preview' ? 'transfer.noPendingPreview'
          : code === 'stale_preview' ? 'transfer.stalePreview'
            : code === 'recipient_revalidation_required' ? 'transfer.recipientChanged'
              : code === 'policy_rejected' ? 'transfer.policyRejected'
                : code === 'broadcast_in_progress' ? 'transfer.inProgress'
                  : code === 'broadcast_uncertain' ? 'transfer.uncertain'
                    : code === 'transaction_receipt_invalid' ? 'transfer.receiptInvalid'
                      : code === 'transfer_reverted' ? 'transfer.reverted'
                        : code === 'wallet_unavailable' ? 'wallet.unavailable'
                          : 'conversation.internal';
  return conversationError(code, key, safeErrorMessage(code), cause);
}

/**
 * The ONE cause→code mapper for a provider-declared non-dispatch.
 *
 * It lives here with the error vocabulary rather than with the conversation
 * service so the agent definition can reach it without importing the service.
 * `invalid_request` is OUR malformed request, so it reports `internal_error`
 * rather than the wallet-facing `invalid_tool_result`: blaming the wallet for a
 * request we built would be a second inaccurate message about someone's money.
 */
export function notDispatchedErrorCode(
  cause: NotDispatchedCause,
): ConversationErrorCode {
  switch (cause) {
    case 'policy_rejected':
      return 'policy_rejected';
    case 'invalid_request':
      return 'internal_error';
    case 'provider_unavailable':
      return 'wallet_unavailable';
  }
}
