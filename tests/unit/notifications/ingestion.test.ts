import { describe, expect, it, vi } from "vitest";

import {
  canonicalDedupeKey,
  ingestNotificationEvent,
  type NotificationEvent,
  type NotificationIngestionDependencies,
} from "../../../src/notifications/ingestion.js";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "assistant_transfer",
    userId: "0b7f8c1e-0000-4000-8000-000000000003",
    dedupeKey: "assistant-transfer:attempt-1:confirmed",
    category: "assistant_transfer",
    status: "confirmed",
    title: "Transfer confirmed",
    projection: { status: "confirmed", amountLabel: "10 USDT" },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<NotificationIngestionDependencies> = {},
): NotificationIngestionDependencies & {
  publishInvalidation: (event: NotificationEvent) => Promise<void>;
} {
  const insertNotification = vi.fn(async () => ({ inserted: true }));
  const publishInvalidation = vi.fn(async (_event: NotificationEvent) => {});
  return {
    insertNotification,
    publishInvalidation: publishInvalidation as (
      event: NotificationEvent,
    ) => Promise<void>,
    ...overrides,
  };
}

describe("canonical notification ingestion (dedupe, replay, projection)", () => {
  it("inserts a notification and publishes invalidation only after a winning insert", async () => {
    const deps = dependencies();
    const result = await ingestNotificationEvent(event(), deps);
    expect(result.outcome).toBe("inserted");
    expect(deps.insertNotification).toHaveBeenCalledTimes(1);
    expect(deps.publishInvalidation).toHaveBeenCalledTimes(1);
  });

  it("treats a duplicate (user_id, dedupe_key) replay as already canonical with no fan-out", async () => {
    const deps = dependencies({
      insertNotification: vi.fn(async () => ({ inserted: false })),
    });
    const result = await ingestNotificationEvent(event(), deps);
    expect(result.outcome).toBe("already_canonical");
    expect(deps.insertNotification).toHaveBeenCalledTimes(1);
    expect(deps.publishInvalidation).not.toHaveBeenCalled();
  });

  it("does not publish invalidation when the insert fails", async () => {
    const deps = dependencies({
      insertNotification: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    await expect(ingestNotificationEvent(event(), deps)).rejects.toThrow(
      "database unavailable",
    );
    expect(deps.publishInvalidation).not.toHaveBeenCalled();
  });

  it("builds the same canonical chain dedupe key from webhook and reconciliation observations", () => {
    const webhookObservation = {
      network: "solana-devnet",
      walletAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      signature: "5Rp8exampleSignatureValue0000000000000000000000000",
      eventClass: "confirmed_transfer",
    };
    const pollObservation = { ...webhookObservation };
    expect(canonicalDedupeKey(webhookObservation)).toBe(
      canonicalDedupeKey(pollObservation),
    );
    // Different wallet ownership or class must not collide.
    expect(
      canonicalDedupeKey({ ...webhookObservation, eventClass: "deposit" }),
    ).not.toBe(canonicalDedupeKey(webhookObservation));
  });
});
