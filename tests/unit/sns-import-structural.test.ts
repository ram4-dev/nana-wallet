import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Task 1.5 (design S1, S18, §9): the SDK is confined to one module, and nothing
 * on the payment path (transfer, preview, compose) can resolve a name.
 */
const SDK = "@bonfida/spl-name-service";
const TRANSPORT = "src/wallet/sns/transport.ts";

function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function sourceFiles(relativeDir: string): string[] {
  const absolute = `${repoRoot()}${relativeDir}`;
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(child));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(child);
    }
  }
  return found;
}

function repoFile(relativePath: string): string {
  return readFileSync(`${repoRoot()}${relativePath}`, "utf8");
}

/** A real import/require of a bare module specifier, not a mention in a comment. */
function importsModule(source: string, moduleName: string): boolean {
  const specifier = moduleName.replace(/[/@.]/g, "\\$&");
  return new RegExp(`(?:from|require\\()\\s*["']${specifier}["']`).test(source);
}

const SRC_FILES = sourceFiles("src");

describe("the SNS SDK is confined to one module", () => {
  it("collects the source tree (so the assertions below are not vacuous)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES).toContain(TRANSPORT);
    expect(SRC_FILES).toContain("src/wallet/policy/composer.ts");
    expect(SRC_FILES).toContain("src/memory/address.ts");
  });

  it("is imported by exactly one module, the transport", () => {
    const importers = SRC_FILES.filter((file) => importsModule(repoFile(file), SDK));
    // Positive control: the detector finds the one importer it expects, so an
    // empty list here would be a detector failure, not a clean tree.
    expect(importers).toEqual([TRANSPORT]);
    expect(importsModule(repoFile(TRANSPORT), SDK)).toBe(true);
    expect(repoFile(TRANSPORT)).toContain("devnet");
  });

  it("is not mentioned by the resolver, which owns no SDK and no RPC client", () => {
    const resolver = repoFile("src/wallet/sns/resolver.ts");
    expect(resolver).toContain("SnsTransport");
    expect(resolver).not.toContain(SDK);
    expect(resolver).not.toContain("@solana/web3.js");
    // No RPC client either: the resolver only orchestrates the injected port.
    expect(resolver).not.toContain("new Connection(");
  });

  it("adds no second SNS stack", () => {
    const packageJson = repoFile("package.json");
    expect(packageJson).toContain(`"${SDK}": "3.0.23"`);
    expect(packageJson).not.toContain("sns-sdk-kit");
  });
});

describe("no payment path can reach the resolver", () => {
  const PAYMENT_PATHS = [
    "src/wallet/policy/composer.ts",
    ...sourceFiles("src/conversations"),
    ...sourceFiles("src/wallet/grants"),
  ];

  it("collects the payment path (so the assertions below are not vacuous)", () => {
    expect(PAYMENT_PATHS.length).toBeGreaterThan(10);
    expect(PAYMENT_PATHS).toContain("src/wallet/policy/composer.ts");
    // The detector is live: it finds a real import in a file it did not create,
    // and reports absence for a package that file does not use.
    const addressModule = repoFile("src/memory/address.ts");
    expect(importsModule(addressModule, "@solana/web3.js")).toBe(true);
    expect(importsModule(addressModule, SDK)).toBe(false);
    expect(PAYMENT_PATHS.some((file) => repoFile(file).includes('from "'))).toBe(true);
  });

  it("imports neither the resolver nor its transport", () => {
    const offenders = PAYMENT_PATHS.filter((file) => /(?:from|require\()\s*["'][^"']*wallet\/sns/.test(repoFile(file)));
    expect(offenders).toEqual([]);
  });

  it("never imports the SDK directly either", () => {
    const offenders = PAYMENT_PATHS.filter((file) => importsModule(repoFile(file), SDK));
    expect(offenders).toEqual([]);
  });
});
