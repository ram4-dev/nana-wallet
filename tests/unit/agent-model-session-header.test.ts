/**
 * The deployed text agent calls the OpenCode zen gateway (`opencode-go`), which
 * routes a completion by the caller's session id and rejects a request that
 * does not carry it:
 *
 *   HTTP 400 {"type":"MissingSessionID",
 *             "message":"Request is missing x-opencode-session and cannot be
 *                        routed efficiently."}
 *
 * A missing header therefore fails EVERY LLM turn in the deployment: no balance
 * answer, no named-recipient preview, no trusted-recipient action. These cases
 * drive the real provider transport (no mocked `fetch`) against a local gateway
 * double and assert the header on the outbound request, plus the wiring from
 * the conversation session.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateText } from "ai";

import { createOpenCodeGoModel } from "../../src/agent/model.js";
import { handleMessage } from "../../src/agent/wallet-agent.js";
import {
  createConversationFixture,
  resetConversationFixtures,
} from "../../src/conversations/test-fixtures.js";

type CapturedRequest = {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: { model?: string } & Record<string, unknown>;
};

const SESSION_HEADER = "x-opencode-session";

/** Minimal OpenAI-compatible chat completion, sufficient for one agent turn. */
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

async function startGatewayDouble(): Promise<GatewayDouble> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(completion(String(body.model ?? "unknown")));
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

async function gateway(): Promise<GatewayDouble> {
  const started = await startGatewayDouble();
  gateways.push(started);
  return started;
}

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

describe("opencode-go gateway session header", () => {
  it("sends the conversation session id as x-opencode-session on the completion request", async () => {
    const double = await gateway();
    const model = createOpenCodeGoModel("1910e0f4-2a2b-4b0a-9c31-6f7f0f5b1b7a", {
      apiKey: "fixture-key",
      baseURL: double.baseURL,
      model: "fixture-model",
    });

    await generateText({ model, prompt: "Reply with the single word: ok" });

    expect(double.requests).toHaveLength(1);
    expect(double.requests[0]!.headers[SESSION_HEADER]).toBe(
      "1910e0f4-2a2b-4b0a-9c31-6f7f0f5b1b7a",
    );
  });

  it("carries a per-session id, never one shared constant", async () => {
    const double = await gateway();
    const config = {
      apiKey: "fixture-key",
      baseURL: double.baseURL,
      model: "fixture-model",
    };

    await generateText({
      model: createOpenCodeGoModel("session-one", config),
      prompt: "one",
    });
    await generateText({
      model: createOpenCodeGoModel("session-two", config),
      prompt: "two",
    });

    expect(double.requests.map((request) => request.headers[SESSION_HEADER])).toEqual([
      "session-one",
      "session-two",
    ]);
  });

  it("sends the agent turn's own conversation id, without any caller supplying a header", async () => {
    const double = await gateway();
    process.env.OPENCODE_GO_BASE_URL = double.baseURL;
    process.env.OPENCODE_GO_API_KEY = "fixture-key";
    process.env.AGENT_RUNTIME = "llm";

    const session = createConversationFixture();
    const result = await handleMessage(session, "hola");

    expect(result.status).toBe("answer");
    expect(double.requests.length).toBeGreaterThan(0);
    for (const request of double.requests) {
      expect(request.headers[SESSION_HEADER]).toBe(session.id);
    }
  });
});
