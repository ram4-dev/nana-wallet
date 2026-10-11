/**
 * Task 7.3 — the structural proof that no payment path can read a name or drift.
 *
 * WHY THIS IS STRUCTURAL AND NOT A BEHAVIOUR TEST
 * ----------------------------------------------
 * The property is a *negative over the whole payment surface*: "nothing on the
 * transfer, preview or compose path reads `provenance.drift` or resolves a name".
 * A behaviour test can only ever exercise the paths someone thought to write
 * down, and the failure mode here is precisely a path nobody thought about —
 * `resolveName` being reintroduced at preview time "just to be safe".
 *
 * The stakes are not stylistic. `sophie.sns` is controlled by whoever holds it:
 *
 *   * if a payment path re-resolved the name, the destination would be mutable by
 *     a stranger AFTER consent — the user would consent to a label, not an address;
 *   * if a payment path FAILED on drift, that same stranger would hold a
 *     denial-of-service lever over the user's own money — transfer the name and
 *     every payment to the trusted stored address stops.
 *
 * So the guard is checked where it cannot be forgotten: over the file set, with
 * the same shape as `tests/unit/signer-worker-path.test.ts` uses for the signing
 * key. `composer.ts` builds the allowlist from `recipients.address`; the alias is
 * a label in `provenance` that the money path never opens.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function repoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/**
 * The source with its comments removed. The drift guard is about what a module
 * READS, and a doc comment that explains the drift record (the service does) is
 * documentation, not a read. Without this, the guard would fail on prose and a
 * future author would weaken the assertion instead of the comment.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts` file under `dir`, repo-relative, sorted — walked, never hand-listed. */
function sourceFiles(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir);
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) found.push(relative(REPO_ROOT, path));
    }
  };
  walk(absolute);
  return found.sort();
}

/**
 * The transfer, preview and composition path. `src/conversations/**` and
 * `src/wallet/grants/**` are walked rather than listed so a NEW file in either
 * tree is covered the day it lands — the guard cannot be outgrown by adding a
 * module.
 */
const PAYMENT_PATH_FILES: string[] = [
  "src/wallet/policy/composer.ts",
  "src/wallet/policy/apply.ts",
  "src/wallet/policy/readback.ts",
  "src/wallet/policy/contact-actions.ts",
  "src/api/conversations.ts",
  "src/agent/wdk-tools.ts",
  "src/agent/deterministic-intent.ts",
  "src/agent/recipient-resolution.ts",
  "src/agent/recipient-intent.ts",
  "src/agent/wallet-agent.ts",
  ...sourceFiles("src/conversations"),
  ...sourceFiles("src/wallet/grants"),
];

/** A name is resolved ONLY through the resolver module; no payment file may reach it. */
const RESOLVER_IMPORT = /from\s+["'][^"']*(?:wallet\/sns|\/sns\/|\.\.\/sns\/)[^"']*["']/;
/** The drift key, in every spelling that reads it: JSONB arrow, dot access, jsonb_set path. */
const DRIFT_KEY_READ =
  /provenance(?:\.drift|->>?'drift'|->'drift')|jsonb_set\(\s*provenance\s*,\s*'\{drift\}'|\bdrift\s*:\s*\{/;
/**
 * A resolver-shaped call, by receiver NAME (`resolver.x.resolve(`, `aliases.resolve(`).
 * `Promise.resolve(`, `source.resolve(request)` and `require.resolve(...)` are not
 * resolver calls and must not be dragged into the exhaustion list below.
 *
 * The payment-path ban uses the WIDER `ANY_METHOD_CALL` instead, so a renamed
 * resolver object cannot slip past it: on a path that must not resolve anything,
 * every `.resolve(` is suspect; in the global caller list only the real resolver
 * seams are relevant.
 */
const RESOLVER_CALL = /\b(?:resolver|aliases)\s*\.\s*(?:resolve|reverseLookup)\s*\(/;

/** Any method call that would mean "look this name up", minus `Promise.resolve`. */
const ANY_METHOD_CALL = /(?<!Promise)\.(?:resolve|reverseLookup)\s*\(/;

/** The drift key as a PERSISTED-ROW read: the JSONB arrow, the dot access, the jsonb path. */
const DRIFT_ROW_READ = /provenance(?:\.drift|->>?'drift')|'\{drift\}'/;

describe("no payment path can resolve a name or read drift (task 7.3)", () => {
  it("positive control: the three detectors actually fire on a violating source", () => {
    // Without this, a typo in a regex turns every assertion below into a no-op and
    // the suite stays green forever. Each sample is the exact shape each detector
    // exists to catch.
    expect(RESOLVER_IMPORT.test(`import { x } from "../wallet/sns/resolver.js";`)).toBe(true);
    expect(DRIFT_KEY_READ.test("SELECT provenance->>'drift' FROM recipients")).toBe(true);
    expect(DRIFT_KEY_READ.test("row.provenance.drift")).toBe(true);
    expect(DRIFT_KEY_READ.test("jsonb_set(provenance, '{drift}', $1::jsonb, true)")).toBe(true);
    expect(RESOLVER_CALL.test("await resolver.resolve(name)")).toBe(true);
    expect(RESOLVER_CALL.test("await dependencies.resolver.resolve(name)")).toBe(true);
    expect(RESOLVER_CALL.test("await this.aliases.reverseLookup(address)")).toBe(true);

    // ...and that they do NOT fire on the benign shapes they would otherwise
    // confuse: the composer's own membership provenance, and the three
    // `.resolve(` calls in this repo that are NOT name resolution.
    expect(RESOLVER_CALL.test("let inFlight = Promise.resolve(input.run())")).toBe(false);
    expect(RESOLVER_CALL.test("const { userId } = await source.resolve(request)")).toBe(false);
    expect(RESOLVER_CALL.test("require.resolve('@tetherto/wdk-cli/bin/wdk-mcp.mjs')")).toBe(false);
    expect(DRIFT_KEY_READ.test("provenance[address] = 'grant'")).toBe(false);
    expect(RESOLVER_IMPORT.test(`import { policy } from "./composer.js";`)).toBe(false);
  });

  it("no payment-path file imports the resolver module", () => {
    expect(PAYMENT_PATH_FILES.length).toBeGreaterThan(20);
    for (const relativePath of PAYMENT_PATH_FILES) {
      const source = repoFile(relativePath);
      expect(RESOLVER_IMPORT.test(source), relativePath).toBe(false);
      expect(/SnsResolver|createSnsResolver|sns-sdk/i.test(source), relativePath).toBe(false);
    }
  });

  it("no payment-path file reads the drift key", () => {
    for (const relativePath of PAYMENT_PATH_FILES) {
      expect(DRIFT_KEY_READ.test(withoutComments(repoFile(relativePath))), relativePath).toBe(
        false,
      );
    }

    // The drift key is READ as a persisted row in exactly one module: the guarded
    // write in the memory repository. If a read ever appears elsewhere, this pin
    // is the alarm.
    const readers = sourceFiles("src")
      .concat(sourceFiles("apps/nana-wallet/src"))
      .filter((path) => DRIFT_ROW_READ.test(withoutComments(repoFile(path))));
    expect(readers).toEqual(["src/memory/contacts-repository.ts"]);

    // The service WRITES the record through the port; it never reads it back.
    expect(withoutComments(repoFile("src/wallet/policy/service.ts"))).not.toMatch(
      /provenance\.drift/,
    );
  });

  it("no payment-path file can resolve a name, and the resolver's callers are exactly the alias sites", () => {
    for (const relativePath of PAYMENT_PATH_FILES) {
      // The WIDER pattern here on purpose: this path must not resolve anything at
      // all, whatever the receiver happens to be named.
      expect(ANY_METHOD_CALL.test(repoFile(relativePath)), relativePath).toBe(false);
    }

    // Exhaustion: outside the resolver module itself, only the four named alias
    // sites may call it — the side-effect-free resolve route, the create alias arm,
    // the drift check, and the worker's confirm-time `reverifyAlias`. A new caller
    // anywhere in `src/` fails `callers` below.
    const callers = sourceFiles("src")
      .filter((path) => !path.startsWith("src/wallet/sns/"))
      .filter((path) => RESOLVER_CALL.test(repoFile(path)))
      .sort();
    expect(callers).toEqual([
      "src/api/contacts.ts",
      "src/livekit/contact-proposal-publication.ts",
      "src/wallet/policy/service.ts",
    ]);

    // ...and each call is pinned where it is, so moving one elsewhere (or adding
    // another to the same file) is visible rather than absorbed. The caller
    // allowlist asserted just above is the property that actually protects the
    // payment surface — no NEW file may resolve a name — and it is deliberately
    // untouched by this pin's update.
    const callsIn = (path: string) =>
      (repoFile(path).match(new RegExp(RESOLVER_CALL, "g")) ?? []).length;
    expect(callsIn("src/api/contacts.ts")).toBe(1);
    expect(callsIn("src/wallet/policy/service.ts")).toBe(2);
    // Two sites, both inside the same already-sanctioned file: the confirm-time
    // re-verification (`createAliasReverifier`) and the stage-time resolution the
    // voice agent's contact tool needs (`createAliasResolver`). The second was
    // genuinely missing in production, so this is a count update for a reviewed
    // new seam — not a widened allowlist.
    expect(callsIn("src/livekit/contact-proposal-publication.ts")).toBe(2);
  });

  it("the composition path targets stored addresses, never a name", () => {
    const composer = repoFile("src/wallet/policy/composer.ts");
    // The allowlist is built from address rows; nothing here carries an alias.
    expect(composer).toContain("address");
    expect(composer).not.toMatch(/\b(snsName|resolvedAt|reverseDomain|drift)\b/);

    // `ComposedPolicy.provenance` is the MEMBERSHIP map (address -> origin) of
    // design §3.4, not the contact provenance. Both must stay distinct: the
    // composer may interpret membership and must never see where an address came
    // from beyond that.
    expect(composer).toMatch(/ComposedProvenance/);
    expect(composer).not.toMatch(/recipients\.provenance|provenance->>'name'/);
  });
});
