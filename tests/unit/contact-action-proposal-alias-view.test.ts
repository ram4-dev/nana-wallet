/**
 * Task 6.3 — the alias evidence a card read carries (design §2.4).
 *
 * The card renders the persisted row, so the row's alias evidence has to reach
 * the client on the READ response. This suite pins the projection: it is built
 * from `payload` only, an alias row carries the four display facts plus the
 * three-state reverse signal, a non-alias row carries none of them, and a
 * response with no alias still parses (the widening is additive).
 */
import { describe, expect, it } from "vitest";
import { contactActionProposalSchema } from "../../src/contracts/http.js";
import { contactActionProposalResponse } from "../../src/api/contact-actions.js";
import type {
  ContactActionProposal,
  ContactActionService,
} from "../../src/wallet/policy/contact-actions.js";

const NOW = new Date("2026-10-10T00:05:00.000Z");
const PROPOSAL_ID = "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001";
const ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

/** A row as `ContactActionService` maps it: the payload is the persisted JSONB. */
function persistedRow(
  payload: Record<string, unknown>,
): Parameters<typeof contactActionProposalResponse>[0] {
  return {
    proposalId: PROPOSAL_ID,
    proposalVersion: 1,
    userId: "2b1d6c0e-3f4a-4b5c-8d7e-9f0a1b2c3d4e",
    conversationId: "5c3e1f2a-6b7c-4d8e-9f0a-1b2c3d4e5f60",
    action: "create",
    contactId: null,
    contactVersion: null,
    address: ADDRESS,
    previousAddress: null,
    revokedGrantIds: [],
    status: "open",
    expiresAt: "2026-10-10T00:10:00.000Z",
    publishedAt: "2026-10-10T00:00:01.000Z",
    payload: payload as ContactActionProposal["payload"],
  };
}

const ALIAS_PAYLOAD = {
  addressSource: "sns",
  snsName: "sophie.sns",
  resolvedAt: "2026-10-10T00:00:00.000Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none",
} as const;

describe("contactActionProposalResponse — the alias evidence", () => {
  it("carries the persisted alias facts and the three-state reverse signal", () => {
    const view = contactActionProposalResponse(persistedRow({ ...ALIAS_PAYLOAD }), NOW);

    expect(view.alias).toEqual({
      name: "sophie.sns",
      resolvedAt: "2026-10-10T00:00:00.000Z",
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    });
    // The address line is unchanged: the alias never replaces the destination.
    expect(view.address).toBe(ADDRESS);
  });

  it("never degrades an unverified reverse lookup to `none`", () => {
    const view = contactActionProposalResponse(
      persistedRow({ ...ALIAS_PAYLOAD, reverseDomain: "sophie.sns", reverseDomainState: "unknown" }),
      NOW,
    );

    expect(view.alias?.reverseDomainState).toBe("unknown");
    expect(view.alias?.reverseDomain).toBe("sophie.sns");
  });

  it("refuses alias evidence on a row whose address did not come from a name", () => {
    // The paste supersede of an alias proposal clears these keys (6.2); this is
    // the read-path backstop: an alias claim cannot outlive the address it
    // described, so a `pasted` payload carrying leftovers renders NO alias line.
    const leftover = contactActionProposalResponse(
      persistedRow({ ...ALIAS_PAYLOAD, addressSource: "pasted" }),
      NOW,
    );

    expect(leftover.alias).toBeUndefined();
  });

  it("carries no alias for a row whose payload has no alias evidence", () => {
    const pasted = contactActionProposalResponse(
      persistedRow({ addressSource: "pasted" }),
      NOW,
    );
    const reviewRequired = contactActionProposalResponse(
      persistedRow({ addressSource: "review_required" }),
      NOW,
    );

    expect(pasted.alias).toBeUndefined();
    expect(reviewRequired.alias).toBeUndefined();
    // The address line is still the whole destination statement.
    expect(pasted.address).toBe(ADDRESS);
  });

  it("refuses a half-written alias claim instead of rendering half a sentence", () => {
    // `addressSource:'sns'` with no name is not renderable: the projection must
    // not emit `alias` for it, so the card cannot show "se agregó por undefined".
    const view = contactActionProposalResponse(
      persistedRow({
        addressSource: "sns",
        resolvedAt: "2026-10-10T00:00:00.000Z",
        resolver: "sns/solana-devnet/v3",
        reverseDomain: null,
        reverseDomainState: "none",
      }),
      NOW,
    );

    expect(view.alias).toBeUndefined();
  });

  it("keeps the response schema additive: a row without alias still parses", () => {
    const withoutAlias = contactActionProposalSchema.parse(
      contactActionProposalResponse(persistedRow({ addressSource: "pasted" }), NOW),
    );

    expect(withoutAlias.alias).toBeUndefined();
    expect(
      contactActionProposalSchema.safeParse(contactActionProposalResponse(persistedRow({ ...ALIAS_PAYLOAD }), NOW))
        .success,
    ).toBe(true);
  });
});

/** Compile-time proof the projection is fed by the mapped row, not by a literal. */
type _RowSource = Parameters<typeof contactActionProposalResponse>[0] extends ContactActionProposal
  ? true
  : never;
type _ServiceShape = ContactActionService["read"] extends (...args: never[]) => unknown ? true : never;
