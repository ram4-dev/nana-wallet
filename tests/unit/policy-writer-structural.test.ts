import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard: the composer is the single full-rule writer (design §3.3,
 * "unreachable by construction"), copied from the idiom of
 * `tests/unit/signer-worker-path.test.ts` (a named set of files must never read
 * a given symbol).
 *
 * These cases assert over the real source tree. The invariants hold at HEAD, so
 * a green run is not evidence by itself: each case is proven load-bearing by
 * mutation (a violating call is added, the named case goes red, the call is
 * removed — see the task 1.10 apply-progress entry). Every case here fails the
 * moment a new caller appears, because the measured sets are compared for
 * EXACT equality with a frozen exception list, not with a subset check.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICY_PATH = "src/wallet/policy/";
const SIGNER_PATH = "src/wallet/signer/";

type SourceFile = { path: string; source: string };

function listTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listTypeScriptFiles(absolute));
    else if (entry.name.endsWith(".ts")) found.push(absolute);
  }
  return found;
}

/** Every `.ts` file under `src/`, with a repo-relative POSIX path. */
function sourceFiles(): SourceFile[] {
  return listTypeScriptFiles(join(REPO_ROOT, "src"))
    .map((absolute) => ({
      path: relative(REPO_ROOT, absolute).split(sep).join("/"),
      source: readFileSync(absolute, "utf8"),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
}

/** Repo-relative paths holding a match for `pattern` outside the policy path. */
function filesOutsidePolicyPath(pattern: RegExp): string[] {
  return sourceFiles()
    .filter(
      (file) =>
        !file.path.startsWith(POLICY_PATH) &&
        !file.path.startsWith(SIGNER_PATH),
    )
    .filter((file) => pattern.test(file.source))
    .map((file) => file.path);
}

function mentions(pattern: RegExp): string[] {
  return sourceFiles()
    .filter((file) => pattern.test(file.source))
    .map((file) => file.path);
}

/** Matches an imported symbol inside an `import ...;` statement. */
function importsSymbol(symbol: string): RegExp {
  return new RegExp(`\\bimport\\b[^;]*\\b${symbol}\\b[^;]*;`, "s");
}

describe("the composer is the only full-rule policy writer", () => {
  it("issues no policy create or patch call outside the policy path and the frozen provider boundary", () => {
    // Exactly one file outside `src/wallet/policy/**` and `src/wallet/signer/**`
    // reaches a policy writer: the provider adapter that implements the
    // composer's `PrivyPolicyAdminClient` port. It forwards the rules it is
    // handed and derives none, and the grant path that used to drive it now
    // delegates to the composer and refuses (`privy-policy-runtime.ts:171-206`).
    // Any SECOND creator or PATCHer — the regression this guard exists for —
    // changes the measured set and fails this case.
    expect(
      filesOutsidePolicyPath(/\.(createPolicy|patchPolicy)\(/),
      "a policy create/patch call appeared outside the policy path",
    ).toEqual(["src/wallet/grants/privy-policy-runtime.ts"]);
  });

  it("attaches a policy only through the frozen boundary set", () => {
    // `attachPolicyToSigner`/`addPolicyToSigner` is the narrow complete-list
    // mutation design §5.7 keeps; it binds an EXISTING policy id and composes
    // no rule set. The three files below are the provider implementation, the
    // adapter, and the enrollment completion attach of the applied policy id.
    // A fourth attach site fails this case.
    expect(
      filesOutsidePolicyPath(/\.(addPolicyToSigner|attachPolicyToSigner)\(/),
      "a new policy attach site appeared outside the policy path",
    ).toEqual([
      "src/wallet/embedded.ts",
      "src/wallet/grants/privy-policy-admin.ts",
      "src/wallet/grants/privy-policy-runtime.ts",
    ]);
  });

  it("builds the delegated-grant rules in one module only", () => {
    // The grant rule builder is re-exported from `composer.ts` and mentioned
    // nowhere else in `src/`: a second importer would be the second full-rule
    // writer (design §3.3).
    expect(
      mentions(/\bcomposeGrantRules\b/),
      "composeGrantRules is referenced outside its definition and the composer",
    ).toEqual([
      "src/wallet/grants/solana-policy-provisioner.ts",
      "src/wallet/policy/composer.ts",
    ]);
  });

  it("builds the ordinary enrollment rule in the composer only", () => {
    // Design §3.3 row 1: `buildSolanaEnrollmentRules` is "moved behind
    // `composer.ts` and is no longer imported by `embedded.ts`".
    expect(
      mentions(/\bbuildSolanaEnrollmentRules\b/),
      "buildSolanaEnrollmentRules is referenced outside its definition and the composer",
    ).toEqual([
      "src/wallet/grants/solana-enrollment-rules.ts",
      "src/wallet/policy/composer.ts",
    ]);
  });

  it("deletes the legacy writer so no module can construct it", async () => {
    const provisioner = (await import(
      "../../src/wallet/grants/solana-policy-provisioner.js"
    )) as Record<string, unknown>;

    // The deleted entry points cannot be re-exported without failing here.
    expect(Object.keys(provisioner)).not.toContain(
      "createSolanaGrantPolicyProvisioner",
    );
    expect(Object.keys(provisioner)).not.toContain("provisionPolicy");
    expect(Object.keys(provisioner)).not.toContain("revokePolicyRules");
    // Positive control: the module still exports the pure builder, so this case
    // is not passing because the import resolved to nothing.
    expect(Object.keys(provisioner)).toContain("composeGrantRules");
  });
});

describe("ContactsRepository mutations stay behind the policy path and its HTTP vertical", () => {
  it("is imported by the composition root and the contacts route only", () => {
    // `src/server.ts` constructs the repository for the HTTP wiring (no
    // mutation of its own); `src/api/contacts.ts` is the pre-existing contacts
    // vertical design §3.3 leaves in place. A third importer — including any
    // module under `src/wallet/policy/**` — fails this case.
    expect(
      mentions(importsSymbol("ContactsRepository")),
      "ContactsRepository gained a new importer",
    ).toEqual([
      "src/api/contacts.ts",
      "src/server.ts",
    ]);
  });

  it("is not imported anywhere under the policy path", () => {
    const importedUnderPolicyPath = sourceFiles()
      .filter((file) => file.path.startsWith(POLICY_PATH))
      .filter((file) => importsSymbol("ContactsRepository").test(file.source))
      .map((file) => file.path);

    expect(importedUnderPolicyPath).toEqual([]);
  });

  it("mutates contacts only from the policy service and the contacts route", () => {
    // The contact mutation port the service holds is injected; the only
    // mutation call sites are the service's own write paths and the contacts
    // HTTP vertical. A mutation call from any other module fails this case.
    expect(
      mentions(/contacts\.(create|update|archive)\(/).filter(
        (path) =>
          !path.startsWith(POLICY_PATH) &&
          path !== "src/api/contacts.ts",
      ),
      "a contact mutation call site appeared outside the policy path and the contacts route",
    ).toEqual([]);
  });

  it("lets the composition root wire the repository without mutating it", () => {
    const server = sourceFiles().find((file) => file.path === "src/server.ts");
    expect(server, "src/server.ts must exist").toBeDefined();

    // Positive control first: the wiring is there, so the negative below is not
    // passing because the file changed shape.
    expect(server!.source).toContain("new ContactsRepository(");
    expect(server!.source).not.toMatch(/contacts\.(create|update|archive)\(/);
  });
});
