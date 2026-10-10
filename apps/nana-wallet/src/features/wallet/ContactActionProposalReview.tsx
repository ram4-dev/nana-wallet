import { useEffect, useState } from "react";

import { subscribeToContactActionProposals } from "@/lib/contact-action-topic";
import type { ContactActionProposalNotification } from "@/lib/api-types";

import { ContactActionProposalCard } from "./ContactActionProposalCard";

/**
 * The conversation surface that hosts the review card (task 4.7 review channel).
 *
 * WHY THIS COMPONENT EXISTS
 * -------------------------
 * The card was tested but mounted nowhere, so the production build tree-shook it
 * out and the review channel the backend publishes to could never render. The
 * LiveKit packet was already routed into the topic bus; nothing was listening.
 * This is the listener: it lives on the live conversation screen, so the surface
 * exists in the deployed bundle.
 *
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
 * ---------------------------------------------
 * The packet is a wakeup and nothing else (design §8.1/§8.3): this component keys
 * on `proposalId` and hands the card an id. It never reads `address`,
 * `summary`, `expiresAt` or `proposalVersion` out of the payload, so a packet can
 * never put a value on screen that the server did not persist — the card re-reads
 * the row through `GET /v1/contact-actions/:proposalId` (§8.4) and renders that.
 *
 * A card is rendered only for the authenticated participant's OWN bound
 * conversation. The publication already targets exactly the participant identity
 * resolved by `verifyLiveVoiceBinding` (design §8.1), and this is the second half
 * of the same rule on the client: a packet from another conversation is dropped,
 * and without a resolved identity there is no review surface at all.
 *
 * The newest announcement wins. A second action in the same conversation is a new
 * immutable proposal, so following it is what keeps the user from being stuck on a
 * superseded row; a newer version of the SAME proposal is the card's own concern
 * (it re-reads the row when the announced version is greater).
 */
export type ContactActionProposalReviewProps = {
  /** The conversation this browser is bound to; `null` before binding. */
  conversationId: string | null;
  /** The authenticated identity. No identity, no review surface. */
  userId?: string | null;
  /** Injected in tests. Defaults to the dedicated LiveKit card topic. */
  subscribe?: (listener: (notification: ContactActionProposalNotification) => void) => () => void;
};

export function ContactActionProposalReview({
  conversationId,
  userId,
  subscribe = subscribeToContactActionProposals,
}: ContactActionProposalReviewProps) {
  const [proposalId, setProposalId] = useState<string | null>(null);

  useEffect(() => {
    // Not bound yet: nothing may be accepted, because "bound" is the only thing
    // that makes a packet ours.
    if (!conversationId) return;
    return subscribe((notification) => {
      if (notification.conversationId !== conversationId) return;
      setProposalId(notification.proposalId);
    });
  }, [conversationId, subscribe]);

  // A review already on screen is NOT torn down when the voice session ends: the
  // proposal row outlives the session and the paste path is plain HTTP, so the
  // user can still finish what they were reviewing.
  if (!proposalId || !userId) return null;

  return <ContactActionProposalCard proposalId={proposalId} userId={userId} />;
}
