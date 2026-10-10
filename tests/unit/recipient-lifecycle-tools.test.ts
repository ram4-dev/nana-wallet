import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWalletAgentDefinition,
  VOICE_ONLY_TOOLS,
  type ContactActionPort,
  type WalletAgentContext,
} from "../../src/agent/definition.js";
import { toAiSdkTools } from "../../src/agent/ai-sdk-adapter.js";
import { toLivekitRealtimeTools } from "../../src/agent/livekit-realtime-adapter.js";

/**
 * Trusted-recipient lifecycle tools (task 4.2).
 *
 * The model boundary is proposal-only and version-bound: the three `stage_*`
 * tools plus `confirm_trusted_recipient_action` are produced by the ONE shared
 * definition, their `.strict()` schemas accept only server-owned identifiers
 * (`proposalId`, `contactId`, `expectedVersion`) and display metadata
 * (`name`, `description`), and every execution delegates to the server-owned
 * contact-action port. An address, a chain, a policy, a signer, a cap, a
 * confirmation phrase, a timestamp or a turn counter supplied by the model is a
 * schema rejection, never an ignored extra key.
 */

const LIFECYCLE_TOOLS = [
  "stage_trusted_recipient",
  "stage_trusted_recipient_edit",
  "stage_trusted_recipient_removal",
  "confirm_trusted_recipient_action",
] as const;

const CONTACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROPOSAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type StageCall = Parameters<ContactActionPort["stage"]>[0];
type ConfirmCall = Parameters<NonNullable<ContactActionPort["confirm"]>>[0];

/** A recording stand-in for the server-owned proposal service. */
function recordingPort() {
  const staged: StageCall[] = [];
  const confirmed: ConfirmCall[] = [];
  const port: ContactActionPort = {
    stage: async (input) => {
      staged.push(input);
      return { status: "staged", proposalId: PROPOSAL_ID, proposalVersion: 1, message: "revisá la tarjeta" };
    },
    confirm: async (input) => {
      confirmed.push(input);
      return { status: "consumed", message: "listo" };
    },
  };
  return { port, staged, confirmed };
}

function context(port?: ContactActionPort, overrides: Partial<WalletAgentContext> = {}): WalletAgentContext {
  return {
    conversationId: "conv-1",
    userId: "user-1",
    language: "es",
    config: { wallet: "wallet", network: "solana-devnet", token: "SOL" },
    session: { id: "conv-1", messages: [] },
    wallet: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
    ...(port ? { contactActions: port } : {}),
    ...overrides,
  };
}

function tool(name: string, ctx: WalletAgentContext) {
  const found = createWalletAgentDefinition()
    .tools(ctx)
    .find((candidate) => candidate.name === name);
  expect(found, `tool ${name} is missing from the shared definition`).toBeDefined();
  return found!;
}

function parse(name: string, ctx: WalletAgentContext, input: unknown) {
  return (tool(name, ctx).inputSchema as z.ZodType).safeParse(input);
}

/** Keys a model must never be able to smuggle into a lifecycle tool call. */
const FORBIDDEN_KEYS: Array<[string, unknown]> = [
  ["address", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
  ["network", "solana-devnet"],
  ["policyId", "pol_123"],
  ["signerId", "did:privy:signer"],
  ["cap", "10000000"],
  ["maxPerTransfer", "10000000"],
  ["amount", "1"],
  ["confirmationId", "conf-1"],
  ["timestamp", 1_700_000_000],
  ["turnCount", 4],
  ["userId", "someone-else"],
  ["conversationId", "other-conversation"],
];

describe("trusted-recipient lifecycle tools", () => {
  it("exposes the four lifecycle tools on both surfaces from the same definition", () => {
    const definition = createWalletAgentDefinition();
    const textNames = Object.keys(toAiSdkTools(definition, context())).sort();
    const voiceTools = toLivekitRealtimeTools(definition, context(undefined, { voiceService: undefined })) as unknown as Array<{
      name: string;
      parameters: unknown;
    }>;
    const voiceNames = voiceTools.map((entry) => entry.name);

    for (const name of LIFECYCLE_TOOLS) {
      expect(textNames, `${name} missing on the text surface`).toContain(name);
      expect(voiceNames, `${name} missing on the voice surface`).toContain(name);
      const voice = voiceTools.find((entry) => entry.name === name)!;
      const shared = definition.tools(context()).find((entry) => entry.name === name)!;
      expect(voice.parameters).toEqual(shared.inputSchema as never);
    }
    // The only permitted divergence stays the declared spoken-decision tools.
    expect(VOICE_ONLY_TOOLS).toEqual(["confirm_transfer", "cancel_transfer"]);
  });

  it("delegates to the server-owned port with server-owned identity (positive control)", async () => {
    const { port, staged } = recordingPort();
    const ctx = context(port);

    const created = await tool("stage_trusted_recipient", ctx).execute({ name: "Marta", description: "nieta" }, ctx);
    expect(created).toMatchObject({ status: "staged", proposalId: PROPOSAL_ID });
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      action: "create",
      origin: "text",
      userId: "user-1",
      conversationId: "conv-1",
      name: "Marta",
    });

    await tool("stage_trusted_recipient_edit", ctx).execute({ contactId: CONTACT_ID, expectedVersion: 3 }, ctx);
    await tool("stage_trusted_recipient_removal", ctx).execute({ contactId: CONTACT_ID, expectedVersion: 3 }, ctx);
    expect(staged.map((call) => call.action)).toEqual(["create", "edit", "remove"]);
    // The exact version the model named is what the server receives.
    expect(staged[1].expectedVersion).toBe(3);
    expect(staged[2].expectedVersion).toBe(3);

    const voiceCtx = context(port, { voiceService: {} as never });
    await tool("stage_trusted_recipient", voiceCtx).execute({ name: "Marta" }, voiceCtx);
    expect(staged[3].origin).toBe("voice");
  });

  it("fails closed to a review request when no server-owned port is wired", async () => {
    const ctx = context();
    for (const name of LIFECYCLE_TOOLS) {
      const input = name === "confirm_trusted_recipient_action"
        ? { proposalId: PROPOSAL_ID, proposalVersion: 1 }
        : name === "stage_trusted_recipient"
          ? { name: "Marta" }
          : { contactId: CONTACT_ID, expectedVersion: 1 };
      expect(await tool(name, ctx).execute(input, ctx)).toMatchObject({ status: "address_review_required" });
    }
  });

  it("rejects model-supplied address, chain, policy, signer, cap and confirmation evidence", () => {
    const ctx = context(recordingPort().port);
    const valid: Record<(typeof LIFECYCLE_TOOLS)[number], unknown> = {
      stage_trusted_recipient: { name: "Marta" },
      stage_trusted_recipient_edit: { contactId: CONTACT_ID, expectedVersion: 3 },
      stage_trusted_recipient_removal: { contactId: CONTACT_ID, expectedVersion: 3 },
      confirm_trusted_recipient_action: { proposalId: PROPOSAL_ID, proposalVersion: 1 },
    };

    for (const name of LIFECYCLE_TOOLS) {
      // Positive control: the documented payload IS accepted.
      expect(parse(name, ctx, valid[name]).success, `${name} rejects its own valid payload`).toBe(true);

      for (const [key, value] of FORBIDDEN_KEYS) {
        const result = parse(name, ctx, { ...(valid[name] as object), [key]: value });
        expect(result.success, `${name} accepted a model-supplied ${key}`).toBe(false);
        expect(
          result.success ? [] : result.error.issues.map((issue) => issue.code),
          `${name} rejected ${key} for the wrong reason`,
        ).toContain("unrecognized_keys");
      }
    }
  });

  it("cannot select a contact by an ambiguous name or an unversioned identifier", () => {
    const ctx = context(recordingPort().port);
    const issuesOf = (name: string, input: unknown) => {
      const result = parse(name, ctx, input);
      expect(result.success, `${name} accepted ${JSON.stringify(input)}`).toBe(false);
      return result.success ? [] : result.error.issues;
    };
    for (const name of ["stage_trusted_recipient_edit", "stage_trusted_recipient_removal"] as const) {
      // A label is not a selector: the missing identifier is what is reported,
      // so the model must ask which recipient it means.
      expect(issuesOf(name, { name: "Marta", expectedVersion: 3 }).map((issue) => issue.path[0]), `${name} accepted a name instead of an id`).toContain(
        "contactId",
      );
      // ...and a label supplied ALONGSIDE the id is an unrecognised key, not an alias.
      expect(
        issuesOf(name, { contactId: CONTACT_ID, expectedVersion: 3, name: "Marta" }).map((issue) => issue.code),
        `${name} treated a name as an alias`,
      ).toContain("unrecognized_keys");
      expect(issuesOf(name, { contactId: "Marta", expectedVersion: 3 }).map((issue) => issue.path[0])).toContain("contactId");
      expect(issuesOf(name, { contactId: CONTACT_ID }).map((issue) => issue.path[0])).toContain("expectedVersion");
      expect(issuesOf(name, { contactId: CONTACT_ID, expectedVersion: 0 }).map((issue) => issue.path[0])).toContain("expectedVersion");
      expect(
        issuesOf(name, { contactId: CONTACT_ID, expectedVersion: 1.5 }).map((issue) => issue.path[0]),
        `${name} accepted a fractional version`,
      ).toContain("expectedVersion");
      expect(parse(name, ctx, { contactId: CONTACT_ID, expectedVersion: 3 }).success).toBe(true);
    }
  });

  it("surfaces a stale-version refusal verbatim and never stages on it", async () => {
    const calls: StageCall[] = [];
    const stale: ContactActionPort = {
      stage: async (input) => {
        calls.push(input);
        // The documented service contract: a stale version cannot select a
        // proposal, so it asks for a fresh one instead of mutating.
        return input.expectedVersion === 3
          ? { status: "staged", proposalId: PROPOSAL_ID, proposalVersion: 4, message: "revisá la tarjeta" }
          : { status: "confirmation_required", message: "ese destinatario cambió; te preparo la propuesta de nuevo" };
      },
    };
    const ctx = context(stale);
    const refusal = await tool("stage_trusted_recipient_removal", ctx).execute(
      { contactId: CONTACT_ID, expectedVersion: 2 },
      ctx,
    );
    expect(refusal).toMatchObject({ status: "confirmation_required" });
    expect(refusal).not.toHaveProperty("proposalVersion");
    // The stale version travels unchanged; the tool cannot launder it.
    expect(calls[0]).toMatchObject({ action: "remove", contactId: CONTACT_ID, expectedVersion: 2 });

    const fresh = await tool("stage_trusted_recipient_removal", ctx).execute(
      { contactId: CONTACT_ID, expectedVersion: 3 },
      ctx,
    );
    expect(fresh).toMatchObject({ status: "staged", proposalVersion: 4 });
  });

  it("binds confirmation to the exact proposal version and never to a phrase", async () => {
    const { port, confirmed } = recordingPort();
    const ctx = context(port);
    const result = await tool("confirm_trusted_recipient_action", ctx).execute(
      { proposalId: PROPOSAL_ID, proposalVersion: 2 },
      ctx,
    );
    expect(result).toMatchObject({ status: "consumed" });
    expect(confirmed[0]).toMatchObject({
      userId: "user-1",
      conversationId: "conv-1",
      proposalId: PROPOSAL_ID,
      proposalVersion: 2,
      source: "text",
    });
    // `source` is server-derived from the runtime, not a model argument.
    const voiceCtx = context(port, { voiceService: {} as never });
    await tool("confirm_trusted_recipient_action", voiceCtx).execute({ proposalId: PROPOSAL_ID, proposalVersion: 2 }, voiceCtx);
    expect(confirmed[1].source).toBe("voice");
  });

  it("keeps the realtime voice module free of hand-written tool bodies", () => {
    const source = readFileSync("src/livekit/realtime-tools/create-realtime-tools.ts", "utf8");
    // No tool schema of its own, and no duplicated lifecycle tool names: the
    // voice module maps the shared definition instead of restating it.
    expect(source).not.toMatch(/z\.object\(/);
    for (const name of LIFECYCLE_TOOLS) expect(source).not.toContain(name);
    expect(source).toContain("toLivekitRealtimeTools(createWalletAgentDefinition()");
  });

  it("keeps the shared definition free of a livekit import", () => {
    const source = readFileSync("src/agent/definition.ts", "utf8");
    expect(source).not.toMatch(/@livekit\//);
  });

  it("announces the agent-visible lifecycle surface without an address field", () => {
    const definition = createWalletAgentDefinition();
    for (const name of LIFECYCLE_TOOLS) {
      const entry = definition.tools(context()).find((candidate) => candidate.name === name)!;
      const json = JSON.stringify(z.toJSONSchema(entry.inputSchema as z.ZodType));
      expect(json).not.toMatch(/address|network|policy|signer|cap|confirmationId|timestamp|turnCount/i);
    }
  });
});
