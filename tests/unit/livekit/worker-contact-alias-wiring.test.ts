/**
 * The voice alias seam AS PRODUCTION BUILDS IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The stage-time alias arm was fail-closed in production for the whole life of
 * the feature: `createVoiceContactActions` was called without `resolveAlias`, so
 * every spoken `.sns` name was refused with `RESOLVEDOR_NO_DISPONIBLE` before a
 * proposal row existed. It survived a full implementation and two verification
 * passes because every OTHER suite INJECTED the dependency, so nothing asserted
 * that production supplies it — the same shape as `agent-tool-parity.test.ts`
 * ("every shared tool name must survive the real adapters, not a hand-built
 * context").
 *
 * HOW IT IS ASSERTED
 * ------------------
 * Behaviourally, over the real construction path, never over source text: the
 * worker entry is driven with a fake job context, the gate hands back the REAL
 * per-binding `startSession` the worker registered, that function runs, and the
 * dependency object PRODUCTION passes to `createVoiceContactActions` is captured
 * at the seam. The captured `resolveAlias` is then CALLED, over a real
 * `createSnsResolver` built by the worker itself from a stubbed transport, so the
 * assertions are about observable resolutions rather than about the presence of a
 * key.
 *
 * WHAT IS FAKE, AND WHY THAT IS NOT THE POINT UNDER TEST: the transport (no RPC),
 * the job context, the room/gate plumbing, the worker dependencies and the
 * recipient-memory runtime. `runJob`'s construction of the seam — including which
 * dependencies are conditioned on the resolver existing — is the real code.
 */
import { describe, expect, it, vi } from "vitest";

import type { AliasResolution } from "../../../src/livekit/contact-proposal-publication.js";
import agent from "../../../src/livekit/worker.js";

const fixtures = vi.hoisted(() => ({
  DEVNET_ROOT: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
  NAME_PROGRAM_OWNER: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",
  NAME_ACCOUNT: "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew",
  /** The recorded devnet resolution of `sophie.sns`. */
  SOPHIE_ADDRESS: "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2",
  /** Thrown by the seam capture below, once the dependency object is recorded. */
  SENTINEL: "voice-contact-dependencies-captured",
}));

/** The stubbed transport's answer, set per case. */
const behaviour = vi.hoisted(() => ({
  readName: "registered" as "registered" | "absent" | "throttled",
  transportUnavailable: false,
}));

const probes = vi.hoisted(() => ({
  startSessions: [] as Array<
    (binding: { conversationId: string; userId: string }) => Promise<void>
  >,
  voiceContactDependencies: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/config/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/process.js")>();
  return {
    ...actual,
    readWorkerProcessConfig: () => ({
      url: "ws://livekit.invalid",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicKey: "test-public-key",
      shutdownTimeoutMs: 10,
      agentRuntime: "native-livekit" as const,
      databaseUrl: "postgres://unused",
    }),
  };
});

vi.mock("../../../src/runtime/dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/runtime/dependencies.js")>();
  return {
    ...actual,
    // The seam is captured before any of these is used for I/O.
    createWorkerDependencies: () => ({}) as never,
  };
});

vi.mock("../../../src/memory/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/memory/runtime.js")>();
  // Orthogonal to the alias wiring, and it would otherwise reach the ambient
  // `.env` of a developer checkout.
  return { ...actual, getConfiguredRecipientMemoryService: () => undefined };
});

vi.mock("../../../src/livekit/room-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/livekit/room-conversation.js")>();
  return {
    ...actual,
    // The gate's only job here is to hand back the `startSession` the worker
    // registered, so the real construction inside it can be driven directly.
    createRoomConversationGate: (input: {
      startSession: (binding: { conversationId: string; userId: string }) => Promise<void>;
    }) => {
      probes.startSessions.push(input.startSession);
      return {
        bind: async () => ({ ok: false as const, code: "invalid_binding" as const }),
        handleFinalTranscript: async function* () {
          yield { ok: false as const, code: "not_bound" as const };
        },
      };
    },
  };
});

vi.mock("../../../src/wallet/sns/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/wallet/sns/transport.js")>();
  const { PublicKey } = await import("@solana/web3.js");
  // The recorded 96-byte header: `parentName` 0..32, `owner` 32..64.
  const header = new Uint8Array(96);
  header.set(new PublicKey(fixtures.DEVNET_ROOT).toBytes(), 0);
  header.set(new PublicKey(fixtures.SOPHIE_ADDRESS).toBytes(), 32);
  return {
    ...actual,
    createSnsTransport: () => {
      if (behaviour.transportUnavailable) throw new Error("no rpc endpoint configured");
      return {
        deriveNameAccount: () => ({ pubkey: fixtures.NAME_ACCOUNT }),
        readNameRegistry: async () => {
          if (behaviour.readName === "throttled") throw new Error("429 Too Many Requests");
          if (behaviour.readName === "absent") return null;
          return { data: header, owner: fixtures.NAME_PROGRAM_OWNER, slot: 1 };
        },
        readPrimaryDomain: async () => ({ kind: "none" as const }),
      };
    },
  };
});

vi.mock("../../../src/livekit/contact-proposal-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/livekit/contact-proposal-publication.js")>();
  return {
    ...actual,
    createVoiceContactActions: (dependencies: Record<string, unknown>) => {
      probes.voiceContactDependencies.push(dependencies);
      // Abort the rest of the session start the moment the seam is built: the
      // remainder (realtime tools, agent session) needs a live provider and is
      // irrelevant here. Throwing AFTER the capture is what keeps the captured
      // object the one the real call site built.
      throw new Error(fixtures.SENTINEL);
    },
  };
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "participant-1";

type ResolveAlias = (input: { userId: string; snsName: string }) => Promise<AliasResolution>;

function fakeJobContext() {
  const rpcMethods = new Map<string, unknown>();
  return {
    connect: vi.fn(async () => {}),
    waitForParticipant: vi.fn(async () => ({ identity: IDENTITY })),
    room: { remoteParticipants: new Map([[IDENTITY, {}]]) },
    agent: {
      publishData: vi.fn(async () => {}),
      registerRpcMethod: vi.fn((name: string, handler: unknown) => {
        rpcMethods.set(name, handler);
      }),
      unregisterRpcMethod: vi.fn((name: string) => {
        rpcMethods.delete(name);
      }),
    },
    workerId: "worker-1",
    addShutdownCallback: vi.fn(),
    shutdown: vi.fn(),
  };
}

/**
 * Runs the worker entry and returns the dependency object PRODUCTION passed to
 * `createVoiceContactActions` for one session.
 */
async function captureProductionDependencies(
  overrides: Partial<{
    readName: "registered" | "absent" | "throttled";
    transportUnavailable: boolean;
  }> = {},
): Promise<Record<string, unknown>> {
  behaviour.readName = overrides.readName ?? "registered";
  behaviour.transportUnavailable = overrides.transportUnavailable ?? false;

  // `entry` parks on the binding promise (the gate resolves it when a
  // participant binds), so it is deliberately never awaited to completion.
  const entry = agent.entry(fakeJobContext() as never);
  void entry;

  await vi.waitFor(() => expect(probes.startSessions.length).toBeGreaterThan(0));
  const startSession = probes.startSessions[probes.startSessions.length - 1]!;

  const before = probes.voiceContactDependencies.length;
  await expect(
    startSession({ conversationId: CONVERSATION_ID, userId: USER_ID }),
  ).rejects.toThrow(fixtures.SENTINEL);
  await vi.waitFor(() => expect(probes.voiceContactDependencies.length).toBe(before + 1));

  return probes.voiceContactDependencies[probes.voiceContactDependencies.length - 1]!;
}

describe("the voice alias seam as production builds it", () => {
  it("passes the stage-time alias resolver the port declares", async () => {
    const dependencies = await captureProductionDependencies();

    // Positive control first: the conditional block DID run for this session, so
    // a missing `resolveAlias` below is a wiring gap and not a block that never
    // executed.
    expect(typeof dependencies.reverifyAlias).toBe("function");
    expect(typeof dependencies.resolveAlias).toBe("function");
  });

  it("resolves a name through the wired adapter, with the address the resolver read", async () => {
    const dependencies = await captureProductionDependencies({ readName: "registered" });

    const resolution = await (dependencies.resolveAlias as ResolveAlias)({
      userId: USER_ID,
      snsName: "sophie.sns",
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      snsName: "sophie.sns",
      address: fixtures.SOPHIE_ADDRESS,
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    });
    // The freshness stamp is the resolver's own observation, not the caller's.
    const { resolvedAt } = resolution as { resolvedAt: string };
    expect(new Date(resolvedAt).toISOString()).toBe(resolvedAt);
  });

  it("never narrates an unreachable registry as a name that does not exist", async () => {
    const absent = await captureProductionDependencies({ readName: "absent" });
    const missing = await (absent.resolveAlias as ResolveAlias)({
      userId: USER_ID,
      snsName: "sophie.sns",
    });
    const throttled = await captureProductionDependencies({ readName: "throttled" });
    const unreachable = await (throttled.resolveAlias as ResolveAlias)({
      userId: USER_ID,
      snsName: "sophie.sns",
    });

    // Positive control: the wired adapter resolved THROUGH the stub for both
    // cases — the difference below is the classification, not a missing wiring.
    expect(missing).toMatchObject({ status: "refused", code: "NOMBRE_NO_ENCONTRADO" });
    expect(unreachable).toMatchObject({ status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE" });
    expect((missing as { code: string }).code).not.toBe((unreachable as { code: string }).code);
  });

  it("is present exactly when the worker could build its SNS resolver", async () => {
    const dependencies = await captureProductionDependencies({ transportUnavailable: true });

    // Fail closed: a deployment with no usable endpoint must not claim it
    // resolved a name, and must not report the name as missing either.
    expect(dependencies).not.toHaveProperty("resolveAlias");
    expect(dependencies).not.toHaveProperty("reverifyAlias");
  });
});
