/**
 * Task 2.13 — the two non-destructive feature switches (design §13).
 *
 * Both switches exist to make a rollback possible WITHOUT touching data. Neither
 * may delete a policy, clear a binding, rotate a key, or widen authority, so
 * every rule in this module is chosen accordingly:
 *
 *   `RECIPIENT_POLICY_WRITER=enabled|frozen`   default `enabled`
 *     `frozen` stops compose+apply. Contact mutations still persist as
 *     saved-not-enabled intent, no PATCH is issued, the previously attached
 *     policy stays exactly as it is, and every surface reports the frozen state.
 *
 *   `RECIPIENT_POLICY_RECONCILER=enabled|disabled`
 *     default `enabled` in the live stack, `disabled` in fixture mode.
 *
 * PARSING RULES, DELIBERATELY CHOSEN
 * ----------------------------------
 *   1. An ABSENT value is the documented default, never "off by accident".
 *   2. An UNRECOGNISED non-empty value fails closed. A typo during an incident
 *      (`frozne`) must not leave the writer live, and an unparsable reconciler
 *      value must not start a loop that writes provider state. Both directions
 *      of this rule are a narrowing of authority, which is the only direction a
 *      rollback switch may ever move.
 *   3. `frozen` WINS over `RECIPIENT_POLICY_RECONCILER=enabled`: a loop that
 *      cannot apply anything would only write statuses nobody asked for, and
 *      the writer switch is the one that must be able to stop all writes.
 *   4. An explicit value wins over the fixture-mode default, so a fixture
 *      deployment can opt in deliberately while the default stays off.
 */

/** The two writer states. Nothing else is representable, by type. */
export type RecipientPolicyWriterSwitch = "enabled" | "frozen";

/**
 * The reason recorded when the writer is frozen. It is a status reason, not an
 * error: the mutation is saved and reported, never silently dropped.
 */
export const RECIPIENT_POLICY_WRITER_FROZEN_REASON = "policy_writer_frozen";

function normalized(environment: NodeJS.ProcessEnv, key: string): string {
  return (environment[key] ?? "").trim().toLowerCase();
}

function enabledFlag(value: string): boolean {
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Fixture mode: this process runs without live provider capability. Two markers
 * are honoured — the test/CI marker the repository already uses to opt out of
 * background work (`VITEST`), and the documented fixture deployment switch
 * (`WDK_TOOLS_SOURCE=fixture`). Nothing here reports on or alters that mode; it
 * only decides which DEFAULT the reconciler switch falls back to.
 */
export function isRecipientPolicyFixtureMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (enabledFlag(normalized(environment, "VITEST"))) return true;
  return normalized(environment, "WDK_TOOLS_SOURCE") === "fixture";
}

/**
 * `RECIPIENT_POLICY_WRITER` (design §13). `enabled` unless explicitly frozen;
 * any other non-empty value is read as `frozen` (rule 2).
 */
export function readRecipientPolicyWriter(
  environment: NodeJS.ProcessEnv = process.env,
): RecipientPolicyWriterSwitch {
  const raw = normalized(environment, "RECIPIENT_POLICY_WRITER");
  if (raw === "" || raw === "enabled") return "enabled";
  return "frozen";
}

/** True when no policy write may be issued by this process. */
export function isRecipientPolicyWriterFrozen(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return readRecipientPolicyWriter(environment) === "frozen";
}

/**
 * `RECIPIENT_POLICY_RECONCILER` (design §13), with the precedence of rules 1–4:
 * explicit `disabled` beats everything; explicit `enabled` beats the fixture
 * default but loses to a frozen writer; an absent value follows the deployment
 * mode; anything else is off.
 */
export function isRecipientPolicyReconcilerEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = normalized(environment, "RECIPIENT_POLICY_RECONCILER");
  if (raw === "disabled") return false;
  if (isRecipientPolicyWriterFrozen(environment)) return false;
  if (raw === "enabled") return true;
  if (raw !== "") return false;
  return !isRecipientPolicyFixtureMode(environment);
}
