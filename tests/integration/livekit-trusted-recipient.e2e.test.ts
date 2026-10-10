/**
 * Task 4.8 — the LiveKit session E2E (design §12.2, "LiveKit session E2E").
 *
 * WHAT IS REAL AND WHAT IS FAKE
 * -----------------------------
 * The listener under test is the REAL one: `attachVoiceDecisionTranscripts`
 * registers its handler on the session's `user_input_transcribed` event, and
 * this suite drives it through a fake transport that emits exactly that event.
 * The listener's own early return (`gate.currentPreviewId()` ⇒ drop) is the
 * behaviour the pre-proposal case depends on, so it is never re-implemented.
 *
 * What is fake is the provider transport only:
 *  - `FakeAgentSession` stands in for a live `AgentSession` (no LiveKit room
 *    provider is reachable in this environment);
 *  - the card delivery (`publishData`) is a fake, as task 4.6's suite already
 *    establishes for that seam.
 *
 * Everything the window actually turns on is real: the real
 * `createVoiceDecisionGate`, the real `createConfirmationArbiter` (with its
 * inherited 2 000 ms bound), the real `createVoiceContactActions` seam, the
 * real `contact_action_proposals` rows, and the real HTTP address endpoint that
 * creates the new immutable version.
 *
 * Every negative assertion is preceded by a positive control in the SAME test,
 * so an `undefined`/refusal can never be a false green caused by an absent
 * module, a missing row or an unwired fixture.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer } from "../fixtures/test-server.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { attachVoiceDecisionTranscripts } from "../../src/livekit/voice-decision-transcripts.js";
import { createVoiceDecisionGate } from "../../src/livekit/voice-decision-gate.js";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../src/livekit/resolution-phrases.js";
import {
  CONTACT_PROPOSAL_TOPIC,
  createVoiceContactActions,
} from "../../src/livekit/contact-proposal-publication.js";
import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** `AgentSessionEventTypes.UserInputTranscribed` (the string LiveKit emits). */
const USER_INPUT_TRANSCRIBED = "user_input_transcribed";

/** A canonical Solana public key. */
const PASTED_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type TranscriptEvent = {
  transcript: string;
  isFinal: boolean;
  speakerId: string | null;
  createdAt: number;
};

/** A fake provider session: only the event surface the real listener uses. */
class FakeAgentSession {
  private readonly listeners = new Set<(event: TranscriptEvent) => void>();

  public on(event: string, listener: (event: TranscriptEvent) => void): void {
    expect(event).toBe(USER_INPUT_TRANSCRIBED);
    this.listeners.add(listener);
  }

  public off(event: string, listener: (event: TranscriptEvent) => void): void {
    expect(event).toBe(USER_INPUT_TRANSCRIBED);
    this.listeners.delete(listener);
  }

  /** Deliver one real `user_input_transcribed` event as the provider would. */
  public emit(event: TranscriptEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * The transfer rig: real listener + real gate + real arbiter, fake transport.
 * `boundedWaitMs` is 0 so a refusal is observed without waiting; the delay case
 * deliberately uses the gate's own inherited 2 000 ms default instead.
 */
function transferRig(options: { userId?: string; conversationId?: string } = {}) {
  const session = new FakeAgentSession();
  const userId = options.userId ?? randomUUID();
  const conversationId = options.conversationId ?? randomUUID();
  const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
  const gate = createVoiceDecisionGate({
    isConfirmation,
    isCancellation,
    arbiter,
    userId,
    conversationId,
  });
  const detach = attachVoiceDecisionTranscripts(
    session as never,
    gate,
    (speakerId) => speakerId !== null && speakerId === "participant-1",
  );
  return { session, gate, arbiter, detach, userId, conversationId };
}

suite("LiveKit trusted-recipient session E2E (task 4.8)", () => {
  let database: DatabaseClient;
  const userIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.query(
        "DELETE FROM contact_action_proposals WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await database.close();
  });

  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:cle-${randomUUID()}`, "LiveKit Session E2E"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  async function rows(userId: string, conversationId: string) {
    const result = await database.query<{
      id: string;
      version: number;
      status: string;
      address: string | null;
      published_at: Date | null;
    }>(
      `SELECT id, version, status, address, published_at
         FROM contact_action_proposals
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY version ASC, created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return result.rows;
  }

  /** The contact seam exactly as the worker wires it (design §8.1/§8.2). */
  function contactPort(input: {
    actions: ContactActionService;
    arbiter: ReturnType<typeof createConfirmationArbiter>;
    boundParticipantIdentity?: string;
    publish?: (payload: {
      bytes: Uint8Array;
      reliable: true;
      topic: string;
      destinationIdentities: string[];
    }) => Promise<void>;
  }) {
    const delivered: Array<{ topic: string; destinationIdentities: string[]; reliable: boolean }> = [];
    const port = createVoiceContactActions({
      actions: input.actions,
      supersedeUnpublished: (cleanup) =>
        input.actions.supersedeUnpublished(cleanup.userId, cleanup.conversationId),
      ...(input.boundParticipantIdentity !== undefined
        ? { boundParticipantIdentity: input.boundParticipantIdentity }
        : {}),
      publish: async (payload) => {
        delivered.push({
          topic: payload.topic,
          destinationIdentities: payload.destinationIdentities,
          reliable: payload.reliable,
        });
        if (input.publish) return input.publish(payload);
        return undefined;
      },
      arbiter: input.arbiter,
      consume: async (consumeInput) => {
        let consumed = false;
        await database.withUserTransaction(consumeInput.userId, async (client) => {
          consumed =
            (await input.actions.consumeInTransaction(client, {
              userId: consumeInput.userId,
              proposalId: consumeInput.proposalId,
              proposalVersion: consumeInput.proposalVersion,
              consumedByTool: "confirm_trusted_recipient_action",
              consumedBySession: consumeInput.conversationId,
            })) !== null;
        });
        return consumed;
      },
    });
    return { port, delivered };
  }

  // -------------------------------------------------------------------------
  // The real listener, driven through the fake transport
  // -------------------------------------------------------------------------

  it("succeeds on an authenticated final affirmative delivered after the window opened", async () => {
    const { session, gate, detach } = transferRig();
    expect(session.listenerCount()).toBe(1);
    expect(gate.prepare("preview-1", 1_000)).toBe(true);
    session.emit({
      transcript: "sí, confirmá la transferencia",
      isFinal: true,
      speakerId: "participant-1",
      createdAt: 1_100,
    });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
    detach();
    expect(session.listenerCount()).toBe(0);
  });

  it("fails closed for a foreign speaker, and the same words succeed for the bound one", async () => {
    const { session, gate } = transferRig();
    gate.prepare("preview-1", 1_000);

    // The negative half first: identical wording and timestamp, foreign speaker.
    session.emit({
      transcript: "sí",
      isFinal: true,
      speakerId: "uninvited-guest",
      createdAt: 1_100,
    });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();

    // Positive control: same text, same time, only the speaker differs.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
  });

  it("fails closed with no speech, and the same call completes once speech arrives", async () => {
    const { session, gate } = transferRig();
    gate.prepare("preview-1", 1_000);
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();
    session.emit({
      transcript: "dale, confirmá",
      isFinal: true,
      speakerId: "participant-1",
      createdAt: 1_100,
    });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
  });

  it("drops an affirmative spoken before the preview existed, and accepts the next one", async () => {
    const { session, gate } = transferRig();

    // Spoken before any preview: the real listener has no window to record it
    // against (`gate.currentPreviewId()` is undefined), so it drops it there.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 900 });
    gate.prepare("preview-1", 1_000);
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();

    // Positive control: an affirmative after the preview does authorize.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
  });

  it("refuses an expired affirmative as evidence_expired, and accepts a current one", async () => {
    const { session, gate, arbiter, userId, conversationId } = transferRig();
    gate.prepare("preview-1", 1_000);

    // Delivered late, but spoken BEFORE the window: it answered an earlier
    // question. The gate's own ordering rule drops it (this is the seam where
    // the session's real listener lands), so nothing is armed.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 999 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();

    // The typed code for that same out-of-window speech, fed to the arbiter
    // directly (the gate only forwards EVIDENCE, never the stale marker, so
    // this is the component that names the refusal).
    arbiter.recordEvidence({
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: 999,
      userId,
      conversationId,
    });
    expect(
      arbiter.consume({
        kind: "transfer",
        actionId: "preview-1",
        userId,
        version: 0,
        tool: "confirm_transfer",
        decision: "confirm",
      }),
    ).toEqual({ status: "refused", code: "evidence_expired" });

    // Positive control: the same event ordered after the window does authorize.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_001 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
  });

  it("completes the same call when the final transcript is delayed inside the inherited 2 s bound", async () => {
    const { session, gate } = transferRig();
    gate.prepare("preview-1", Date.now());

    // The gate's own default bound (2 000 ms) — the inherited one, not a
    // test-tuned value. The transcript arrives ~40 ms late.
    const pending = gate.waitAndConsume("preview-1", "confirm");
    setTimeout(() => {
      session.emit({
        transcript: "sí, confirmá",
        isFinal: true,
        speakerId: "participant-1",
        createdAt: Date.now() + 1,
      });
    }, 40);
    expect(await pending).toBe("confirmed");
  });

  it("refuses a replay of the same affirmative after the window was consumed", async () => {
    const { session, gate } = transferRig();
    gate.prepare("preview-1", 1_000);
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");

    // Positive control is the success above; the replay must not authorize.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_200 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("never re-arms a consumed action id even when the same preview is prepared again", async () => {
    const { session, gate } = transferRig();
    gate.prepare("preview-1", 1_000);
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");

    expect(gate.prepare("preview-1", 2_000)).toBe(true);
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 2_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBeUndefined();

    // Positive control: a DIFFERENT action id does open and consume.
    expect(gate.prepare("preview-2", 2_000)).toBe(true);
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 2_100 });
    expect(await gate.waitAndConsume("preview-2", "confirm", 0)).toBe("confirmed");
  });

  // -------------------------------------------------------------------------
  // Contact / transfer collisions, both opening orders
  // -------------------------------------------------------------------------

  it("refuses a contact window while a transfer window is open (transfer first)", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const { session, gate, arbiter } = transferRig({ userId, conversationId });
    const actions = new ContactActionService(database);
    const { port } = contactPort({ actions, arbiter, boundParticipantIdentity: "participant-1" });

    expect(gate.prepare("preview-1", 1_000)).toBe(true);
    const refused = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(refused.status).toBe("conflict_active_window");

    // Positive control: consuming the transfer window frees the slot.
    session.emit({ transcript: "sí", isFinal: true, speakerId: "participant-1", createdAt: 1_100 });
    expect(await gate.waitAndConsume("preview-1", "confirm", 0)).toBe("confirmed");
    const accepted = await port.stage({
      userId,
      conversationId: randomUUID(),
      origin: "voice",
      action: "create",
      name: "Ana",
    });
    expect(accepted.status).toBe("staged");
  });

  it("refuses a transfer window while a contact window is open (contact first)", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const { gate, arbiter } = transferRig({ userId, conversationId });
    const actions = new ContactActionService(database);
    const { port } = contactPort({ actions, arbiter, boundParticipantIdentity: "participant-1" });

    const staged = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(staged.status).toBe("staged");

    // The contact window is open (positive control above); the transfer must
    // fail closed against it instead of preempting it.
    expect(gate.prepare("preview-1", 2_000)).toBe(false);
    expect(arbiter.current()?.kind).toBe("contact");

    // Positive control: once that window is closed, a transfer window opens.
    arbiter.clear(staged.proposalId!);
    expect(gate.prepare("preview-1", 2_000)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Publication gates the window; the address comes from the review channel
  // -------------------------------------------------------------------------

  it("refuses permission creation when no bound participant can receive the card", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
    const actions = new ContactActionService(database);
    const { port, delivered } = contactPort({ actions, arbiter });

    const refused = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(refused.status).toBe("address_review_required");
    expect(delivered).toHaveLength(0);
    expect(arbiter.current()).toBeUndefined();
    expect(await rows(userId, conversationId)).toHaveLength(0);

    // Positive control: with a bound participant the SAME call stages.
    const { port: bound } = contactPort({
      actions,
      arbiter,
      boundParticipantIdentity: "participant-1",
    });
    expect(
      (
        await bound.stage({
          userId,
          conversationId,
          origin: "voice",
          action: "create",
          name: "Sofía",
        })
      ).status,
    ).toBe("staged");
  });

  it("leaves the window closed when the card could not be published", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
    const actions = new ContactActionService(database);

    // Publication rejects: the row stays unpublished and no window opens.
    const { port, delivered } = contactPort({
      actions,
      arbiter,
      boundParticipantIdentity: "participant-1",
      publish: async () => {
        throw new Error("transport down");
      },
    });
    const refused = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(refused.status).toBe("proposal_not_published");
    expect(delivered).toHaveLength(1);
    expect(arbiter.current()).toBeUndefined();

    const unpublished = await rows(userId, conversationId);
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0]!.published_at).toBeNull();

    // No window exists, so an affirmative cannot consume: the refusal is the
    // missing window, not a missing argument.
    const early = await port.confirm!({
      userId,
      conversationId,
      proposalId: unpublished[0]!.id,
      proposalVersion: 1,
      source: "voice",
    });
    expect(early.status).toBe("confirmation_required");

    // Positive control: a delivered card DOES open the window, and only then is
    // published_at set — publication evidence, never proof of reading.
    const { port: working, delivered: sent } = contactPort({
      actions,
      arbiter,
      boundParticipantIdentity: "participant-1",
    });
    const staged = await working.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Ana",
    });
    expect(staged.status).toBe("staged");
    expect(sent).toEqual([
      { topic: CONTACT_PROPOSAL_TOPIC, destinationIdentities: ["participant-1"], reliable: true },
    ]);
    expect(arbiter.current()?.actionId).toBe(staged.proposalId);
    const published = await rows(userId, conversationId);
    expect(published.find((row) => row.id === staged.proposalId)!.published_at).not.toBeNull();
  });

  it("never derives an address from a spoken name, and a paste creates the new version", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
    const actions = new ContactActionService(database);
    const { port } = contactPort({ actions, arbiter, boundParticipantIdentity: "participant-1" });

    // A spoken-only address: even when the caller passes one along, the seam has
    // no such input and nothing reaches the row.
    const staged = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
      ...({ address: PASTED_ADDRESS } as unknown as Record<string, never>),
    });
    expect(staged.status).toBe("staged");
    expect(await rows(userId, conversationId)).toEqual([
      expect.objectContaining({ version: 1, status: "open", address: null }),
    ]);

    // The review channel supplies the address through the real HTTP endpoint.
    const app = buildTestServer({ userId });
    const pasted = await app.inject({
      method: "POST",
      url: `/v1/contact-actions/${staged.proposalId}/address`,
      payload: { address: PASTED_ADDRESS, expectedProposalVersion: 1 },
    });
    expect(pasted.statusCode).toBe(200);
    expect(pasted.json().data).toMatchObject({ proposalVersion: 2, address: PASTED_ADDRESS });
    expect(pasted.json().data.proposalId).not.toBe(staged.proposalId);
    await app.close();

    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status, row.address])).toEqual([
      [1, "superseded", null],
      [2, "open", PASTED_ADDRESS],
    ]);

    // A spoken affirmative for the SUPERSEDED version cannot consume anything,
    // even with an armed window still pointing at the old proposal id.
    arbiter.recordEvidence({
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: Date.now() + 1_000,
      userId,
      conversationId,
    });
    const stale = await port.confirm!({
      userId,
      conversationId,
      proposalId: staged.proposalId!,
      proposalVersion: 1,
      source: "voice",
    });
    expect(stale.status).toBe("confirmation_required");

    // The superseded window stayed consumed-but-open (see the handoff note at
    // the foot of this file); close it so the next proposal can be reviewed.
    arbiter.clear(staged.proposalId!);

    // Positive control: the new version's window consumes on the same evidence.
    const freshConversationId = randomUUID();
    const fresh = await port.stage({
      userId,
      conversationId: freshConversationId,
      origin: "voice",
      action: "create",
      name: "Ana",
    });
    expect(fresh.status).toBe("staged");
    arbiter.recordEvidence({
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: Date.now() + 1_000,
      userId,
      conversationId: freshConversationId,
    });
    const confirmed = await port.confirm!({
      userId,
      conversationId: freshConversationId,
      proposalId: fresh.proposalId!,
      proposalVersion: fresh.proposalVersion!,
      source: "voice",
    });
    expect(confirmed.status).toBe("consumed");
  });
});
