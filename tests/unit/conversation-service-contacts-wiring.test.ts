import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The text agent's contact-list seam AS THE CONVERSATION SERVICE THREADS IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `list_contacts` comes from the ONE shared definition, but a tool nobody wires
 * on the text surface always answers `unavailable` — the exact shape of the text
 * agent's missing `contactActions` port. This suite proves the conversation
 * service (the constructor the HTTP server and the worker both use) really hands
 * its `contacts` dependency to `handleMessage`, over the real service.
 *
 * The `handleMessage` boundary is mocked so the assertion is about the OPTIONS
 * the service builds — the object production forwards into the agent context —
 * not about a model turn.
 */

const probes = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/agent/wallet-agent.js", () => ({
  handleMessage: vi.fn(async (_session: unknown, _text: string, options: Record<string, unknown>) => {
    probes.options.push(options);
    return { status: "answer" as const, message: "ok" };
  }),
}));

import { createWalletConversationService } from "../../src/conversations/service.js";

const userId = "11111111-1111-4111-8111-111111111111";

function snapshot() {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId,
    mode: "typed" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: "es" as const,
    generation: 1,
    messages: [],
  };
}

function repository() {
  const state = snapshot();
  return {
    get: async () => ({ ...state, messages: [...state.messages] }),
    saveSnapshot: async () => state,
    appendMessage: async () => undefined,
  } as never;
}

describe("conversation service contact-list wiring", () => {
  afterEach(() => {
    probes.options.length = 0;
    vi.clearAllMocks();
  });

  it("threads the contacts dependency into the text agent's handleMessage options", async () => {
    const contacts = { listActive: async () => [] };
    const service = createWalletConversationService({
      conversations: repository(),
      wallet: {} as never,
      contacts,
    });

    await service.handleTurn({ conversationId: snapshot().id, userId, text: "hola" });

    expect(probes.options).toHaveLength(1);
    expect(probes.options[0]!.contacts).toBe(contacts);
  });

  it("omits the key entirely when no contacts dependency was supplied (fail closed)", async () => {
    const service = createWalletConversationService({
      conversations: repository(),
      wallet: {} as never,
    });

    await service.handleTurn({ conversationId: snapshot().id, userId, text: "hola" });

    expect(probes.options).toHaveLength(1);
    expect(probes.options[0]).not.toHaveProperty("contacts");
  });
});
