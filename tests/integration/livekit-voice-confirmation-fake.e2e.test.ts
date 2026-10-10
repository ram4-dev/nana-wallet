import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeTools } from "../../src/livekit/realtime-tools/create-realtime-tools.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import { createVoiceDecisionGate } from "../../src/livekit/voice-decision-gate.js";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function harness(options: {
  interrupted?: boolean;
  earlyConfirmation?: boolean;
  /** Simulates the provider refusing the confirmed transfer (a policy refusal). */
  refusal?: { code: string; message: string };
  /** Simulates the provider refusing at PREVIEW time, before any read-back. */
  previewRefusal?: { code: string; message: string };
} = {}) {
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
    previewTransfer: vi.fn(async () => {
      if (options.previewRefusal) {
        return {
        status: "error" as const,
        code: options.previewRefusal.code,
        message: options.previewRefusal.message,
        };
      }
      return {
        status: "confirmation_required" as const,
        message: "Preparé la transferencia.",
        preview: {
        network: "solana-devnet",
        token: "SOL",
        recipient: RECIPIENT,
        amount: "0.01",
        estimatedFee: "0.000005 SOL",
        },
      };
    }),
      resolveDecision: vi.fn(async function* (input: { decision: "confirm" | "cancel" }) {
        if (input.decision === "confirm") {
          // A provider refusal resolved AFTER the user said yes: the preview was
          // narrated and authorized, and the money did not move.
          if (options.refusal) {
            yield {
              type: "turn-completed" as const,
              result: {
                status: "error" as const,
                code: options.refusal.code,
                message: options.refusal.message,
              },
            };
            return;
          }
          dispatches += 1;
        }
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

  // The case authority exists for: the user HEARD the read-back and said yes,
  // and then the provider refused. What they are told decides whether they retry
  // something that can never succeed.
  it("narrates a policy refusal after a spoken yes as a refusal, never as a wallet outage", async () => {
    const refusal = "La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.";
    const worker = harness({
      refusal: { code: "policy_rejected", message: refusal },
    });
    await worker.send();
    worker.speakDecision("sí");

    const result = await worker.confirm();

    expect(result).toMatchObject({ status: "error", code: "policy_rejected" });
    expect(result.message).toBe(refusal);
    // A refusal is permanent. Telling the user the wallet is temporarily
    // unavailable would invite exactly the retry that cannot work.
    expect(result.message).not.toMatch(/temporal|temporarily|no est[aá] disponible|unavailable|prob[aá] de nuevo|try again/iu);
    expect(worker.dispatches()).toBe(0);
    expect(worker.service.resolveDecision).toHaveBeenCalledTimes(1);
  });

  it("separates a policy refusal from a temporary outage in what it narrates", async () => {
    const outage = harness({
      refusal: {
        code: "wallet_unavailable",
        message: "La billetera no está disponible en este momento. Probá de nuevo en un rato.",
      },
    });
    await outage.send();
    outage.speakDecision("sí");
    const outageResult = await outage.confirm();

    // The outage IS retryable, so its copy invites one. The two must never be
    // interchangeable: collapsing them is the defect this distinction exists for.
    expect(outageResult.code).toBe("wallet_unavailable");
    expect(outageResult.message).toMatch(/prob[aá] de nuevo|en un rato/iu);
    expect(outage.dispatches()).toBe(0);
  });

  // The over-cap case the voice eval scores (`g4-policy-rejected`): the refusal
  // lands at PREVIEW time, so no read-back is ever narrated and there is nothing
  // for the user to authorize. The refusal must be spoken, not swallowed.
  it("narrates a preview-time refusal and never arms a confirmation", async () => {
    const refusal = "La transferencia no se realizó: no cumple con las reglas de seguridad de la billetera, y repetirla no va a cambiar nada.";
    const worker = harness({
      previewRefusal: { code: "policy_rejected", message: refusal },
    });

    const preview = await worker.send();

    expect(preview).toMatchObject({ status: "error", code: "policy_rejected" });
    expect(preview.message).toBe(refusal);
    // No read-back was spoken, so the decision gate must never have been armed:
    // a spoken "si" with nothing to authorize must stay unauthorized.
    expect(worker.spoken).toHaveLength(0);
    worker.speakDecision("sí");
    expect(await worker.confirm()).toMatchObject({ status: "error", code: "confirmation_required" });
    expect(worker.service.resolveDecision).not.toHaveBeenCalled();
    expect(worker.dispatches()).toBe(0);
  });
});
