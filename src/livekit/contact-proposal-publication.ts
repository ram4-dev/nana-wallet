import type { ContactActionPort } from "../agent/definition.js";
import type {
  ContactActionProposal,
  ContactActionService,
} from "../wallet/policy/contact-actions.js";
import type { ConfirmationArbiter } from "../conversations/confirmation-arbiter.js";

/**
 * The reliable card publication seam (design §8.1/§8.2).
 *
 * This module owns exactly one rule, and it is the reason the voice contact flow
 * is safe: **publication success gates the window**. The proposal is persisted
 * first, the card is delivered reliably to the bound authenticated participant,
 * the delivery is awaited, and only then is `published_at` stamped. Only when
 * BOTH succeed does the arbiter window open. An affirmative that arrives before
 * that has no window to be recorded against, so it is dropped rather than
 * buffered.
 *
 * `published_at` is publication evidence, NOT proof that anyone read the card.
 * Nothing here — and nothing downstream — may claim more: a published proposal
 * still authorizes nothing until the arbiter window opens, and the window still
 * consumes nothing until the persisted one-use UPDATE returns the row.
 *
 * The card never goes to the room at large: `destinationIdentities` is exactly
 * the bound participant resolved through `verifyLiveVoiceBinding` /
 * `RoomConversation.bind` (which already rejects an identity that differs from
 * `binding.sub`).
 */
export type ContactProposalPublication = {
  type: "contact_action_proposal";
  proposalId: string;
  proposalVersion: number;
  conversationId: string;
  action: ContactActionProposal["action"];
  contactId: string | null;
  contactVersion: number | null;
  /** The persisted address, or `null` while the review channel has not supplied one. */
  address: string | null;
  previousAddress: string | null;
  revokedGrantIds: string[];
  summary: string;
  revocationDisclosure: string | null;
  expiresAt: string;
};

export const CONTACT_PROPOSAL_TOPIC = "contact_action_proposal";

/** The card bytes for a proposal. Pure, so the payload is assertable. */
export function contactProposalCard(proposal: ContactActionProposal, summary: string, revocationDisclosure: string | null = null): ContactProposalPublication {
  return {
    type: "contact_action_proposal",
    proposalId: proposal.proposalId,
    proposalVersion: proposal.proposalVersion,
    conversationId: proposal.conversationId,
    action: proposal.action,
    contactId: proposal.contactId,
    contactVersion: proposal.contactVersion,
    address: proposal.address,
    previousAddress: proposal.previousAddress,
    revokedGrantIds: proposal.revokedGrantIds,
    summary,
    revocationDisclosure,
    expiresAt: proposal.expiresAt,
  };
}

/** Server-owned summary: composed from the action and the display label only. */
export function contactProposalSummary(action: ContactActionProposal["action"], label: string | undefined): string {
  const who = label?.trim() && label.trim().length > 0 ? label.trim() : "este destinatario";
  if (action === "remove") return `Quitar a ${who} de tus destinatarios de confianza`;
  if (action === "edit") return `Editar a ${who} en tus destinatarios de confianza`;
  return `Agregar a ${who} como destinatario de confianza`;
}

/** The review-channel request used when no bound visual client can receive the card. */
export const REVIEW_CHANNEL_MESSAGE =
  "Para habilitar este destinatario necesito que revises la tarjeta en la pantalla y pegues la dirección. No puedo habilitarlo solo por voz.";

export type VoiceContactActionDependencies = {
  actions: Pick<ContactActionService, "stage" | "markPublished" | "read" | "consumeInTransaction">;
  /**
   * Frees a conversation whose earlier proposal was never published (design
   * §8.2). Optional so a caller that owns no cleanup keeps the collision
   * behaviour it had; when present, the retry supersedes the orphan instead of
   * colliding with the one-open-per-conversation index. The predicate lives in
   * the service (`published_at IS NULL`), so this seam cannot supersede a row
   * whose card was actually delivered.
   */
  supersedeUnpublished?: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<number>;
  /**
   * The bound authenticated participant's identity, resolved by the worker from
   * `verifyLiveVoiceBinding` / `RoomConversation.bind`. Absent ⇒ there is no bound
   * visual client to review the card on.
   */
  boundParticipantIdentity?: string;
  /** Reliable delivery seam. The worker passes the agent participant's `publishData`. */
  publish: (payload: {
    bytes: Uint8Array;
    reliable: true;
    topic: string;
    destinationIdentities: string[];
  }) => Promise<void>;
  /** The in-process window. Absent ⇒ no window ever opens and nothing is consumed. */
  arbiter?: ConfirmationArbiter;
  /**
   * The persisted one-use consume, executed inside the caller's mutation
   * transaction (design §7.2 `L5` slot). Returns `false` on zero rows.
   */
  consume: (input: {
    userId: string;
    conversationId: string;
    proposalId: string;
    proposalVersion: number;
  }) => Promise<boolean>;
};

/**
 * Builds the voice surface's `ContactActionPort`. Nothing here mutates a contact:
 * `RecipientPolicyService` remains the only contact/policy writer.
 */
export function createVoiceContactActions(dependencies: VoiceContactActionDependencies): ContactActionPort {
  return {
    async stage(input) {
      if (!dependencies.boundParticipantIdentity) {
        // No bound visual client: refuse permission creation and ask for the
        // review channel. The contact may still be saved as not enabled.
        return { status: "address_review_required", message: REVIEW_CHANNEL_MESSAGE };
      }
      // A previous attempt for THIS conversation that never got its card
      // delivered is not a window (§8.2): supersede it first, so the retry
      // creates a fresh version instead of breaking the one-open index.
      await dependencies.supersedeUnpublished?.({
        userId: input.userId,
        conversationId: input.conversationId,
      });

      const proposal = await dependencies.actions.stage({
        userId: input.userId,
        conversationId: input.conversationId,
        origin: "voice",
        action: input.action,
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });

      const card = contactProposalCard(proposal, contactProposalSummary(proposal.action, input.name));
      try {
        await dependencies.publish({
          bytes: new TextEncoder().encode(JSON.stringify(card)),
          reliable: true,
          topic: CONTACT_PROPOSAL_TOPIC,
          destinationIdentities: [dependencies.boundParticipantIdentity],
        });
      } catch {
        // Publication failed (participant gone, transport error): the row stays
        // unpublished, no window opens, and nothing is re-published.
        return { status: "proposal_not_published", message: "No pude mostrar la tarjeta de revisión; no voy a habilitar este destinatario todavía." };
      }

      const published = await dependencies.actions.markPublished(input.userId, proposal.proposalId, proposal.proposalVersion);
      if (!published) {
        // Zero rows: the proposal was superseded, consumed or expired between the
        // write and the stamp. The window must not open for a card the user is not
        // reviewing any more.
        return { status: "proposal_not_published", message: "No pude mostrar la tarjeta de revisión; no voy a habilitar este destinatario todavía." };
      }

      const opened = dependencies.arbiter?.open({
        kind: "contact",
        actionId: published.proposalId,
        userId: input.userId,
        conversationId: published.conversationId,
        version: published.proposalVersion,
        createdAt: Date.now(),
      });
      if (opened && opened.status === "conflict") {
        return { status: "conflict_active_window", message: "Ya hay una acción esperando tu confirmación. Cancelala o confirmala antes de continuar." };
      }
      return {
        status: "staged",
        proposalId: published.proposalId,
        proposalVersion: published.proposalVersion,
        message: "Revisá la dirección en la tarjeta y confirmá cuando esté lista.",
      };
    },

    async confirm(input) {
      const window = dependencies.arbiter?.current();
      if (!dependencies.arbiter || !window) return { status: "confirmation_required", message: "No hay ninguna tarjeta esperando confirmación." };
      const decision = await dependencies.arbiter.waitAndConsume({
        kind: "contact",
        actionId: input.proposalId,
        userId: input.userId,
        version: input.proposalVersion,
        tool: "confirm_trusted_recipient_action",
      });
      if (decision.status !== "consumed") return { status: "confirmation_required", message: "Todavía no tengo tu confirmación para esta tarjeta." };
      const consumed = await dependencies.consume({
        userId: input.userId,
        conversationId: input.conversationId,
        proposalId: input.proposalId,
        proposalVersion: input.proposalVersion,
      });
      if (!consumed) return { status: "confirmation_required", message: "Esta propuesta ya no está disponible; generá una nueva." };
      dependencies.arbiter.clear(input.proposalId);
      return { status: "consumed", message: "Listo, ya registré tu confirmación." };
    },
  };
}
