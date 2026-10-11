/**
 * The canonical hash of a parsed mutation body (design §6.2, §15 D-A).
 *
 * WHY THIS EXISTS
 * ---------------
 * `recipient_policy_sync_intent` is looked up by
 * `(wallet_id, user_id, idempotency_key)` and its other hash, `composed_hash`,
 * is the composed-POLICY hash — so the body a key was used with was never bound
 * to the key. A replay carrying a DIFFERENT body therefore returned the first
 * result. On the paste path that is invisible (the body IS the address); on the
 * alias path a client that asked to add `maria.sns` would be answered with the
 * contact created for `juan.sns`, which is a wrong answer about money.
 *
 * WHY IT IS CANONICAL AND NOT `JSON.stringify(body)`
 * --------------------------------------------------
 * The same request can reach the service as two byte-different JSON documents
 * with the same meaning (key order, array order). Hashing raw bytes would then
 * refuse a legitimate replay, and a guard that fires on valid operations is
 * worse than the hole it closes. So the form is FIXED the way the composer's
 * `composedRulesHash` fixes its own (design §3.2 guarantee 5, the precedent this
 * follows):
 *
 *   * declared keys first, in a declared order — never `Object.keys` insertion
 *     order, which is a property of how the caller built the object;
 *   * every other key after them, in UTF-16 code-unit order;
 *   * no key is ever dropped, so two bodies with different key sets can never
 *     hash alike;
 *   * arrays are sorted by their canonical JSON, so the two element orders of
 *     the same disclosure list hash alike.
 *
 * `localeCompare` is deliberately not used anywhere here: it is locale-sensitive
 * and would make the stored hash depend on the runtime environment, so the same
 * request could be refused on one host and accepted on another.
 *
 * The input is the PARSED body (the strict schema's output), never the raw JSON:
 * a rejection that never reached a schema must not be able to define a hash. The
 * `sha256:` prefix matches `composedRulesHash`, so a stored value names its own
 * algorithm instead of being an opaque hex string.
 */
import { createHash } from "node:crypto";

/**
 * The declared key order of the mutation bodies this hash covers: the fields of
 * the create, edit and removal inputs (`recipientCreateInputSchema`,
 * `recipientEditInputSchema`, `recipientRemovalInputSchema`).
 *
 * It is ONE list because a single hash serves all of them: the order only has to
 * be fixed and shared, not per-schema, and a body never carries keys from two
 * schemas at once (each one is `.strict()`). `idempotencyKey` is included
 * because the removal body carries it; it is constant across replays of the same
 * key, so it cannot make a legitimate replay look like a different request.
 */
const BODY_KEY_ORDER = [
  "name",
  "description",
  "address",
  "network",
  "expectedVersion",
  "expectedPolicyRevision",
  "expectedRevokedGrantIds",
  "idempotencyKey",
] as const;

/** JavaScript default string comparison: UTF-16 code-unit order. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Declared keys first in declared order, then the rest in code-unit order. */
function canonicalEntries(
  value: Record<string, unknown>,
): Array<[string, unknown]> {
  const declaredPresent = BODY_KEY_ORDER.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  const remaining = Object.keys(value)
    .filter((key) => !(declaredPresent as readonly string[]).includes(key))
    .sort(compareCodeUnits);
  return [...declaredPresent, ...remaining].map(
    (key): [string, unknown] => [key, canonicalValue(value[key])],
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Sorted by canonical JSON: a total, environment-independent order over
    // arbitrarily shaped elements, and the reason a disclosure list arriving in
    // a different order is the SAME request.
    return value
      .map(canonicalValue)
      .sort((a, b) => compareCodeUnits(JSON.stringify(a), JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return canonicalEntries(value as Record<string, unknown>);
  }
  return value;
}

/**
 * The canonical form of a parsed mutation body. Exported so a test can assert the
 * canonicalization itself rather than only the digest it produces.
 */
export function canonicalMutationBody(body: unknown): unknown {
  return canonicalValue(body);
}

/**
 * The authoritative `request_hash`: `sha256` over the canonical form above. Two
 * bodies hash alike exactly when they mean the same request under this
 * canonicalization, and the value is stored on the intent row the key produced
 * so a replay can be answered from durable state.
 */
export function mutationBodyHash(body: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalMutationBody(body)), "utf8")
    .digest("hex")}`;
}
