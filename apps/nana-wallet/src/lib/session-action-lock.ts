export type ConversationActionLock = { current: boolean };

export const UNKNOWN_CONVERSATION_OUTCOME_MESSAGE =
  "We do not know whether the operation went through. Check your balance and your movements before trying again.";

/** Acquires the lock synchronously, before React has a chance to rerender. */
export function runExclusiveConversationAction<T>(
  lock: ConversationActionLock,
  action: () => Promise<T>,
): Promise<T> | null {
  if (lock.current) return null;
  lock.current = true;

  return Promise.resolve()
    .then(action)
    .finally(() => {
      lock.current = false;
    });
}

export function shouldLockAfterConversationResolution(
  result: ConversationTurnResult | unknown,
  source: "response" | "thrown",
) {
  if (source === "thrown") return isAmbiguousError(result);
  const response = result as ConversationTurnResult;
  return response.status === "error" && response.code === "broadcast_uncertain";
}
import { isAmbiguousError } from "@/lib/api";
import type { ConversationTurnResult } from "@/lib/api-types";
