export type AssistantAttemptSnapshot = {
  attemptId: string;
  conversationId: string;
  userId: string;
  status: AssistantNotificationStatus;
  amountLabel?: string;
  network?: string;
  transactionHash?: string;
  walletResult?: unknown;
};

export type AssistantNotificationStatus =
  | "submitted"
  | "uncertain"
  | "confirmed"
  | "reverted"
  | "receipt_invalid";

/**
 * Assistant attempt states that produce a feed notification, sourced from the
 * durable conversation_transfer_attempts record — never from in-process task
 * events and never from the separate wallet_operations pipeline.
 */
export const ASSISTANT_NOTIFICATION_STATES: readonly AssistantNotificationStatus[] =
  ["submitted", "uncertain", "confirmed", "reverted", "receipt_invalid"];

export function isNotificationworthyAssistantState(
  status: string,
): status is AssistantNotificationStatus {
  return (ASSISTANT_NOTIFICATION_STATES as readonly string[]).includes(status);
}

export type AssistantNotificationMapping = {
  status: AssistantNotificationStatus;
  title: string;
  explanation: string;
  resolved: boolean;
};

/**
 * Safe user-facing mapping for each assistant attempt state. `uncertain`
 * communicates that the outcome is unknown (dispatch may have succeeded) and
 * that no automatic retry is in progress; `not_dispatched` never reaches this
 * mapping because it returns the attempt to previewed and stays
 * conversation-only.
 */
export function assistantStateToNotification(
  status: AssistantNotificationStatus,
): AssistantNotificationMapping {
  // not_dispatched, previewed, broadcasting, cancelled are never
  // notification-worthy: fail closed instead of inventing a mapping.
  if (!(ASSISTANT_NOTIFICATION_STATES as readonly string[]).includes(status)) {
    throw new Error(
      `Assistant attempt status ${String(status)} is not notification-worthy.`,
    );
  }
  switch (status) {
    case "submitted":
      return {
        status,
        title: "Transfer sent",
        explanation:
          "Your transfer was sent and is being confirmed.",
        resolved: false,
      };
    case "uncertain":
      return {
        status,
        title: "Transfer with unknown result",
        explanation:
          "We could not confirm whether the transfer went through. The outcome is unknown; there is no automatic retry. Check your history or ask us.",
        resolved: false,
      };
    case "confirmed":
      return {
        status,
        title: "Transfer confirmed",
        explanation: "Your transfer was confirmed by the network.",
        resolved: true,
      };
    case "reverted":
      return {
        status,
        title: "Transfer reverted",
        explanation:
          "The transfer was reverted; the funds went back to your wallet.",
        resolved: true,
      };
    case "receipt_invalid":
      return {
        status,
        title: "Invalid receipt",
        explanation:
          "We could not validate the transfer receipt. Check your history before retrying.",
        resolved: true,
      };
  }
}

export type AssistantNotificationProjection = {
  status: AssistantNotificationStatus;
  resolved: boolean;
  amountLabel?: string;
  network?: string;
  transactionHash?: string;
};

export type BuiltAssistantNotification = {
  userId: string;
  category: "assistant_transfer";
  status: AssistantNotificationStatus;
  dedupeKey: string;
  title: string;
  explanation: string;
  resolved: boolean;
  projection: AssistantNotificationProjection;
};

/**
 * One deduped safe notification per attempt state: dedupe identity is
 * attempt ID + state; the projection carries only display-approved fields
 * (no raw wallet results, no receipt payloads, no authorization material).
 */
export function buildAssistantNotification(
  snapshot: AssistantAttemptSnapshot,
): BuiltAssistantNotification {
  if (!isNotificationworthyAssistantState(snapshot.status)) {
    throw new Error(
      `Assistant attempt status ${String(snapshot.status)} is not notification-worthy.`,
    );
  }
  const mapping = assistantStateToNotification(snapshot.status);
  return {
    userId: snapshot.userId,
    category: "assistant_transfer",
    status: mapping.status,
    dedupeKey: `assistant-transfer:${snapshot.attemptId}:${snapshot.status}`,
    title: mapping.title,
    explanation: mapping.explanation,
    resolved: mapping.resolved,
    projection: {
      status: mapping.status,
      resolved: mapping.resolved,
      amountLabel: snapshot.amountLabel,
      network: snapshot.network,
      transactionHash: snapshot.transactionHash,
    },
  };
}
