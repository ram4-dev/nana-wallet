import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The text agent's contact-list seam AS `handleMessage` BUILDS THE CONTEXT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Even with the service threading `contacts`, the tool only sees it if
 * `handleMessage` puts it on the `WalletAgentContext` it hands to the definition.
 * A declared-but-unwired port is invisible to every hand-built-context test, so
 * this suite drives the REAL `handleMessage` and captures the context at the
 * shared definition — the object production forwards into the agent.
 */

const fixtures = vi.hoisted(() => ({ SENTINEL: "text-agent-context-captured" }));

const probes = vi.hoisted(() => ({
  contexts: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/agent/definition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/definition.js")>();
  return {
    ...actual,
    createWalletAgentDefinition: () => ({
      instructions: () => "",
      tools: (context: Record<string, unknown>) => {
        probes.contexts.push(context);
        // Abort the turn the moment the context is built: everything after needs
        // a live model. The capture happens first, so the recorded context is the
        // real one `handleMessage` constructed.
        throw new Error(fixtures.SENTINEL);
      },
    }),
  };
});

import { handleMessage } from "../../src/agent/wallet-agent.js";

const wallet = new Proxy({}, { get: () => () => Promise.resolve([]) }) as never;

describe("handleMessage contact-list wiring", () => {
  beforeEach(() => {
    probes.contexts.length = 0;
  });

  it("puts the contacts port on the context the shared definition receives", async () => {
    const contacts = { listActive: async () => [] };
    const session = { id: "conv-1", messages: [] };

    await expect(
      handleMessage(session, "¿qué contactos tengo?", { walletProvider: wallet, contacts }),
    ).rejects.toThrow(fixtures.SENTINEL);

    expect(probes.contexts).toHaveLength(1);
    const context = probes.contexts[0]!;
    expect(context.contacts).toBe(contacts);
    expect(context.conversationId).toBe("conv-1");
  });

  it("leaves the context without a contacts port when none was supplied", async () => {
    const session = { id: "conv-2", messages: [] };

    await expect(
      handleMessage(session, "¿qué contactos tengo?", { walletProvider: wallet }),
    ).rejects.toThrow(fixtures.SENTINEL);

    expect(probes.contexts).toHaveLength(1);
    expect(probes.contexts[0]).not.toHaveProperty("contacts");
  });
});
