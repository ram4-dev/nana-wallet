import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  contactActionAddressResponseSchema,
  contactActionProposalSchema,
  replaceContactActionAddressInputSchema,
  type ContactActionAddressResponse,
  type ContactActionProposal as ContactActionProposalResponse,
} from "../contracts/http.js";
import { PrivyIdentityError } from "../auth/privy-identity.js";
import { isValidSolanaAddress } from "../memory/address.js";
import {
  contactProposalCard,
  contactProposalSummary,
  type ContactProposalPublication,
} from "../livekit/contact-proposal-publication.js";
import type {
  ContactActionProposal,
  ContactActionService,
} from "../wallet/policy/contact-actions.js";

/**
 * The review channel (design §8.3/§8.4/§9.2).
 *
 * Two rules shape this module, and both are the reason it is a separate route
 * file rather than two more handlers in `contacts.ts`:
 *
 * 1. **The address is re-validated here, not only in the service.** §8.3 says the
 *    value that arrives from a paste or a Capacitor scan is validated against the
 *    canonical base58 form on the way in. The service keeps its own guard as a
 *    backstop (it is reachable from the tool path too), but THIS check is what
 *    turns a malformed key into `422 DATOS_INVALIDOS` instead of the 500 a thrown
 *    service error would become.
 * 2. **The card is a rendering of the persisted row.** The GET response is built
 *    from the row the database returned, so a reload or a reconnect cannot change
 *    what the user is reviewing (design §8.4). The one derived field is the
 *    displayed status: a row that is still `open` but already past `expires_at`
 *    renders as `expired`, because `expires_at > now()` is exactly the predicate
 *    that makes it unconsumable — reporting `open` for it would be a lie the UI
 *    then has to guess about.
 */

export type ContactActionCardPublisher = (
  card: ContactProposalPublication,
) => Promise<boolean>;

export type ContactActionRoutesDependencies = {
  resolveUserId(request: FastifyRequest): Promise<string>;
  actions: ContactActionService;
  /**
   * Re-publication of the corrected card (design §8.3). Absent ⇒ the new version
   * is still created, but no card is delivered, so its `published_at` is never
   * stamped and no voice window can open for it (design §8.2: publication gates
   * the window). Fail closed, never halfway.
   */
  publishCard?: ContactActionCardPublisher;
  /** Injected clock so the `expired` derivation is assertable deterministically. */
  now?: () => Date;
};

type ContactActionApiError = {
  ok: false;
  error: { code: string; message: string };
};

type ContactActionReply = {
  code(status: number): { send(payload: ContactActionApiError): void };
};

const NOT_FOUND_MESSAGE = "No encontramos esta propuesta.";

/**
 * The user-visible revocation effects of a proposal, derived from the persisted
 * `revoked_grant_ids` — never from a client-supplied string. `null` means "this
 * proposal revokes nothing", which is different from an empty explanation.
 */
export function contactActionRevocationDisclosure(
  proposal: Pick<ContactActionProposal, "revokedGrantIds">,
): string | null {
  const count = proposal.revokedGrantIds.length;
  if (count === 0) return null;
  return count === 1
    ? "Esto también revoca el permiso automático que tenía este destinatario."
    : `Esto también revoca ${count} permisos automáticos de este destinatario.`;
}

/**
 * The alias evidence the card renders, derived from the persisted `payload` and
 * nothing else (task 6.3, design §2.4).
 *
 * A half-written claim emits NOTHING: `addressSource:'sns'` without a name or
 * without a resolution timestamp is not a sentence the card can honestly show, so
 * the alias lines stay absent rather than rendering an empty name. The reverse
 * state is carried through untouched — including `unknown`, which is a fact about
 * what could not be checked and is never collapsed into `none`.
 */
function contactActionAliasView(
  proposal: Pick<ContactActionProposal, "payload">,
): ContactActionProposalResponse["alias"] {
  const { addressSource, snsName, resolvedAt, resolver, reverseDomain, reverseDomainState } =
    proposal.payload;
  if (addressSource !== "sns") return undefined;
  if (!snsName || !resolvedAt || !resolver || !reverseDomainState) return undefined;
  return {
    name: snsName,
    resolvedAt,
    resolver,
    reverseDomain: reverseDomain ?? null,
    reverseDomainState,
  };
}

/**
 * The persisted row as the card must render it. Pure, so the derivation (status
 * and disclosure) is assertable without a route.
 */
export function contactActionProposalResponse(
  proposal: ContactActionProposal,
  now: Date,
): ContactActionProposalResponse {
  const expired =
    proposal.status === "open" &&
    new Date(proposal.expiresAt).getTime() <= now.getTime();
  const alias = contactActionAliasView(proposal);
  return contactActionProposalSchema.parse({
    proposalId: proposal.proposalId,
    proposalVersion: proposal.proposalVersion,
    action: proposal.action,
    contactId: proposal.contactId,
    contactVersion: proposal.contactVersion,
    address: proposal.address,
    previousAddress: proposal.previousAddress,
    revokedGrantIds: proposal.revokedGrantIds,
    revocationDisclosure: contactActionRevocationDisclosure(proposal),
    expiresAt: proposal.expiresAt,
    status: expired ? "expired" : proposal.status,
    ...(alias ? { alias } : {}),
  });
}

function errorReply(
  reply: ContactActionReply,
  status: number,
  code: string,
  message: string,
): ContactActionApiError {
  reply.code(status);
  return { ok: false, error: { code, message } };
}

/** `null` when the path parameter is not a proposal id at all. */
function proposalIdParam(request: FastifyRequest): string | null {
  const value = (request.params as { proposalId?: unknown }).proposalId;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

export function registerContactActionRoutes(
  app: FastifyInstance,
  dependencies: ContactActionRoutesDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());

  app.get(
    "/v1/contact-actions/:proposalId",
    async (
      request: FastifyRequest,
      reply,
    ): Promise<
      | { ok: true; data: ContactActionProposalResponse }
      | ContactActionApiError
    > => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const proposalId = proposalIdParam(request);
        if (!proposalId) {
          return errorReply(reply, 422, "DATOS_INVALIDOS", "Invalid proposal id.");
        }
        const proposal = await dependencies.actions.read(userId, proposalId);
        if (!proposal) {
          return errorReply(reply, 404, "NO_ENCONTRADO", NOT_FOUND_MESSAGE);
        }
        return { ok: true, data: contactActionProposalResponse(proposal, now()) };
      } catch (error) {
        return unexpected(reply, error);
      }
    },
  );

  app.post(
    "/v1/contact-actions/:proposalId/address",
    async (
      request: FastifyRequest,
      reply,
    ): Promise<
      | { ok: true; data: ContactActionAddressResponse }
      | ContactActionApiError
    > => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const proposalId = proposalIdParam(request);
        if (!proposalId) {
          return errorReply(reply, 422, "DATOS_INVALIDOS", "Invalid proposal id.");
        }
        const parsed = replaceContactActionAddressInputSchema.safeParse(
          request.body ?? {},
        );
        if (!parsed.success) {
          return errorReply(reply, 422, "DATOS_INVALIDOS", parsed.error.message);
        }
        // Re-validated on the way in (§8.3): a scanned value is untrusted input.
        const address = parsed.data.address.trim();
        if (!isValidSolanaAddress(address)) {
          return errorReply(
            reply,
            422,
            "DATOS_INVALIDOS",
            "That is not a valid Solana address.",
          );
        }

        const replacement = await dependencies.actions.replaceAddress(userId, {
          proposalId,
          expectedProposalVersion: parsed.data.expectedProposalVersion,
          address,
        });
        if (!replacement) {
          return errorReply(
            reply,
            409,
            "PROPUESTA_OBSOLETA",
            "This proposal changed. Reload the card and try again.",
          );
        }

        // Re-publication (§8.3): the card for the NEW version is delivered, and
        // only when that delivery succeeds is the new version stamped published —
        // which is what lets a window open for it and for nothing else. A failed
        // or absent publisher leaves the version unstamped and therefore
        // unconsumable (fail closed, §8.2).
        if (dependencies.publishCard && replacement.address) {
          const card = contactProposalCard(
            replacement,
            contactProposalSummary(replacement.action, replacement.payload.name),
            contactActionRevocationDisclosure(replacement),
          );
          const delivered = await dependencies
            .publishCard(card)
            .catch(() => false);
          if (delivered) {
            await dependencies.actions.markPublished(
              userId,
              replacement.proposalId,
              replacement.proposalVersion,
            );
          }
        }

        return {
          ok: true,
          data: contactActionAddressResponseSchema.parse({
            proposalId: replacement.proposalId,
            proposalVersion: replacement.proposalVersion,
            address: replacement.address,
          }),
        };
      } catch (error) {
        return unexpected(reply, error);
      }
    },
  );
}

function unexpected(reply: ContactActionReply, error: unknown): ContactActionApiError {
  // Identity failures stay 401 through the server-wide handler, never 500.
  if (error instanceof PrivyIdentityError) throw error;
  return errorReply(reply, 500, "ERROR_INTERNO", "Unexpected contact action error.");
}
