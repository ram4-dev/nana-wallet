import type { ContactActionProposalNotification } from "@/lib/api-types";

/**
 * The review card's dedicated topic (design §8.1/§8.4).
 *
 * LiveKit carries only a wakeup on this topic — never the values the card
 * displays. The backend publishes `contactProposalCard(...)` on
 * `topic: "contact_action_proposal"` to the bound authenticated participant;
 * `livekit-web-client.ts` routes that packet into this bus, and the card answers
 * it by re-reading the canonical row through `GET /v1/contact-actions/:id`.
 *
 * That indirection is the whole point: a card cannot be made to display a value
 * that the server did not persist, so a stale revision of the UI can never show
 * an address the policy never received.
 *
 * The bus therefore carries the packet exactly as the backend sent it — which for
 * a real card is the FULL payload, address included — and no consumer may read a
 * value out of it. The guard below only requires the wakeup identity, because
 * that is all anything downstream is allowed to key on: the card re-reads the
 * canonical row and renders that.
 */
export const CONTACT_ACTION_PROPOSAL_TOPIC = "contact_action_proposal";

type Listener = (notification: ContactActionProposalNotification) => void;

const listeners = new Set<Listener>();

/** Delivers a wakeup to every mounted card. Returns whether the payload carried the wakeup identity. */
export function publishContactActionProposal(payload: unknown): boolean {
  if (!isContactActionProposalNotification(payload)) return false;
  for (const listener of [...listeners]) listener(payload);
  return true;
}

export function subscribeToContactActionProposals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isContactActionProposalNotification(
  value: unknown,
): value is ContactActionProposalNotification {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["type"] === "contact_action_proposal" &&
    typeof candidate["proposalId"] === "string" &&
    candidate["proposalId"].length > 0 &&
    typeof candidate["proposalVersion"] === "number" &&
    Number.isInteger(candidate["proposalVersion"])
  );
}
