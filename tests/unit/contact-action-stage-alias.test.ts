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
 *
 * The fake DISCRIMINATES the statements it is asked to run: `stage` now cleans up
 * an already-dead window inside its transaction before it inserts (its own
 * UPDATE), and only the INSERT returns a row. Echoing the INSERT's row shape back
 * for the UPDATE would be the double inventing a row the database never returns.
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

/** The statement kind the service sends, read off the statement itself. */
function kind(statement: Insert): string {
  return statement.text.trimStart().split(/\s+/, 1)[0] ?? "";
}

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
  const statements: Insert[] = [];
  const inserts: Insert[] = [];
  const database = {
    withUserTransaction: async (_userId: string, operation: (client: never) => Promise<unknown>) =>
      operation({
        query: async (text: string, values: unknown[] = []) => {
          const statement = { text, values };
          statements.push(statement);
          // Only the INSERT owns a returned row. The stage-time cleanup of a dead
          // window is an UPDATE with nothing to return.
          if (kind(statement) !== "INSERT") return { rows: [], rowCount: 0 };
          inserts.push(statement);
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
  return { actions: new ContactActionService(database), inserts, statements };
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

  it("frees an expired window BEFORE it inserts, and only an expired one", async () => {
    const { actions, statements } = service();
    await actions.stage({
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      origin: "text",
      action: "create",
      name: "Marta",
    });

    // ORDER IS THE POINT: the cleanup runs in the SAME transaction and BEFORE the
    // insert the partial unique index judges. After it, the insert has already
    // collided and there is nothing left to clean.
    expect(statements.map(kind)).toEqual(["UPDATE", "INSERT"]);
    const cleanup = statements[0]!;
    // `status='open' AND expires_at <= now()` and NOTHING ELSE: a LIVE window
    // (`expires_at > now()`) is exactly what the one-open rule protects, and
    // `published_at` must not appear, so a delivered card cannot be freed here.
    expect(cleanup.text).toMatch(/status='open' AND expires_at <= now\(\)/);
    expect(cleanup.text).not.toMatch(/published_at/);
    // The cleanup is scoped to the owner AND the conversation, like the index.
    expect(cleanup.values).toEqual([USER_ID, CONVERSATION_ID]);
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
