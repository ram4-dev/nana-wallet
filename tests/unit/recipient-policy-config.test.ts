/**
 * Task 2.13 — the two non-destructive feature switches (design §13).
 *
 * WHY THIS IS A UNIT SUITE OVER THE CONFIG SURFACE
 * ------------------------------------------------
 * A rollback switch is only worth having if its DEFAULT is the safe one and if
 * an unparsable value cannot widen authority. Both are properties of the
 * parsing, not of a running stack, so they are asserted here as a matrix:
 *
 *   `RECIPIENT_POLICY_WRITER=enabled|frozen`  (default `enabled`)
 *   `RECIPIENT_POLICY_RECONCILER=enabled|disabled`
 *      (default `enabled` in the live stack, `disabled` in fixture mode)
 *
 * The second half of the file is the non-destructiveness requirement itself:
 * `frozen` must resolve to a port that CANNOT mutate anything — not a flag
 * consulted deep inside the apply path, but a type with no mutation surface at
 * all, so "issues no PATCH" is true by construction. A payload-carrying
 * `enabled` port is asserted next to it as the positive control, because a test
 * that only proves the frozen arm would also pass if the switch froze
 * everything unconditionally.
 */
import { describe, expect, it } from "vitest";
import {
  isRecipientPolicyFixtureMode,
  isRecipientPolicyReconcilerEnabled,
  isRecipientPolicyWriterFrozen,
  readRecipientPolicyWriter,
  RECIPIENT_POLICY_WRITER_FROZEN_REASON,
} from "../../src/config/recipient-policy.js";
import {
  selectPolicyApplyPort,
  type PolicyApplySignedPort,
} from "../../src/wallet/policy/service.js";

/** A signed port that would record a PATCH if it were ever reached. */
function signedPortStub(): PolicyApplySignedPort & { applyCalls: number } {
  const port = {
    kind: "signed" as const,
    applyCalls: 0,
    async apply() {
      port.applyCalls += 1;
      return { kind: "retryable_failure" as const, reason: "stub", detail: {} };
    },
  };
  return port;
}

describe("recipient policy switches (task 2.13, design §13)", () => {
  describe("RECIPIENT_POLICY_WRITER", () => {
    it("defaults to enabled and only an explicit value departs from it", () => {
      // Positive control: the default IS the live behaviour, so the frozen cases
      // below are a departure and not a description of every environment.
      expect(readRecipientPolicyWriter({})).toBe("enabled");
      expect(readRecipientPolicyWriter({ RECIPIENT_POLICY_WRITER: "" })).toBe(
        "enabled",
      );
      expect(
        readRecipientPolicyWriter({ RECIPIENT_POLICY_WRITER: "enabled" }),
      ).toBe("enabled");
      expect(readRecipientPolicyWriter({ RECIPIENT_POLICY_WRITER: "frozen" })).toBe(
        "frozen",
      );
      // Case/whitespace tolerance: an operator typing `FROZEN ` during an
      // incident must not silently keep the writer live.
      expect(
        readRecipientPolicyWriter({ RECIPIENT_POLICY_WRITER: " FROZEN " }),
      ).toBe("frozen");
      expect(isRecipientPolicyWriterFrozen({})).toBe(false);
      expect(isRecipientPolicyWriterFrozen({ RECIPIENT_POLICY_WRITER: "frozen" })).toBe(
        true,
      );
    });

    it("fails closed on an unrecognised value instead of widening authority", () => {
      // A typo (`frozne`) must never resolve to the live writer: the only safe
      // reading of "cannot tell" for a rollback switch is "do not write".
      for (const value of ["frozne", "off", "0", "yes", "disabled", "true"]) {
        expect(
          readRecipientPolicyWriter({ RECIPIENT_POLICY_WRITER: value }),
          `${value} must not resolve to the live writer`,
        ).toBe("frozen");
      }
    });
  });

  describe("RECIPIENT_POLICY_RECONCILER", () => {
    it("is enabled by default in a live stack and honoured when explicit", () => {
      // The existing contract (task 2.9) is preserved verbatim.
      expect(isRecipientPolicyReconcilerEnabled({})).toBe(true);
      expect(
        isRecipientPolicyReconcilerEnabled({
          RECIPIENT_POLICY_RECONCILER: "enabled",
        }),
      ).toBe(true);
      expect(
        isRecipientPolicyReconcilerEnabled({
          RECIPIENT_POLICY_RECONCILER: "disabled",
        }),
      ).toBe(false);
    });

    it("defaults to disabled in fixture mode, and fixture mode is explicit", () => {
      expect(isRecipientPolicyFixtureMode({})).toBe(false);
      // The suite's own marker and the documented fixture opt-in.
      expect(isRecipientPolicyFixtureMode({ VITEST: "true" })).toBe(true);
      expect(
        isRecipientPolicyFixtureMode({ WDK_TOOLS_SOURCE: "fixture" }),
      ).toBe(true);
      expect(
        isRecipientPolicyFixtureMode({ WDK_TOOLS_SOURCE: "live" }),
      ).toBe(false);

      // Fixture mode changes the DEFAULT only; an explicit value still wins.
      expect(isRecipientPolicyReconcilerEnabled({ VITEST: "true" })).toBe(false);
      expect(
        isRecipientPolicyReconcilerEnabled({ WDK_TOOLS_SOURCE: "fixture" }),
      ).toBe(false);
      expect(
        isRecipientPolicyReconcilerEnabled({
          VITEST: "true",
          RECIPIENT_POLICY_RECONCILER: "enabled",
        }),
      ).toBe(true);
    });

    it("is off whenever the writer is frozen, even when explicitly enabled", () => {
      // §13 non-destructiveness: a loop that cannot apply anything would only
      // write statuses nobody asked for. `frozen` therefore wins; this is a
      // narrowing of authority, never a widening.
      expect(
        isRecipientPolicyReconcilerEnabled({
          RECIPIENT_POLICY_RECONCILER: "enabled",
          RECIPIENT_POLICY_WRITER: "frozen",
        }),
      ).toBe(false);
      expect(
        isRecipientPolicyReconcilerEnabled({
          RECIPIENT_POLICY_RECONCILER: "enabled",
          RECIPIENT_POLICY_WRITER: "frozne",
        }),
      ).toBe(false);
    });

    it("fails closed on an unrecognised value", () => {
      expect(
        isRecipientPolicyReconcilerEnabled({
          RECIPIENT_POLICY_RECONCILER: "yes",
        }),
      ).toBe(false);
    });
  });

  describe("neither switch can delete a policy, clear a binding, or widen authority", () => {
    it("resolves the frozen writer to a port with no mutation surface at all", () => {
      const signed = signedPortStub();

      // Positive control: with the writer enabled the signed port IS selected,
      // so the frozen assertion below is about the switch and not about a
      // resolver that never returns anything.
      expect(selectPolicyApplyPort({ environment: {}, signed })).toBe(signed);

      const frozen = selectPolicyApplyPort({
        environment: { RECIPIENT_POLICY_WRITER: "frozen" },
        signed,
      });

      expect(frozen.kind).toBe("unavailable");
      if (frozen.kind !== "unavailable") {
        throw new Error("the frozen writer must resolve to the unavailable arm");
      }
      expect(frozen.reason).toBe(RECIPIENT_POLICY_WRITER_FROZEN_REASON);
      // The whole point: there is no `apply` to call, so no PATCH, no create and
      // no attach can be issued by this port — and no binding can be cleared.
      expect(Object.keys(frozen).sort()).toEqual(["kind", "reason"]);
      expect("apply" in frozen).toBe(false);
      for (const forbidden of [
        "apply",
        "patchPolicy",
        "createPolicy",
        "attachPolicyToSigner",
        "deletePolicy",
        "clearBinding",
      ]) {
        expect(forbidden in frozen, `${forbidden} must not exist`).toBe(false);
      }
      expect(signed.applyCalls).toBe(0);
    });

    it("never selects the signed port for ANY writer value", () => {
      const signed = signedPortStub();
      const writerValues = [
        "frozen",
        " FROZEN ",
        "frozne",
        "off",
        "0",
        "no",
        "disabled",
        "true",
        "Frozen",
      ];
      for (const value of writerValues) {
        const port = selectPolicyApplyPort({
          environment: { RECIPIENT_POLICY_WRITER: value },
          signed,
        });
        expect(
          port === signed,
          `RECIPIENT_POLICY_WRITER=${JSON.stringify(value)} must not select the writer`,
        ).toBe(false);
      }
      expect(signed.applyCalls).toBe(0);
    });

    it("keeps the reconciler switch non-destructive in every matrix cell", () => {
      // No combination of the two switches can produce a destructive capability:
      // the reconciler predicate is a boolean (there is nothing to delete or
      // clear through it), and every cell that could enable a write is either
      // the live default or an explicit opt-in.
      const matrix = [
        {},
        { RECIPIENT_POLICY_RECONCILER: "enabled" },
        { RECIPIENT_POLICY_RECONCILER: "disabled" },
        { RECIPIENT_POLICY_WRITER: "frozen" },
        { RECIPIENT_POLICY_WRITER: "frozen", RECIPIENT_POLICY_RECONCILER: "enabled" },
        { VITEST: "true" },
        { WDK_TOOLS_SOURCE: "fixture" },
        { WDK_TOOLS_SOURCE: "fixture", RECIPIENT_POLICY_WRITER: "enabled" },
      ];
      for (const environment of matrix) {
        expect(
          typeof isRecipientPolicyReconcilerEnabled(environment),
        ).toBe("boolean");
        // Frozen always means frozen, whatever else is set.
        if (environment.RECIPIENT_POLICY_WRITER === "frozen") {
          expect(isRecipientPolicyReconcilerEnabled(environment)).toBe(false);
          expect(readRecipientPolicyWriter(environment)).toBe("frozen");
        }
      }
    });
  });
});
