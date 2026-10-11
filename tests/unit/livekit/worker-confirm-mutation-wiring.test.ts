/**
 * The confirmation-APPLICATION seam AS PRODUCTION BUILDS IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * A confirmation used to consume the proposal and report success while saving
 * NOTHING. Observed live: a proposal reached `status='consumed'`,
 * `consumed_by_tool=confirm_trusted_recipient_action`, with `contact_id` EMPTY,
 * no contact row, no `desired_revision` bump and no intent. The user was told
 * "Listo, ya registré tu confirmación" and nothing was saved.
 *
 * The cause was the same shape as three earlier defects in this change and as
 * `agent-tool-parity.test.ts` exists to prevent: every OTHER suite INJECTED the
 * seam, so nothing asserted that production supplies the REAL one. The port's
 * `consume` was wired as a bare CAS in its own transaction; `applyProposal` — the
 * one transaction that carries the CAS *and* the contact mutation — had to exist
 * and be supplied by the worker.
 *
 * HOW IT IS ASSERTED
 * ------------------
 * Behaviourally, over the real construction path, never over source text: the
 * worker entry is driven with a fake job context, the gate hands back the REAL
 * per-binding `startSession` the worker registered, that function runs, and the
 * dependency object PRODUCTION passes to `createVoiceContactActions` is captured
 * at the seam. The assertion is on what that object can DO: the captured
 * `applyProposal` is present, and the captured object carries no CAS-only
 * `consume` that would let a caller believe confirming saves something.
 */
import { describe, expect, it, vi } from "vitest";

import agent from "../../../src/livekit/worker.js";

const fixtures = vi.hoisted(() => ({
  SENTINEL: "voice-contact-dependencies-captured",
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

vi.mock("../../../src/livekit/contact-proposal-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/livekit/contact-proposal-publication.js")>();
  return {
    ...actual,
    createVoiceContactActions: (dependencies: Record<string, unknown>) => {
      probes.voiceContactDependencies.push(dependencies);
      // Abort the rest of the session start the moment the seam is built: the
      // remainder needs a live provider and is irrelevant here. Throwing AFTER
      // the capture is what keeps the captured object the one the real call site
      // built.
      throw new Error(fixtures.SENTINEL);
    },
  };
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "participant-1";

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

/** Runs the worker entry and returns the dependencies PRODUCTION passed to the seam. */
async function captureProductionDependencies(): Promise<Record<string, unknown>> {
  // `entry` parks on the binding promise, so it is deliberately never awaited.
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

describe("the confirmation-application seam as production builds it", () => {
  it("supplies the application transaction the port declares", async () => {
    const dependencies = await captureProductionDependencies();

    // Positive control first: this session HAS a bound visual client, so the seam
    // was built at all and a missing member below is a wiring gap, not a block
    // that never executed.
    expect(dependencies.boundParticipantIdentity).toBe(IDENTITY);
    // The application seam is what makes a confirmation SAVE. Without it the port
    // falls back to a CAS-only path, which is exactly the defect this pins.
    expect(typeof dependencies.applyProposal).toBe("function");
  });

  it("carries no CAS-only consume that could make a confirmation save nothing", async () => {
    const dependencies = await captureProductionDependencies();

    // `consume` was the bare CAS in its own transaction. If it were still
    // supplied alongside `applyProposal`, a caller could reach it and consume a
    // proposal without mutating anything — the original bug, still reachable.
    expect(dependencies).not.toHaveProperty("consume");
  });

  it("keeps the re-verification seam next to the application it guards", async () => {
    const dependencies = await captureProductionDependencies();

    // The S10/S11 ordering: the re-verification runs after the affirmative and
    // immediately before the persisted consume, so it must be a sibling of the
    // application seam rather than replaced by it.
    expect(typeof dependencies.reverifyAlias).toBe("function");
  });
});
