/**
 * Task 6.1/6.2 (payload half) — the alias arm of `ContactActionService.stage`.
 *
 * The persisted row is the authorization: the address column and the payload are
 * what the card renders and what the consume authorizes, so this suite asserts
 * the INSERT that actually goes to the database rather than a return value.
 *
 * A fake `DatabaseClient` records the bound parameters, and the fake row echoes
 * them back the way `map()` reads a real one. Every negative assertion is
 * preceded by a positive control.
 */
import { describe, expect, it } from "vitest";

import { ContactActionService } from "../../src/wallet/policy/contact-actions.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
/** The real devnet resolution of `sophie.sns`, recorded in the change's resources. */
const ALIAS_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

const EVIDENCE = {
  snsName: "sophie.sns",
  resolvedAt: "2026-01-01T00:00:00.000Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none" as const,
};

type Insert = { text: string; values: unknown[] };

/**
 * The value bound to one slot of the INSERT's `VALUES` tuple.
 *
 * Reading `values[…]` directly would be a false green: the parameter array is
 * built in JavaScript, so an assertion over it passes even when the statement
 * no longer binds that position at all (mutating the address slot to a literal
 * `NULL` left such an assertion green). This resolves the placeholder the
 * STATEMENT names, so a removed binding is a missing/`null` value here.
 */
function boundValue(insert: Insert, slot: number): unknown {
  const tuple = /VALUES \(([^)]*)\)/.exec(insert.text)?.[1]?.split(",") ?? [];
  const placeholder = /^\$(\d+)/.exec(tuple[slot]?.trim() ?? "");
  return placeholder ? insert.values[Number(placeholder[1]) - 1] : null;
}

function service() {
  const inserts: Insert[] = [];
  const database = {
    withUserTransaction: async (_userId: string, operation: (client: never) => Promise<unknown>) =>
      operation({
        query: async (text: string, values: unknown[] = []) => {
          inserts.push({ text, values });
          return {
            rows: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                version: 1,
                user_id: values[0],
                conversation_id: values[1],
                action: values[2],
                contact_id: values[3],
                contact_version: values[4],
                address: values[10],
                previous_address: null,
                revoked_grant_ids: values[5],
                status: "open",
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                published_at: null,
                payload: JSON.parse(String(values[9])),
              },
            ],
          };
        },
      } as never),
  } as never;
  return { actions: new ContactActionService(database), inserts };
}

describe("the alias arm of ContactActionService.stage", () => {
  it("persists the resolved address and the alias payload, and never the alias as the destination", async () => {
    const { actions, inserts } = service();
    const proposal = await actions.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "voice",
      action: "create",
      name: "Sophie",
      address: ALIAS_ADDRESS,
      alias: EVIDENCE,
    });

    expect(inserts).toHaveLength(1);
    // The address COLUMN is the server-resolved address (positive control), not
    // the label and not a client value.
    expect(proposal.address).toBe(ALIAS_ADDRESS);
    // Slot 5 is the `address` column of the INSERT, and the statement itself
    // must bind it to the resolved address.
    expect(boundValue(inserts[0]!, 5)).toBe(ALIAS_ADDRESS);
    // The payload explains where that address came from, and every key survives
    // a `.strict()` parse (the service would have thrown otherwise).
    expect(proposal.payload).toEqual({
      name: "Sophie",
      addressSource: "sns",
      snsName: "sophie.sns",
      resolvedAt: "2026-01-01T00:00:00.000Z",
      resolver: "sns/solana-devnet/v3",
      reverseDomain: null,
      reverseDomainState: "none",
    });
    // `reverify` is deliberately absent here: it is written by the contact-add
    // arm when the address is stored, not by the proposal.
    expect(proposal.payload).not.toHaveProperty("reverify");
  });

  it("keeps the review-required arm unchanged, with no address and no alias key", async () => {
    const { actions, inserts } = service();
    const proposal = await actions.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "text",
      action: "create",
      name: "Marta",
    });

    expect(proposal.address).toBeNull();
    expect(boundValue(inserts[0]!, 5)).toBeNull();
    expect(proposal.payload).toEqual({ name: "Marta", addressSource: "review_required" });
  });

  it("refuses an address that arrived without alias evidence", async () => {
    const { actions, inserts } = service();
    await expect(
      actions.stage({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        origin: "text",
        action: "create",
        address: ALIAS_ADDRESS,
      }),
    ).rejects.toThrow(/only reach a proposal through the alias arm/);
    expect(inserts).toHaveLength(0);
  });

  it("refuses alias evidence with no address to authorize", async () => {
    const { actions, inserts } = service();
    await expect(
      actions.stage({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        origin: "voice",
        action: "create",
        alias: EVIDENCE,
      }),
    ).rejects.toThrow(/requires the resolved address/);
    expect(inserts).toHaveLength(0);
  });

  it("refuses a resolved value that is not a canonical Solana address", async () => {
    const { actions, inserts } = service();
    await expect(
      actions.stage({
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        origin: "voice",
        action: "create",
        address: "0OIl-not-base58",
        alias: EVIDENCE,
      }),
    ).rejects.toThrow(/canonical Solana address/);
    expect(inserts).toHaveLength(0);
  });
});
