/**
 * The deployed text agent calls an OpenAI-compatible gateway, and that gateway
 * validates every function's parameters schema before it routes the completion.
 * A tool whose schema has no top-level `type: "object"` fails the WHOLE turn:
 *
 *   HTTP 400 {"error":{…,"message":"Invalid schema for function 'send_token':
 *             schema must be a JSON Schema of 'type: \"object\"', got
 *             'type: null'."}}
 *
 * `send_token` reaches the gateway through the guarded wrapper, whose schema is
 * a top-level `z.union` of the model-facing preview-only shape and the internal
 * broadcast shape. zod serializes a top-level union to a bare `anyOf`, so the
 * request died before the model ever saw the conversation, no matter which
 * recipient or amount the user asked for.
 *
 * These cases drive the real agent path (no mocked `fetch`, no hand-written
 * copy of the schema) against a local gateway double and assert on the captured
 * outbound request body, so they fail if the EMITTED schema loses its top-level
 * `type: "object"`, and if the dual-parse stops accepting either accepted shape
 * or stops rejecting the invalid one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asSchema } from "ai";

import { guardedSendTokenSchema, guardedSendTokenToolSchema } from "../../src/agent/definition.js";
import { handleMessage } from "../../src/agent/wallet-agent.js";
import {
  createConversationFixture,
  resetConversationFixtures,
} from "../../src/conversations/test-fixtures.js";

type ToolParameters = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
  anyOf?: ToolParameters[];
};

type CapturedRequest = {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

/** The model-facing preview-only shape: the model never supplies an address. */
const PREVIEW_ONLY_INPUT = {
  amount: "0.01",
  recipientId: "c-1",
  recipientVersion: 1,
};

/** The internal broadcast shape the deterministic and legacy paths exercise. */
const INTERNAL_BROADCAST_INPUT = {
  network: "solana-devnet",
  token: "SOL",
  to: "DFYT4RDcvr6vL46c7iVDmfBbEYQxAZhUxkgvwzuVHMEk",
  amount: "0.01",
  wallet: "agent-demo",
  dryRun: true,
};

/** Neither shape accepts an invented address next to the preview identity. */
const NEITHER_SHAPE_INPUT = { ...PREVIEW_ONLY_INPUT, to: INTERNAL_BROADCAST_INPUT.to };

function completion(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

type GatewayDouble = {
  baseURL: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

/**
 * OpenAI-compatible completion that asks for one `send_token` call, then a
 * plain answer, so the SDK's own tool-input validation runs on the schema the
 * provider was handed — the same artifact these cases assert on.
 */
function toolCallCompletion(model: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-fixture-1",
              type: "function",
              function: { name: "send_token", arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function startGatewayDouble(toolCall?: Record<string, unknown>): Promise<GatewayDouble> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      requests.push({ url: req.url, headers: req.headers, body });
      const model = String(body.model ?? "unknown");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        toolCall && requests.length === 1 ? toolCallCompletion(model, toolCall) : completion(model),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const gateways: GatewayDouble[] = [];
const previousEnvironment = {
  baseURL: process.env.OPENCODE_GO_BASE_URL,
  apiKey: process.env.OPENCODE_GO_API_KEY,
  runtime: process.env.AGENT_RUNTIME,
};

function restoreEnvironment(): void {
  for (const [name, value] of [
    ["OPENCODE_GO_BASE_URL", previousEnvironment.baseURL],
    ["OPENCODE_GO_API_KEY", previousEnvironment.apiKey],
    ["AGENT_RUNTIME", previousEnvironment.runtime],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(async () => {
  restoreEnvironment();
  resetConversationFixtures();
  while (gateways.length > 0) await gateways.pop()!.close();
});

/** Drives one real agent turn and returns every outbound request it produced. */
async function outboundRequests(): Promise<CapturedRequest[]> {
  const { requests, status } = await agentTurn();
  expect(status).toBe("answer");
  return requests;
}

/** Drives one real agent turn whose model asks for a single `send_token` call. */
async function agentTurn(
  toolCall?: Record<string, unknown>,
): Promise<{ requests: CapturedRequest[]; status: string }> {
  const double = await startGatewayDouble(toolCall);
  gateways.push(double);
  process.env.OPENCODE_GO_BASE_URL = double.baseURL;
  process.env.OPENCODE_GO_API_KEY = "fixture-key";
  process.env.AGENT_RUNTIME = "llm";

  const session = createConversationFixture();
  const result = await handleMessage(session, "hola");

  expect(double.requests.length).toBeGreaterThan(0);
  expect(double.requests[0]!.body.tools).toBeDefined();
  return { requests: double.requests, status: String(result.status) };
}

/** The tool-result message the model is handed for the tool call it made. */
function toolResultContent(requests: CapturedRequest[]): string {
  expect(requests).toHaveLength(2);
  const messages = requests[1]!.body.messages as { role?: string; content?: unknown }[];
  const result = messages.find((message) => message.role === "tool");
  expect(result, "the tool call must be answered with a tool result").toBeDefined();
  return String(result?.content);
}

/** The function tools of the outbound body, keyed by tool name. */
function bodyTools(body: Record<string, unknown>): Map<string, ToolParameters> {
  const raw = body.tools;
  expect(Array.isArray(raw)).toBe(true);
  const tools = new Map<string, ToolParameters>();
  for (const entry of raw as { function?: { name?: unknown; parameters?: ToolParameters } }[]) {
    const name = entry.function?.name;
    if (typeof name === "string" && entry.function?.parameters) {
      tools.set(name, entry.function.parameters);
    }
  }
  return tools;
}

describe("guarded send_token schema on the wire", () => {
  it("emits a top-level object schema for every tool the model is offered", async () => {
    const requests = await outboundRequests();
    const tools = bodyTools(requests[0]!.body);

    // The tool whose schema the gateway rejected must be in the request, or the
    // assertion below would pass vacuously.
    expect(tools.has("send_token")).toBe(true);
    expect([...tools.keys()].length).toBeGreaterThan(1);

    const withoutObjectType = [...tools.entries()]
      .filter(([, parameters]) => parameters.type !== "object")
      .map(([name]) => name);
    expect(withoutObjectType).toEqual([]);
  });

  it("keeps both guarded branches in the emitted send_token schema", async () => {
    const requests = await outboundRequests();
    const parameters = bodyTools(requests[0]!.body).get("send_token")!;

    expect(parameters.type).toBe("object");
    const branches = parameters.anyOf ?? [];
    expect(branches).toHaveLength(2);

    const previewOnly = branches.find((branch) =>
      (branch.required ?? []).includes("recipientId"));
    const internal = branches.find((branch) =>
      (branch.required ?? []).includes("dryRun"));

    expect(previewOnly?.required).toEqual(["amount", "recipientId", "recipientVersion"]);
    expect(previewOnly?.additionalProperties).toBe(false);
    expect(Object.keys(previewOnly?.properties ?? {})).toEqual([
      "amount",
      "recipientId",
      "recipientVersion",
      "memo",
    ]);
    expect(internal?.required).toEqual(["network", "token", "to", "amount", "wallet", "dryRun"]);
    expect(Object.keys(internal?.properties ?? {})).toEqual([
      "network",
      "token",
      "to",
      "amount",
      "wallet",
      "dryRun",
      "previewId",
    ]);
  });

  it("declares exactly the previous schema plus the implied object type", async () => {
    const requests = await outboundRequests();
    const parameters = bodyTools(requests[0]!.body).get("send_token")!;

    // The union serialization every branch of which is already an object: the
    // declared contract may not change in any other way.
    expect(parameters).toEqual({
      ...asSchema(guardedSendTokenSchema).jsonSchema,
      type: "object",
    });
  });
});

describe("guarded send_token dual-parse is unchanged", () => {
  it("accepts the model-facing preview-only shape", async () => {
    await expect(guardedSendTokenToolSchema.validate!(PREVIEW_ONLY_INPUT)).resolves.toMatchObject({
      success: true,
    });
    expect(guardedSendTokenSchema.safeParse(PREVIEW_ONLY_INPUT).success).toBe(true);
  });

  it("accepts the internal broadcast shape", async () => {
    await expect(
      guardedSendTokenToolSchema.validate!(INTERNAL_BROADCAST_INPUT),
    ).resolves.toMatchObject({ success: true });
    expect(guardedSendTokenSchema.safeParse(INTERNAL_BROADCAST_INPUT).success).toBe(true);
  });

  it("rejects an input neither shape accepts", async () => {
    await expect(guardedSendTokenToolSchema.validate!(NEITHER_SHAPE_INPUT)).resolves.toMatchObject({
      success: false,
    });
    expect(guardedSendTokenSchema.safeParse(NEITHER_SHAPE_INPUT).success).toBe(false);
  });

  it("agrees with the union on every accepted and rejected shape", async () => {
    const cases = [
      PREVIEW_ONLY_INPUT,
      { ...PREVIEW_ONLY_INPUT, memo: "rent" },
      INTERNAL_BROADCAST_INPUT,
      { ...INTERNAL_BROADCAST_INPUT, previewId: "11111111-1111-4111-8111-111111111111" },
      { ...INTERNAL_BROADCAST_INPUT, dryRun: undefined },
      NEITHER_SHAPE_INPUT,
      { ...PREVIEW_ONLY_INPUT, recipientVersion: 0 },
      { ...PREVIEW_ONLY_INPUT, memo: "x".repeat(201) },
      {},
    ];

    for (const value of cases) {
      const declared = await guardedSendTokenToolSchema.validate!(value);
      expect(
        { input: value, accepted: declared.success },
        `declared schema and the union must agree on ${JSON.stringify(value)}`,
      ).toEqual({ input: value, accepted: guardedSendTokenSchema.safeParse(value).success });
    }
  });

  it("executes a real model tool call carrying the internal broadcast shape", async () => {
    const { requests, status } = await agentTurn(INTERNAL_BROADCAST_INPUT);

    // A preview reaching the session is proof the tool RAN, so the SDK accepted
    // the internal shape through the very schema the provider was handed.
    const content = toolResultContent(requests);
    expect(content).toContain('"preview":true');
    expect(content).not.toContain("InvalidToolInputError");
    expect(status).toBe("confirmation_required");
  });

  it("refuses a real model tool call carrying an input neither shape accepts", async () => {
    const { requests, status } = await agentTurn(NEITHER_SHAPE_INPUT);

    // The wrapper's dual-parse still refuses it: no preview, and the refusal
    // names the invented key instead of executing a broadcast.
    const content = toolResultContent(requests);
    expect(content).toContain("Invalid input for tool send_token");
    expect(content).toContain('Unrecognized key: \\"to\\"');
    expect(content).not.toContain('"preview":true');
    expect(status).not.toBe("confirmation_required");
  });
});
