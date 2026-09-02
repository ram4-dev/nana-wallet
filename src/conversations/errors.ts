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

export function safeErrorMessage(code: ConversationErrorCode): string {
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
