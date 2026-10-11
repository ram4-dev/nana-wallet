/**
 * Task 3.1 — the canonical request-body hash (design §6.2).
 *
 * The integration suite proves the hash is STORED and COMPARED; this one pins
 * what the hash is over, because the two ways it can be wrong are both silent:
 * a form that depends on `Object.keys` insertion order refuses legitimate
 * replays, and a form that drops keys lets two different requests hash alike.
 * Each case below has its positive control in the same `it`.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalMutationBody,
  mutationBodyHash,
} from "../../src/wallet/policy/request-hash.js";

const CREATE_BODY = {
  name: "Mamá",
  description: "mensualidad",
  address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
};

describe("mutationBodyHash (task 3.1)", () => {
  it("is a sha256 digest that names its own algorithm", () => {
    const hash = mutationBodyHash(CREATE_BODY);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Positive control for every "hashes alike" case in this file: the function
    // is deterministic, so a repeated call is not a new value.
    expect(mutationBodyHash({ ...CREATE_BODY })).toBe(hash);
  });

  it("does not depend on the insertion order of the keys", () => {
    const reordered = {
      address: CREATE_BODY.address,
      description: CREATE_BODY.description,
      name: CREATE_BODY.name,
    };
    // Same request, two documents: the SAME hash, or a valid replay is refused.
    expect(mutationBodyHash(reordered)).toBe(mutationBodyHash(CREATE_BODY));
    // Positive control: a changed value DOES move the hash, so the equality above
    // is canonicalization and not a constant.
    expect(mutationBodyHash({ ...CREATE_BODY, description: "otra" })).not.toBe(
      mutationBodyHash(CREATE_BODY),
    );
  });

  it("orders undeclared keys by UTF-16 code unit, never by locale", () => {
    // `'A' < 'a'` in code units; `localeCompare` ranks them the other way, which
    // would make one stored hash mean two different things across environments.
    const one = { name: "x", A: 1, b: 2 };
    const other = { name: "x", b: 2, A: 1 };
    expect(mutationBodyHash(one)).toBe(mutationBodyHash(other));
    // Positive control: the two keys really are present and distinct.
    expect(canonicalMutationBody(one)).toEqual([
      ["name", "x"],
      ["A", 1],
      ["b", 2],
    ]);
  });

  it("sorts arrays, so the same disclosure list in either order is one request", () => {
    const grantA = "11111111-1111-4111-8111-111111111111";
    const grantB = "22222222-2222-4222-8222-222222222222";
    const ascending = { expectedVersion: 3, expectedRevokedGrantIds: [grantA, grantB] };
    const descending = { expectedVersion: 3, expectedRevokedGrantIds: [grantB, grantA] };
    expect(mutationBodyHash(ascending)).toBe(mutationBodyHash(descending));
    // Positive control: the SET still matters — a shorter disclosure is a
    // different request, so sorting cannot be hiding a missing grant.
    expect(
      mutationBodyHash({ ...ascending, expectedRevokedGrantIds: [grantA] }),
    ).not.toBe(mutationBodyHash(ascending));
  });

  it("never drops a key, so two bodies with different key sets cannot hash alike", () => {
    const withDescription = { name: "x", description: "" };
    const without = { name: "x" };
    expect(mutationBodyHash(withDescription)).not.toBe(mutationBodyHash(without));
    // Positive control: the two are genuinely the same values apart from the
    // absent key, so the difference is the key set and nothing else.
    expect(canonicalMutationBody(withDescription)).toEqual([
      ["name", "x"],
      ["description", ""],
    ]);
    expect(canonicalMutationBody(without)).toEqual([["name", "x"]]);
  });

  it("canonicalizes nested objects one level down as well", () => {
    const one = { name: "x", provenance: { origin: "user", alias: "juan.sns" } };
    const other = { name: "x", provenance: { alias: "juan.sns", origin: "user" } };
    expect(mutationBodyHash(one)).toBe(mutationBodyHash(other));
    expect(
      mutationBodyHash({ name: "x", provenance: { alias: "maria.sns", origin: "user" } }),
    ).not.toBe(mutationBodyHash(one));
  });
});
