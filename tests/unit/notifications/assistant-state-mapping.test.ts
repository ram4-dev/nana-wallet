import { describe, expect, it } from "vitest";

import {
  ASSISTANT_NOTIFICATION_STATES,
  assistantStateToNotification,
  buildAssistantNotification,
  isNotificationworthyAssistantState,
} from "../../../src/notifications/assistant-state-mapping.js";
import type { AssistantAttemptSnapshot } from "../../../src/notifications/assistant-state-mapping.js";

function attemptSnapshot(
  overrides: Partial<AssistantAttemptSnapshot> = {},
): AssistantAttemptSnapshot {
  return {
    attemptId: "0b7f8c1e-0000-4000-8000-000000000001",
    conversationId: "0b7f8c1e-0000-4000-8000-000000000002",
    userId: "0b7f8c1e-0000-4000-8000-000000000003",
    status: "confirmed",
    amountLabel: "10 USDT",
    network: "solana-devnet",
    transactionHash: "5Rp8exampleSignatureValue0000000000000000000000000",
    ...overrides,
  };
}

describe("assistant attempt state to notification mapping", () => {
  it("maps every notification-worthy state including uncertain", () => {
    expect(ASSISTANT_NOTIFICATION_STATES).toEqual([
      "submitted",
      "uncertain",
      "confirmed",
      "reverted",
      "receipt_invalid",
    ]);
    for (const status of ASSISTANT_NOTIFICATION_STATES) {
      const notification = assistantStateToNotification(status);
      expect(notification.status).toBe(status);
      expect(typeof notification.title).toBe("string");
      expect(notification.title.length).toBeGreaterThan(0);
    }
  });

  it("maps uncertain to an unresolved status that says the outcome is unknown", () => {
    const notification = assistantStateToNotification("uncertain");
    expect(notification.resolved).toBe(false);
    expect(notification.status).toBe("uncertain");
    // The user must understand the outcome may still have succeeded.
    expect(notification.explanation).toMatch(/unknown/i);
  });

  it("excludes not_dispatched from notification-worthy states", () => {
    expect(isNotificationworthyAssistantState("not_dispatched")).toBe(false);
    expect(isNotificationworthyAssistantState("previewed")).toBe(false);
    expect(isNotificationworthyAssistantState("broadcasting")).toBe(false);
    expect(isNotificationworthyAssistantState("cancelled")).toBe(false);
    expect(() =>
      assistantStateToNotification("not_dispatched" as never),
    ).toThrow();
  });

  it("builds one deduped safe notification per attempt state", () => {
    const notification = buildAssistantNotification(attemptSnapshot());
    expect(notification.dedupeKey).toBe(
      `assistant-transfer:${attemptSnapshot().attemptId}:confirmed`,
    );
    expect(notification.userId).toBe(attemptSnapshot().userId);
    expect(notification.category).toBe("assistant_transfer");
    // Safe projection: no raw wallet result, no authorization material.
    expect(notification.projection).toMatchObject({
      status: "confirmed",
      amountLabel: "10 USDT",
      network: "solana-devnet",
    });
    expect(JSON.stringify(notification.projection)).not.toContain(
      "wallet_result",
    );
    expect(JSON.stringify(notification.projection)).not.toContain(
      "receipt_result",
    );
    expect(JSON.stringify(notification.projection)).not.toContain("failure");
  });

  it("omits counterparty and signing details from the safe projection", () => {
    const notification = buildAssistantNotification(
      attemptSnapshot({
        walletResult: {
          to: "0xsecret-counterparty-address",
          signedBy: "agent",
        },
      } as Partial<AssistantAttemptSnapshot>),
    );
    const serialized = JSON.stringify(notification.projection);
    expect(serialized).not.toContain("0xsecret-counterparty-address");
    expect(serialized).not.toContain("signedBy");
  });
});
