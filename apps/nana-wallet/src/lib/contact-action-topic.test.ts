import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTACT_ACTION_PROPOSAL_TOPIC,
  publishContactActionProposal,
  subscribeToContactActionProposals,
} from "./contact-action-topic";

/**
 * The card topic is a wakeup channel, not a data channel, so its contract is
 * narrow on purpose: a payload that is not a proposal wakeup must reach nobody
 * (a card that reloaded on garbage would be a rendering bug waiting to happen),
 * and only the newest version is worth acting on.
 */
const WAKEUP = {
  type: "contact_action_proposal" as const,
  proposalId: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
  proposalVersion: 2,
  conversationId: "c1",
};

describe("contact action proposal topic", () => {
  beforeEach(() => {
    // The bus is module state: unsubscribe after every case so suites stay order-independent.
  });

  it("names the topic the backend publishes on (design §8.1)", () => {
    expect(CONTACT_ACTION_PROPOSAL_TOPIC).toBe("contact_action_proposal");
  });

  it("delivers a wakeup to every subscriber and stops after unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeToContactActionProposals(first);
    const offSecond = subscribeToContactActionProposals(second);

    expect(publishContactActionProposal(WAKEUP)).toBe(true);
    expect(first).toHaveBeenCalledWith(WAKEUP);
    expect(second).toHaveBeenCalledWith(WAKEUP);

    offFirst();
    expect(publishContactActionProposal(WAKEUP)).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
    expect(publishContactActionProposal(WAKEUP)).toBe(true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("accepts the full backend card packet but delivers only the wakeup identity", () => {
    // The backend publishes the whole card on this topic (`contactProposalCard`),
    // so the guard must accept it — and the card must still reload the row rather
    // than use any of these values. Only the two identity fields are read.
    const listener = vi.fn<(notification: unknown) => void>();
    const off = subscribeToContactActionProposals(listener);
    const card = {
      ...WAKEUP,
      action: "remove",
      contactId: null,
      contactVersion: null,
      address: "11111111111111111111111111111111",
      previousAddress: null,
      revokedGrantIds: [],
      summary: "Quitar a este destinatario",
      revocationDisclosure: null,
      expiresAt: "2026-10-10T00:05:00.000Z",
    };
    expect(publishContactActionProposal(card)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.keys(listener.mock.calls[0]![0] as object).sort()).toEqual(
      Object.keys(card).sort(),
    );
    off();
  });

  it.each([
    ["a different type", { ...WAKEUP, type: "conversation_state_changed" }],
    ["a version that is not an integer", { ...WAKEUP, proposalVersion: "2" }],
    ["no proposal id", { ...WAKEUP, proposalId: "" }],
    ["not an object", "contact_action_proposal"],
    ["null", null],
  ])("refuses to wake a card for %s", (_case, payload) => {
    const listener = vi.fn();
    const off = subscribeToContactActionProposals(listener);
    expect(publishContactActionProposal(payload)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    // Positive control in the same case: the declared wakeup DOES arrive, so the
    // refusal above is the shape guard and not a dead bus.
    expect(publishContactActionProposal(WAKEUP)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
