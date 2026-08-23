export type SessionActionLock = { current: boolean };

export const UNKNOWN_SESSION_OUTCOME_MESSAGE =
  "No sabemos si la operación se hizo. Revisá tu saldo y tus movimientos antes de volver a intentar.";

/** Acquires the lock synchronously, before React has a chance to rerender. */
export function runExclusiveSessionAction<T>(
  lock: SessionActionLock,
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

export function shouldLockAfterSessionResolution(
  result: SessionMessageResponse | unknown,
  source: "response" | "thrown",
) {
  if (source === "thrown") return isAmbiguousError(result);
  const response = result as SessionMessageResponse;
  return response.status === "error" && response.code === "broadcast_uncertain";
}
import { isAmbiguousError } from "@/lib/api";
import type { SessionMessageResponse } from "@/lib/api-types";
