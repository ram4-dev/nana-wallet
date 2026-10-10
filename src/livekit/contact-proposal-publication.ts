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
  /**
   * The persisted authority for WHICH proposal is open right now: the same row
   * the card renders (`status='open'`, published, unexpired, owner + conversation
   * bound). The worker wires it from `ContactActionService.readOpen`.
   *
   * It exists because the review channel runs over HTTP in ANOTHER process: after
   * a paste creates a new immutable version, the worker's in-memory window still
   * points at the version the agent staged, and nothing in the session can learn
   * the new one by itself. This is the server-owned source of that fact, and it is
   * used for exactly two things: reporting the current handle on a refusal, and
   * aligning the in-process window to the row the card actually shows.
   *
   * Optional so a caller that owns neither (a text-only wiring) keeps the
   * fail-closed behaviour: without it the in-process window is the only authority
   * and a refusal offers no handle.
   */
  currentOpenProposal?: (input: {
    userId: string;
    conversationId: string;
  }) => Promise<{ proposalId: string; proposalVersion: number } | null>;
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
      const arbiter = dependencies.arbiter;
      // The window the arbiter holds right now. A window of ANOTHER kind is never
      // preempted (spec: a collision fails closed in both opening orders), so a
      // contact confirmation cannot use a transfer window's evidence or slot.
      const window = arbiter?.current();
      if (window && window.kind !== "contact") {
        return {
          status: "conflict_active_window",
          message: "Ya hay otra acción esperando tu confirmación. Cancelala o confirmala antes de continuar.",
        };
      }

      // Which proposal is open is a server-owned fact, read from the persisted row.
      // Without that lookup the in-process window is the only authority.
      const current = dependencies.currentOpenProposal
        ? await dependencies.currentOpenProposal({
            userId: input.userId,
            conversationId: input.conversationId,
          })
        : window
          ? { proposalId: window.actionId, proposalVersion: window.version }
          : null;

      const matchesCurrent =
        current !== null &&
        current.proposalId === input.proposalId &&
        current.proposalVersion === input.proposalVersion;
      if (!matchesCurrent) {
        // STALE FAILS CLOSED. A proposal that is not the current open one is never
        // consumed — not even when its own window is still armed — and nothing is
        // auto-confirmed in its place. The refusal carries the handle that IS
        // open, so the next turn can confirm the right one instead of repeating a
        // superseded id forever; with nothing open it says so and offers none.
        return current
          ? {
              status: "confirmation_required",
              message: `Esta propuesta cambió: la abierta es la versión ${current.proposalVersion} (${current.proposalId}). Confirmá esa.`,
              currentProposalId: current.proposalId,
              currentProposalVersion: current.proposalVersion,
            }
          : {
              status: "confirmation_required",
              message: "Esta propuesta ya no está disponible y no hay ninguna otra abierta para esta conversación; generá una nueva.",
            };
      }

      if (!arbiter) {
        return { status: "confirmation_required", message: "No hay ninguna tarjeta esperando confirmación." };
      }

      // The requested handle IS the current open proposal, so the in-process
      // window is aligned to it. Only server-owned values open a window, and the
      // move DROPS any evidence recorded for the superseded window: an affirmative
      // spoken for another version never authorizes this one (spec: "evidence for
      // another or stale preview MUST fail closed").
      if (
        !window ||
        window.actionId !== current.proposalId ||
        window.version !== current.proposalVersion
      ) {
        if (window) arbiter.clear(window.actionId);
        arbiter.open({
          kind: "contact",
          actionId: current.proposalId,
          userId: input.userId,
          conversationId: input.conversationId,
          version: current.proposalVersion,
          createdAt: Date.now(),
        });
      }

      const decision = await arbiter.waitAndConsume({
        kind: "contact",
        actionId: input.proposalId,
        userId: input.userId,
        version: input.proposalVersion,
        tool: "confirm_trusted_recipient_action",
      });
      if (decision.status !== "consumed") {
        return {
          status: "confirmation_required",
          message: "Todavía no tengo tu confirmación para esta tarjeta.",
          currentProposalId: input.proposalId,
          currentProposalVersion: input.proposalVersion,
        };
      }
      const consumed = await dependencies.consume({
        userId: input.userId,
        conversationId: input.conversationId,
        proposalId: input.proposalId,
        proposalVersion: input.proposalVersion,
      });
      if (!consumed) return { status: "confirmation_required", message: "Esta propuesta ya no está disponible; generá una nueva." };
      arbiter.clear(input.proposalId);
      return { status: "consumed", message: "Listo, ya registré tu confirmación." };
    },
  };
}
