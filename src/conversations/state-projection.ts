import type { ConversationSnapshot } from "./types.js";
import type { TransactionResult } from "../contracts/http.js";

export type ConversationActivity =
  "idle" | "working" | "awaiting_confirmation" | "verifying" | "uncertain" | "request_waiting";

export function conversationActivity(
  snapshot: Pick<
    ConversationSnapshot,
    "pendingTransfer" | "transferResolutionState" | "progress"
  > & { pendingInterpretation?: ConversationSnapshot["pendingInterpretation"] },
): ConversationActivity {
  if (snapshot.pendingInterpretation) return "request_waiting";
  if (snapshot.transferResolutionState === "uncertain") return "uncertain";
  if (snapshot.transferResolutionState === "broadcasting") return "verifying";
  if (snapshot.progress?.phase === "uncertain") return "uncertain";
  if (
    snapshot.progress?.phase === "working" ||
    snapshot.progress?.phase === "broadcasting"
  )
    return "working";
  if (snapshot.progress?.phase === "verifying") return "verifying";
  if (snapshot.pendingTransfer) return "awaiting_confirmation";
  return "idle";
}

export type ConversationStateProjection = {
  id: string;
  mode: ConversationSnapshot["mode"];
  revision: number;
  activity: ConversationActivity;
  progress?: ConversationSnapshot["progress"];
  pendingTransfer?: NonNullable<
    ConversationSnapshot["pendingTransfer"]
  >["preview"] & { previewId: string };
  transaction?: TransactionResult;
  error?: { code: string; message: string };
  lastTransactionHash?: string;
  createdAt: string;
};

/**
 * The room only invalidates this projection. It deliberately excludes model
 * messages and provider evidence so every client reads one canonical view.
 */
export function projectConversationState(
  snapshot: ConversationSnapshot,
): ConversationStateProjection {
  const pending = snapshot.pendingTransfer?.previewId
    ? {
        ...snapshot.pendingTransfer.preview,
        previewId: snapshot.pendingTransfer.previewId,
      }
    : undefined;
  const phase = snapshot.progress?.phase;
  const error =
    phase === "uncertain"
      ? {
          code: "broadcast_uncertain",
          message:
            "The broadcast result is uncertain. Check the wallet history before taking another action.",
        }
      : phase === "failed"
        ? {
            code: snapshot.progress?.label?.includes("reverted")
              ? "transfer_reverted"
              : "transaction_receipt_invalid",
            message:
              snapshot.progress?.label ?? "The transfer could not be verified.",
          }
        : undefined;
  const transaction = snapshot.lastTransactionHash
    ? {
        network: snapshot.pendingTransfer?.network ?? "sepolia",
        transactionHash: snapshot.lastTransactionHash,
        explorerUrl: `https://sepolia.etherscan.io/tx/${snapshot.lastTransactionHash}`,
      }
    : undefined;
  return {
    id: snapshot.id,
    mode: snapshot.mode,
    revision: snapshot.revision,
    activity: conversationActivity(snapshot),
    ...(snapshot.progress ? { progress: snapshot.progress } : {}),
    ...(pending ? { pendingTransfer: pending } : {}),
    ...(transaction ? { transaction } : {}),
    ...(error ? { error } : {}),
    ...(snapshot.lastTransactionHash
      ? { lastTransactionHash: snapshot.lastTransactionHash }
      : {}),
    createdAt: snapshot.createdAt,
  };
}
