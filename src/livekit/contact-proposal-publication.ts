import type { ContactActionPort } from "../agent/definition.js";
import type { SnsResolveFailure, SnsResolver } from "../wallet/sns/resolver.js";
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

/**
 * The outcome of resolving an explicit `.sns` name the user supplied (design
 * §2.3). `resolved` carries the server-observed address and the evidence the
 * card must display; `refused` carries the typed taxonomy code so the two
 * different failures — "that name does not exist" and "I could not reach the
 * resolver" — are never narrated as the same thing.
 */
export type AliasResolution =
  | {
      status: "resolved";
      snsName: string;
      address: string;
      resolvedAt: string;
      resolver: string;
      reverseDomain: string | null;
      reverseDomainState: "present" | "none" | "unknown";
    }
  | { status: "refused"; code: string; reason: string };

/**
 * The server-owned sentence for each refusal, and the reason it is a map rather
 * than one string: an unreachable resolver MUST NEVER be reported as a
 * non-existent name (spec: *Unresolvable, unsupported or unreachable alias
 * creates no permission*). The code is spoken verbatim so the distinction is
 * audible, not just typed.
 *
 * `attemptedName` is spoken too, and that is load-bearing on the voice surface
 * rather than cosmetic. A spoken name reaches the model through STT, and the
 * model has been observed re-spelling it the way it sounds in Spanish — a turn
 * whose display name was "Sophie" staged `snsName: "sofi.sns"` for a domain
 * registered as `sophie.sns`. Without the name in the sentence the user is told
 * only that "ese nombre" was not found, which is unactionable: the system asked
 * for a spelling the user never said, and nothing in the reply lets them notice.
 * Naming it turns an unexplained refusal into a one-word correction.
 */
export function aliasRefusalMessage(code: string, attemptedName?: string): string {
  const quoted = attemptedName?.trim() ? `"${attemptedName.trim()}"` : "ese nombre";
  // Offered only where a different spelling could actually change the answer:
  // a name the registry does not have, or one whose owner cannot be trusted.
  // An unreachable registry is not a spelling problem and must not be narrated
  // as one.
  const spellItOut = " Si el nombre es difícil de entender, deletreámelo y lo vuelvo a intentar.";
  switch (code) {
    case "NOMBRE_NO_ENCONTRADO":
      return `No encontré ${quoted} (NOMBRE_NO_ENCONTRADO).${spellItOut} No voy a habilitar este destinatario.`;
    case "RESOLVEDOR_NO_DISPONIBLE":
      return `No pude consultar la red para resolver ${quoted} (RESOLVEDOR_NO_DISPONIBLE). No voy a habilitar este destinatario.`;
    case "NOMBRE_NO_SOPORTADO":
      return `${quoted === "ese nombre" ? "Ese nombre" : quoted} no es un .sns que pueda usar (NOMBRE_NO_SOPORTADO). No voy a habilitar este destinatario.`;
    case "NOMBRE_AMBIGUO":
      return `Ese nombre no me da una dirección confiable para ${quoted} (NOMBRE_AMBIGUO).${spellItOut} No voy a habilitar este destinatario.`;
    default:
      return `No pude resolver ${quoted} (${code}). No voy a habilitar este destinatario.`;
  }
}

/**
 * The confirm-time re-verification's outcome (design §4.2–§4.4, decisions S10/S11).
 *
 * `not_alias` is not a synonym for `unchanged`: it says the version carries no
 * alias claim at all, so there was nothing to re-resolve and nothing to record.
 * `unresolvable` is the one outcome that must never reuse the wording of the
 * others: the registry ANSWERED and the name no longer leads to a destination, so
 * the confirmation fails closed instead of proceeding with an address whose
 * justification is gone.
 */
export type AliasReverification =
  | { status: "not_alias" }
  | { status: "unchanged" }
  | { status: "unavailable" }
  | {
      status: "changed";
      /**
       * The NEW version's identity. A supersede inserts a NEW ROW (with its own
       * id) chained by `supersedes_id`, and the current handle is that row's id —
       * so the confirmation surface must hand the model the new id, not the one it
       * used for the version that no longer exists.
       */
      supersededProposalId: string;
      supersededProposalVersion: number;
      observedAddress: string;
    }
  | { status: "unresolvable"; code: string };

export type AliasReverificationDependencies = {
  actions: Pick<ContactActionService, "read" | "replaceAddress">;
  /** The same seam the create path uses. Never cached across calls (§4.2). */
  resolver: SnsResolver;
};

/**
 * The re-verification ADAPTER: re-resolve the name the displayed version was
 * frozen from, compare it against that version's own address, and supersede when
 * they differ (design §4.3).
 *
 * It performs remote I/O only — it opens no transaction and takes no lease, so a
 * caller can place it immediately before the persisted consume without putting an
 * RPC call inside the mutation transaction. It is deliberately NOT memoized: the
 * whole point is to observe the name at the moment the address is authorized, and
 * a cache would answer with an address obtained for a different moment.
 */
export function createAliasReverifier(
  dependencies: AliasReverificationDependencies,
): (input: { userId: string; proposalId: string; proposalVersion: number }) => Promise<AliasReverification> {
  return async ({ userId, proposalId, proposalVersion }) => {
    const proposal = await dependencies.actions.read(userId, proposalId);
    // The version the user is confirming must be the one that was read: anything
    // else and there is no claim to re-verify.
    if (!proposal || proposal.proposalVersion !== proposalVersion) return { status: "unavailable" };
    const { addressSource, snsName } = proposal.payload;
    if (addressSource !== "sns" || !snsName) return { status: "not_alias" };

    const outcome = await dependencies.resolver.resolve(snsName);
    if (!outcome.ok) {
      // UNREACHABLE ⇒ proceed with the displayed address (the re-verification is a
      // divergence detector, not an authority gate) and record that it could not
      // be made. Every OTHER failure is an answer, and an answer that the name no
      // longer leads to the displayed destination fails closed.
      if (outcome.failure.kind === "unreachable") return { status: "unavailable" };
      return { status: "unresolvable", code: aliasResolutionRefusalCode(outcome.failure.kind) };
    }
    if (outcome.value.address === proposal.address) return { status: "unchanged" };

    const superseded = await dependencies.actions.replaceAddress(userId, {
      proposalId,
      expectedProposalVersion: proposalVersion,
      address: outcome.value.address,
      source: "sns",
      // The freshly observed evidence, so the new version's claim is about ITS
      // address and its freshness line reports THIS observation (design §4.3).
      alias: {
        snsName: outcome.value.name,
        resolvedAt: outcome.value.resolvedAt,
        resolver: outcome.value.resolver,
        reverseDomain: outcome.value.reverseDomain,
        reverseDomainState: outcome.value.reverseDomainState,
      },
    });
    // Zero rows: the version was superseded, consumed or expired concurrently.
    // Nothing was created for it, so the confirmation cannot proceed.
    if (!superseded) return { status: "unavailable" };
    return {
      status: "changed",
      supersededProposalId: superseded.proposalId,
      supersededProposalVersion: superseded.proposalVersion,
      observedAddress: outcome.value.address,
    };
  };
}

/**
 * The typed refusal code for a resolution failure (spec: *Unresolvable,
 * unsupported or unreachable alias creates no permission*).
 *
 * It is TOTAL over the taxonomy and data-driven, so adding a failure kind is a
 * type error here instead of a silent fall-through into the wrong sentence. The
 * one thing that must never happen is an unreachable resolver being narrated as
 * a non-existent name: `unreachable` is OUR availability, not the user's name.
 *
 * BOTH alias arms share it. The stage-time adapter asks it about every failure;
 * the confirm-time re-verification asks it only about answers, because it handles
 * `unreachable` itself — there, an unreachable registry must not fail the
 * confirmation, so that case never reaches this map.
 */
const ALIAS_REFUSAL_CODE: Record<SnsResolveFailure["kind"], string> = {
  unreachable: "RESOLVEDOR_NO_DISPONIBLE",
  resolver_misconfigured: "RESOLVEDOR_NO_DISPONIBLE",
  not_found: "NOMBRE_NO_ENCONTRADO",
  ambiguous: "NOMBRE_AMBIGUO",
  unsupported_tld: "NOMBRE_NO_SOPORTADO",
  malformed_name: "NOMBRE_NO_SOPORTADO",
};

function aliasResolutionRefusalCode(kind: SnsResolveFailure["kind"]): string {
  return ALIAS_REFUSAL_CODE[kind];
}

export type AliasResolutionDependencies = {
  /** The same seam the re-verification uses. Never cached across calls. */
  resolver: SnsResolver;
};

/**
 * The stage-time ADAPTER (design §2.3): resolve the explicit `.sns` name the user
 * spoke into the address the proposal row will store, or refuse with the code
 * that refusal has earned.
 *
 * It is the ONLY source of the address on the alias path — the model supplies a
 * LABEL and never a destination — and it runs BEFORE any proposal row exists, so
 * a caller that cannot resolve refuses with `alias_unresolved` and leaves the
 * database untouched. That is why the mapping must be complete: "that name does
 * not exist" and "I could not reach the registry" are different facts, and only
 * one of them is about the user's name.
 *
 * Deliberately not memoized: a resolution is an observation of the registry at
 * the moment it is asked, and a cache would answer the card with an address
 * obtained for a different moment.
 */
export function createAliasResolver(
  dependencies: AliasResolutionDependencies,
): (input: { userId: string; snsName: string }) => Promise<AliasResolution> {
  return async ({ snsName }) => {
    const outcome = await dependencies.resolver.resolve(snsName);
    if (!outcome.ok) {
      return {
        status: "refused",
        code: aliasResolutionRefusalCode(outcome.failure.kind),
        // Diagnostic only: the SENTENCE comes from the code, and the reason keeps
        // the resolver's own classification for the logs.
        reason: outcome.failure.kind,
      };
    }
    return {
      status: "resolved",
      // The resolver's canonical name, never the spoken one: what the row and the
      // card display is what the registry was asked about.
      snsName: outcome.value.name,
      address: outcome.value.address,
      resolvedAt: outcome.value.resolvedAt,
      resolver: outcome.value.resolver,
      reverseDomain: outcome.value.reverseDomain,
      reverseDomainState: outcome.value.reverseDomainState,
    };
  };
}

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
  /**
   * Resolves an explicit `.sns` name **before** the proposal is persisted (design
   * §2.3). Remote I/O, so it runs outside any transaction, and it is the only
   * source of the address on the alias path: the model never supplies one.
   *
   * It is optional so a caller that cannot resolve names keeps the behaviour it
   * had — and an alias request on such a caller FAILS CLOSED with a typed
   * refusal rather than being emulated from the spoken label.
   */
  resolveAlias?: (input: { userId: string; snsName: string }) => Promise<AliasResolution>;
  /**
   * The confirm-time re-verification (design §4.2, decision S10): called AFTER the
   * affirmative and IMMEDIATELY BEFORE the persisted consume, so the address is
   * compared against the one the user is confirming rather than one observed
   * before the bounded window opened. Remote I/O, never inside a transaction,
   * never satisfied from a cache.
   *
   * Absent ⇒ the confirmation proceeds with the displayed address and records the
   * re-verification as `unavailable`: a caller that cannot re-verify must not
   * claim it did, and it must not block a user on a detector that cannot widen
   * anything either.
   */
  reverifyAlias?: (input: {
    userId: string;
    proposalId: string;
    proposalVersion: number;
  }) => Promise<AliasReverification>;
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
    /** The outcome the consume must record with the row, when it is an alias one. */
    reverify?: "verified" | "unavailable";
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

      // An explicit `.sns` name is resolved BEFORE the proposal row exists, and
      // before the unpublished-row cleanup below — a name that cannot be
      // resolved must leave the database untouched (no proposal, no card, no
      // superseded row). The refusal is typed so "does not exist" and "could not
      // be reached" stay distinguishable.
      let alias: AliasResolution | null = null;
      if (input.snsName !== undefined) {
        const resolution = dependencies.resolveAlias
          ? await dependencies.resolveAlias({ userId: input.userId, snsName: input.snsName })
          : ({ status: "refused", code: "RESOLVEDOR_NO_DISPONIBLE", reason: "resolver_unavailable" } as const);
        if (resolution.status === "refused") {
          return {
            status: "alias_unresolved",
            code: resolution.code,
            message: aliasRefusalMessage(resolution.code, input.snsName),
          };
        }
        alias = resolution;
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
        ...(alias
          ? {
              address: alias.address,
              alias: {
                snsName: alias.snsName,
                resolvedAt: alias.resolvedAt,
                resolver: alias.resolver,
                reverseDomain: alias.reverseDomain,
                reverseDomainState: alias.reverseDomainState,
              },
            }
          : {}),
      });

      const card = contactProposalCard(proposal, contactProposalSummary(proposal.action, input.name));      try {
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
      // ── THE RE-VERIFICATION (design §4.2, decision S10) ──────────────────────
      // AFTER the affirmative and IMMEDIATELY BEFORE the persisted consume. The
      // placement is deliberate: re-verifying before `waitAndConsume` would leave
      // the whole bounded affirmative window (up to 2 000 ms) unchecked, so the
      // address compared would be older than the one being authorized. This call
      // is remote I/O and runs OUTSIDE every transaction — the only transaction on
      // this path is the one `dependencies.consume` opens below.
      const recheck: AliasReverification = dependencies.reverifyAlias
        ? await dependencies.reverifyAlias({
            userId: input.userId,
            proposalId: input.proposalId,
            proposalVersion: input.proposalVersion,
          })
        : { status: "unavailable" };

      if (recheck.status === "changed") {
        // FAIL CLOSED, then hand the user the NEW card: version n is superseded and
        // never consumed, and the window re-opens for n+1 ONLY after it is
        // re-published (a window is opened here only if the stamp succeeded).
        //
        // The window for THIS version is cleared unconditionally, before the
        // delivery is even attempted: `changed` means the version was superseded, so
        // an armed window bound to it must not survive the re-publication failing.
        arbiter.clear(input.proposalId);
        const republished = await republishSupersededCard(
          dependencies,
          {
            userId: input.userId,
            proposalId: recheck.supersededProposalId,
            proposalVersion: recheck.supersededProposalVersion,
          },
          arbiter,
        );
        return {
          status: "confirmation_required",
          message: republished
            ? `La dirección de ese nombre cambió: la tarjeta muestra la dirección nueva (versión ${recheck.supersededProposalVersion}). Mirala y confirmame otra vez.`
            : "La dirección de ese nombre cambió y no pude mostrarte la tarjeta nueva. Generá la propuesta otra vez.",
          // The handle that IS open: the new row's id, never the superseded one.
          currentProposalId: recheck.supersededProposalId,
          currentProposalVersion: recheck.supersededProposalVersion,
        };
      }

      if (recheck.status === "unresolvable") {
        // The registry ANSWERED and the name no longer leads anywhere: nothing is
        // consumed and nothing is authorized for the displayed address. This is
        // never narrated as a change of destination, and it is never the
        // unreachable case either (`reverifyRefusalCode` names it).
        return {
          status: "confirmation_required",
          message: `No pude confirmar ese nombre: ya no resuelve a la dirección de la tarjeta (${recheck.code}). Generá la propuesta otra vez.`,
          currentProposalId: input.proposalId,
          currentProposalVersion: input.proposalVersion,
        };
      }

      // `unchanged` agreed; `unavailable` could not be reached and proceeds with
      // the DISPLAYED address, recorded as such (S11). `not_alias` has nothing to
      // record, because the version carries no alias claim at all.
      const consumed = await dependencies.consume({
        userId: input.userId,
        conversationId: input.conversationId,
        proposalId: input.proposalId,
        proposalVersion: input.proposalVersion,
        ...(recheck.status === "unchanged"
          ? { reverify: "verified" as const }
          : recheck.status === "unavailable"
            ? { reverify: "unavailable" as const }
            : {}),
      });
      if (!consumed) return { status: "confirmation_required", message: "Esta propuesta ya no está disponible; generá una nueva." };
      arbiter.clear(input.proposalId);
      return { status: "consumed", message: "Listo, ya registré tu confirmación." };
    },
  };
}

/**
 * Re-publishes the card for a version that superseded the one the user was
 * reviewing, and re-opens the window only when the delivery actually happened
 * (design §4.3): `markPublished` is what stamps `published_at`, and a version
 * whose `published_at` is NULL can never be offered as the current handle
 * (`readOpen()` requires it), so a failed delivery leaves no window to consume.
 *
 * The old window is cleared by the caller BEFORE this runs — a window that could
 * still consume version n after the address changed under it is exactly what must
 * not survive this path, whatever the delivery below does.
 */
async function republishSupersededCard(
  dependencies: VoiceContactActionDependencies,
  input: { userId: string; proposalId: string; proposalVersion: number },
  arbiter: VoiceContactActionDependencies["arbiter"],
): Promise<boolean> {
  try {
    const superseded = await dependencies.actions.read(input.userId, input.proposalId);
    if (!superseded || superseded.proposalVersion !== input.proposalVersion) return false;
    const card = contactProposalCard(
      superseded,
      contactProposalSummary(superseded.action, superseded.payload.name),
    );
    const destination = dependencies.boundParticipantIdentity;
    if (!destination) return false;
    await dependencies.publish({
      bytes: new TextEncoder().encode(JSON.stringify(card)),
      reliable: true,
      topic: CONTACT_PROPOSAL_TOPIC,
      destinationIdentities: [destination],
    });
    const published = await dependencies.actions.markPublished(
      input.userId,
      superseded.proposalId,
      superseded.proposalVersion,
    );
    if (!published) return false;
    const opened = arbiter?.open({
      kind: "contact",
      actionId: published.proposalId,
      userId: input.userId,
      conversationId: published.conversationId,
      version: published.proposalVersion,
      createdAt: Date.now(),
    });
    return opened ? opened.status === "opened" : false;
  } catch {
    // A delivery or stamp failure leaves version n+1 unpublished: no window
    // re-opens, and version n was never consumed. Fail closed, never halfway.
    return false;
  }
}
