import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";

import type { DatabaseClient } from "../db/client.js";
import {
  CONTACT_PROPOSAL_TOPIC,
  type ContactProposalPublication,
} from "./contact-proposal-publication.js";

/**
 * Re-publication of a corrected review card (design §8.3).
 *
 * The HTTP review channel runs in the backend process, but the address change it
 * performs must end up as a delivered card, because publication is what gates the
 * voice window (§8.2). This is that seam: the same reliable data packet the voice
 * worker sends in-process, issued here through `RoomServiceClient.sendData`.
 *
 * Two rules are enforced structurally:
 *
 * 1. **The card goes to the bound participant and to nobody else.** §8.1 is
 *    explicit that a card never goes to the room at large, so there is no
 *    room-wide fallback: when the conversation has no live bound identity (the
 *    lease expired, no bound visual client), the publisher reports `false` and
 *    the caller must not stamp `published_at`.
 * 2. **Failure is a `false`, never a throw.** A delivery that throws and a
 *    delivery that is refused produce the same outcome upstream — no window —
 *    so the caller has one branch to reason about, and a transport error can
 *    never be mistaken for a delivered card.
 */
export type ContactCardSendData = (
  room: string,
  bytes: Uint8Array,
  options: { topic: string; destinationIdentities: string[] },
) => Promise<void>;

export type ContactCardPublisher = (
  card: ContactProposalPublication,
) => Promise<boolean>;

export function createContactCardPublisher(input: {
  sendData: ContactCardSendData;
  /** The bound authenticated participant of a conversation, or `null`. */
  readBoundIdentity: (conversationId: string) => Promise<string | null>;
}): ContactCardPublisher {
  return async (card) => {
    const identity = await input.readBoundIdentity(card.conversationId);
    if (!identity) return false;
    try {
      await input.sendData(
        `nani-${card.conversationId}`,
        new TextEncoder().encode(JSON.stringify(card)),
        { topic: CONTACT_PROPOSAL_TOPIC, destinationIdentities: [identity] },
      );
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Wires the publisher from the environment. Returns `undefined` when LiveKit is
 * not configured, which leaves the new version unstamped and therefore
 * unconsumable — the honest outcome, not a fabricated delivery.
 */
export function createOptionalContactCardPublisher(
  environment: NodeJS.ProcessEnv = process.env,
  database?: DatabaseClient,
): ContactCardPublisher | undefined {
  const url = environment.LIVEKIT_URL?.trim();
  const apiKey = environment.LIVEKIT_API_KEY?.trim();
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret || !database) return undefined;

  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const client = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  return createContactCardPublisher({
    sendData: (room, bytes, options) =>
      client
        .sendData(room, bytes, DataPacket_Kind.RELIABLE, options)
        .then(() => undefined),
    readBoundIdentity: async (conversationId) => {
      // The bound participant is the one `acquireLiveLease` recorded for the
      // conversation; an expired lease is not a bound client.
      const result = await database.query<{ participant_identity: string }>(
        `SELECT participant_identity FROM conversation_live_leases
          WHERE conversation_id = $1 AND expires_at > now()`,
        [conversationId],
      );
      return result.rows[0]?.participant_identity ?? null;
    },
  });
}
