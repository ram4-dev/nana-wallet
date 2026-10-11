import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Structural guard for the U1/U4 live collection harness (design §11 U1, U4).
 *
 * These cases assert over the REAL harness source, following the idiom of
 * `tests/unit/policy-writer-structural.test.ts`: each negative case carries a
 * positive control, so a green run is not passing because the file changed
 * shape or resolved to nothing.
 *
 * The invariant that matters most here is the one the repo refuses to trade
 * away: the harness must be able to create and PATCH its OWN probe policies
 * (authorized) while being structurally INCAPABLE of issuing a signed transfer
 * under the wallet's attached policy. `signAndSendTransfer` stays unwired, so
 * U1 and U4 step (iii) record `unproven` rather than an inferred outcome.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS_PATH = "scripts/privy-policy-probe-collect-u1-u4.mjs";

function harnessSource(): string {
  return readFileSync(`${REPO_ROOT}${HARNESS_PATH}`, "utf8");
}

describe("the U1/U4 live collection harness", () => {
  it("runs both probes through the production probe functions", () => {
    const source = harnessSource();

    // Positive controls: the two probes this harness exists for are called.
    expect(source).toMatch(/\bprobeRuleComposition\s*\(/);
    expect(source).toMatch(/\bprobeEmptyComposition\s*\(/);
    // The probe functions are IMPORTED from the shipped module, not restated:
    // a hand-rolled probe here would be the second implementation of §11. The
    // dynamic-import form is the harness idiom (the container mounts no
    // `scripts/` volume, so nothing resolves at parse time).
    expect(source).toMatch(/import\("\/app\/dist\/wallet\/policy\/probe\.js"\)/);
  });

  it("reuses the production client, binding resolver and evidence writer", () => {
    const source = harnessSource();

    // The same three production seams the U2/U3 run used, so evidence lands in
    // `recipient_policy_state` through the repository and not through a second
    // writer.
    expect(source).toMatch(/\bPrivyServerClient\b/);
    expect(source).toMatch(/\bcreatePolicyProbeBindingResolver\s*\(/);
    expect(source).toMatch(/\bcreateRepositoryProbeEvidenceWriter\s*\(/);
    expect(source).toMatch(/\bmergePolicyStatusDetail\b|createRepositoryProbeEvidenceWriter/);
    // The policy members the U1/U4 (i)/(ii) steps need are wired.
    expect(source).toMatch(/\bcreatePolicy:/);
    expect(source).toMatch(/\bpatchPolicy:/);
    expect(source).toMatch(/\bgetPolicy:/);
  });

  it("structurally cannot issue a signed transfer", () => {
    const source = harnessSource();

    // The transport literal carries NO `signAndSendTransfer` member: the probe
    // then records `unproven("signed_transfer_unavailable")` /
    // `"signed_denial_unobserved"` instead of inferring an outcome (design §11).
    expect(
      /^\s*signAndSendTransfer\s*[:(]/m.test(source),
      "the harness wired a signed-transfer member the probes cannot honour safely",
    ).toBe(false);
    // And there is no send call site at all: no policy-selection request is
    // possible, and nothing reaches the wallet's attached policy.
    expect(source).not.toMatch(/signAndSendTransaction\s*\(/);
    // The provider's dispatch path is never imported, so no send capability can
    // appear here by construction.
    expect(source).not.toMatch(/solana-devnet-provider/);

    // Positive control: this case is not passing because the file is empty.
    expect(source).toMatch(/\bgetPolicy:/);
  });

  it("reads back the four evidence keys so U2/U3 cannot be erased", () => {
    const source = harnessSource();

    // The run verifies coexistence in place: U1's and U4's keys are read back
    // ALONGSIDE the U2/U3 keys that this run must not disturb.
    for (const key of [
      "rules_union",
      "rules_union_evidence",
      "empty_composition_evidence",
      "attachment_evidence",
      "ownership_evidence",
    ]) {
      expect(source, `${key} must be read back after the run`).toContain(key);
    }
    // The harness performs no wholesale status replacement: the only write path
    // is the merging writer the probes call.
    expect(source).not.toMatch(/\.setPolicyStatus\s*\(/);
  });

  it("never reads a secret from the environment or disk", () => {
    const source = harnessSource();

    // The container already holds its own credentials; the harness never reads
    // an `.env` file and never touches the authorization private key.
    expect(source).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");
    expect(source).not.toMatch(/dotenv/);
    expect(source).not.toMatch(/readFileSync\s*\(\s*["'`]\.env/);

    // Positive control: it does read the provider configuration through the
    // production reader, which is not a secret read.
    expect(source).toMatch(/\breadPrivyServerConfig\s*\(/);
  });
});
