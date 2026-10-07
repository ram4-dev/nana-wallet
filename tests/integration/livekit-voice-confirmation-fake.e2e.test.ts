import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeTools } from "../../src/livekit/realtime-tools/create-realtime-tools.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import { createVoiceDecisionGate } from "../../src/livekit/voice-decision-gate.js";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function harness(options: { interrupted?: boolean; earlyConfirmation?: boolean } = {}) {
  const gate = createVoiceDecisionGate({ isConfirmation, isCancellation });
  const pending = {
    previewId: "preview-1",
    network: "solana-devnet",
    token: "SOL",
    amount: "0.01",
    to: RECIPIENT,
  };
  let dispatches = 0;
  const conversations = {
    get: vi.fn(async () => ({ pendingTransfer: pending, language: "es" })),
  };
  const service = {
    previewTransfer: vi.fn(async () => ({
      status: "confirmation_required" as const,
      message: "Preparé la transferencia.",
      preview: {
        network: "solana-devnet",
        token: "SOL",
        recipient: RECIPIENT,
        amount: "0.01",
        estimatedFee: "0.000005 SOL",
      },
    })),
    resolveDecision: vi.fn(async function* (input: { decision: "confirm" | "cancel" }) {
      if (input.decision === "confirm") dispatches += 1;
      yield {
        type: "turn-completed" as const,
        result: input.decision === "confirm"
          ? { status: "sent" as const, message: "Transfer confirmed.", transaction: { transactionHash: "signature" } }
          : { status: "cancelled" as const, message: "Transfer cancelled." },
      };
    }),
  };
  const recipientMemory = {
    getRecipientForVersion: vi.fn(async () => ({
      id: "contact-1",
      version: 4,
      name: "Ana",
      network: "solana-devnet",
      address: RECIPIENT,
    })),
  };
  const spoken: string[] = [];
  const tools = createRealtimeTools({
    conversationId: "conversation-1",
    userId: "user-1",
    wallet: {
      listNetworks: async () => [],
      listTokens: async () => [],
      getAddress: async () => ({ network: "arc-testnet", address: "0xtest" }),
      getBalance: async () => ({ network: "arc-testnet", token: "USDC", address: "0xtest", balance: "0" }),
      getHistory: async () => ({ network: "arc-testnet", transactions: [] }),
    } as never,
    service: service as never,
    conversations: conversations as never,
    recipientMemory: recipientMemory as never,
    voiceDecisionGate: gate,
    speakPreview: vi.fn(async (text: string) => {
      spoken.push(text);
      if (options.earlyConfirmation) {
        gate.recordTranscript({ previewId: "preview-1", text: "sí", isFinal: true, authenticatedSpeaker: true, createdAt: Date.now() + 1 });
      }
      return { interrupted: options.interrupted ?? false };
    }),
  });
  const byName = (name: string) =>
    (tools as unknown as Array<{ name: string; execute: (input: unknown) => Promise<Record<string, unknown>> }>).find((t) => t.name === name)!;
  const send = (input = { amount: "0.01", recipientId: "contact-1", recipientVersion: 4 }) =>
    byName("send_token").execute(input);
  const confirm = () => byName("confirm_transfer").execute({});
  const cancel = () => byName("cancel_transfer").execute({});
  const speakDecision = (text: string, overrides: { isFinal?: boolean; authenticatedSpeaker?: boolean } = {}) =>
    gate.recordTranscript({
      previewId: "preview-1",
      text,
      isFinal: overrides.isFinal ?? true,
      authenticatedSpeaker: overrides.authenticatedSpeaker ?? true,
      createdAt: Date.now() + 1,
    });
  return { gate, pending, conversations, service, spoken, send, confirm, cancel, speakDecision, dispatches: () => dispatches };
}

describe("fake LiveKit voice authorization E2E", () => {
  beforeEach(() => {
    delete process.env.WDK_NETWORK;
    delete process.env.WDK_TOKEN;
  });

  it("rejects a forged confirm tool call and interim speech, then broadcasts after the completed read-back and a fresh final yes", async () => {
    const worker = harness();
    await worker.send();
    expect(worker.spoken[0]).toContain("0.01 SOL");
    expect(worker.spoken[0]).toContain("Ana");
    expect(worker.spoken[0]).toContain("0.000005 SOL");

    expect(await worker.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    worker.speakDecision("sí", { isFinal: false });
    expect(await worker.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    expect(worker.service.resolveDecision).not.toHaveBeenCalled();

    worker.speakDecision("sí");
    expect(await worker.confirm()).toMatchObject({ status: "sent" });
    expect(worker.dispatches()).toBe(1);
  });

  it("ignores a confirmation spoken before narration completes", async () => {
    const worker = harness({ earlyConfirmation: true });
    await worker.send();
    expect(await worker.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    expect(worker.service.resolveDecision).not.toHaveBeenCalled();
  });

  it("does not authorize after interrupted narration", async () => {
    const worker = harness({ interrupted: true });
    await worker.send();
    worker.speakDecision("sí");
    expect(await worker.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    expect(worker.service.resolveDecision).not.toHaveBeenCalled();
  });

  it("cancels only the active preview and never dispatches a transfer", async () => {
    const worker = harness();
    await worker.send();
    worker.speakDecision("cancelar");
    expect(await worker.cancel()).toMatchObject({ status: "cancelled" });
    expect(worker.service.resolveDecision).toHaveBeenCalledTimes(1);
    expect(worker.service.resolveDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "cancel" }));
    expect(worker.dispatches()).toBe(0);
  });

  it("rejects a replaced preview and lets only one concurrent callback consume the speech", async () => {
    const stale = harness();
    await stale.send();
    stale.speakDecision("sí");
    stale.pending.previewId = "replacement-preview";
    expect(await stale.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    expect(stale.service.resolveDecision).not.toHaveBeenCalled();

    const raced = harness();
    await raced.send();
    raced.speakDecision("sí");
    const outcomes = await Promise.all([raced.confirm(), raced.confirm()]);
    expect(outcomes.filter((outcome) => outcome.status === "sent")).toHaveLength(1);
    expect(raced.service.resolveDecision).toHaveBeenCalledTimes(1);
    expect(raced.dispatches()).toBe(1);
  });
});
