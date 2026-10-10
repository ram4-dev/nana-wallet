/**
 * Task 1.9 — the declarative lock-order vector (design §1.2/§1.3/§1.7).
 *
 * WHY THIS IS A SOURCE TEST AND NOT A UNIT TEST OF A FUNCTION
 * -----------------------------------------------------------
 * The invariant is **positional**: it is not "does the claim read the state
 * row" but "is that read taken BEFORE the grant locks". No runtime assertion can
 * state that, because a correctly-written path and a cycle-forming path behave
 * IDENTICALLY until two transactions happen to interleave — that is what a
 * deadlock is. The only mechanical place the invariant can be checked is the
 * source, and `docs/architecture.md` §"Wallet policy lock order" is the human
 * half of the same guard.
 *
 * WHAT IT PROTECTS
 * ----------------
 *   1. The canonical vector `W1 → W0 → L1 → L2 → L3 → L4 → L5 → R` is exactly
 *      the documented one (a reordering of the vector itself fails here).
 *   2. Every writer's declared chain is a subsequence of that vector, so a chain
 *      that skips forwards is legal and one that goes backwards is not.
 *   3. The declared chains MATCH the source: each method body is scanned for the
 *      real lock-acquisition shapes and the slots found, in source order, must be
 *      non-decreasing under the canonical vector and equal to the declaration.
 *      A future writer that takes a lower-numbered lock after a higher-numbered
 *      one therefore fails BOTH the monotonicity check and the declaration.
 *   4. `W0` is the FIRST lock the claim path takes, before its advisory `L1`.
 *      That single position is the fix this task installs; moving the read below
 *      the advisory lock turns the claim path back into the second half of the
 *      apply/claim cycle, and this file says so at the exact line.
 *   5. `LX` (`nana-wallet-sync:<userId>`) stays a separate, user-scoped order and
 *      is never nested with `W1..L5`.
 *
 * HONESTY ABOUT THE SCAN
 * ----------------------
 * The scan reads the shapes the writers really use — the repository calls
 * (`lockPolicyState`, `lockActiveAliases`), the advisory keys (`dgc-grant-`,
 * `dgc-wallet-`) and the inline SQL (`FROM … FOR UPDATE`, `FOR SHARE`). A method
 * that opens a transaction elsewhere declares that call as an `inline` expansion
 * so the scan sees the true acquisition order rather than the call site. The
 * declared chains are written down explicitly instead of being derived from the
 * scan, so the assertions cannot be satisfied by construction.
 *
 * The chains are deliberately narrower than design §1.3 where the code is: this
 * suite asserts what the code DOES, and the deviations it found are named in the
 * per-case comments rather than smoothed over.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The canonical order, verbatim from `docs/architecture.md`. */
const CANONICAL = ["W1", "W0", "L1", "L2", "L3", "L4", "L5", "R"] as const;

type Slot = (typeof CANONICAL)[number];

const rank = (slot: Slot): number => CANONICAL.indexOf(slot);

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/**
 * One method body, from its signature up to the next class member. Every method
 * in these modules is a class member at two-space indentation, so the next
 * member signature is a reliable terminator (a nested arrow function's body is
 * indented further, and no `\n  public|private|protected` sequence occurs
 * inside one).
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`lock-order scan: signature not found: ${signature}`);
  }
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:public|private|protected) /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

/**
 * The lock shapes the writers actually use. `L1` and `L4` are distinguished by
 * their advisory KEY, not by the call: the key is what serializes two writers,
 * and a wrong key would be a silent no-op that a call-shaped marker would report
 * as a correct lock.
 */
const SLOT_MARKERS: ReadonlyArray<{ slot: Slot; pattern: RegExp }> = [
  { slot: "W1", pattern: /acquirePolicyLease\s*\(/g },
  { slot: "W0", pattern: /lockPolicyState\s*\(/g },
  {
    slot: "W0",
    pattern: /from\s+recipient_policy_state[\s\S]{0,600}?for\s+share/gi,
  },
  // The service layer takes `L1`/`L2` through the repository, so the call is
  // the acquisition there; the repository itself takes them as SQL below.
  { slot: "L1", pattern: /lockGrantAdvisoryKeys\s*\(/g },
  { slot: "L2", pattern: /lockAffectedGrants\s*\(/g },
  {
    slot: "L1",
    pattern: /pg_advisory_xact_lock\(\s*hashtext\(\$1\)\s*\)`[\s\S]{0,120}?dgc-grant-/g,
  },
  {
    slot: "L4",
    pattern: /pg_advisory_xact_lock\(\s*hashtext\(\$1\)\s*\)`[\s\S]{0,120}?dgc-wallet-/g,
  },
  {
    slot: "L2",
    pattern:
      /from\s+delegated_grants[\s\S]{0,500}?for\s+update|update\s+delegated_grants[\s\S]{0,400}?returning/gi,
  },
  {
    slot: "L3",
    pattern:
      /lockActiveAliases\s*\(|from\s+recipients[\s\S]{0,500}?for\s+update|update\s+recipients[\s\S]{0,400}?returning/gi,
  },
];

/** Slots found in one expanded body, in source order. */
function scanSlots(body: string): Slot[] {
  const found: { index: number; slot: Slot }[] = [];
  for (const { slot, pattern } of SLOT_MARKERS) {
    for (const match of body.matchAll(pattern)) {
      found.push({ index: match.index ?? 0, slot });
    }
  }
  found.sort((left, right) => left.index - right.index);
  // Collapse consecutive repeats: a slot taken twice in a row is still one step.
  return found
    .map((entry) => entry.slot)
    .filter((slot, index, all) => index === 0 || slot !== all[index - 1]);
}

interface Chain {
  /** The writer, as design §1.3 names it. */
  writer: string;
  file: string;
  /** Method signatures read in chain order (a chain may cross a tx boundary). */
  methods: string[];
  /** A call expanded in place, so the scan sees the real acquisition order. */
  inline?: { call: string; method: string };
  /** The locks this writer takes, in order. */
  declared: Slot[];
  /** True while the module that owns this chain does not exist yet. */
  pending?: boolean;
}

const CHAINS: readonly Chain[] = [
  {
    writer: "claim",
    file: "src/wallet/grants/consumption.ts",
    methods: ["public async claimConsumption("],
    declared: ["W0", "L1", "L2"],
  },
  {
    writer: "client revoke",
    file: "src/wallet/grants/consumption.ts",
    methods: ["public async revokeGrant("],
    declared: ["L1", "L2"],
  },
  {
    // Design §1.3 says `settle/revoke: L1 → L2 → L5`. The setter CASes
    // `conversation_transfer_attempts`, NOT `delegated_grants`, so it really
    // takes only `L1`. Recorded as measured, not as designed.
    writer: "settle",
    file: "src/wallet/grants/consumption.ts",
    methods: ["public async settleGrantReservation("],
    declared: ["L1"],
  },
  {
    // Design §1.1 lists `getGrant` as taking the advisory lock and the grant
    // row. It takes neither: it is a plain RLS-scoped read. An empty chain is
    // the honest declaration, and it is asserted so a future edit that adds a
    // lock here has to declare its position instead of drifting.
    writer: "getGrant (read only)",
    file: "src/wallet/grants/consumption.ts",
    methods: ["public async getGrant("],
    declared: [],
  },
  {
    writer: "grant sync",
    file: "src/wallet/grants/privy-policy-sync.ts",
    methods: ["public async syncGrant("],
    inline: { call: "this.lockedGrant(", method: "private async lockedGrant(" },
    declared: ["L1", "L2", "L4"],
  },
  {
    writer: "grant revocation sync",
    file: "src/wallet/grants/privy-policy-sync.ts",
    methods: ["public async syncRevocation("],
    inline: { call: "this.lockedGrant(", method: "private async lockedGrant(" },
    declared: ["L1", "L2", "L4"],
  },
  {
    writer: "removal",
    file: "src/wallet/policy/service.ts",
    methods: ["public async remove("],
    inline: {
      call: "this.applyRemoval(",
      method: "private async applyRemoval(",
    },
    declared: ["W1", "W0", "L1", "L2", "L3"],
  },
  {
    writer: "create/edit mutation",
    file: "src/wallet/policy/service.ts",
    methods: ["private async runMutation("],
    declared: ["W0"],
  },
  {
    writer: "enrollment intent",
    file: "src/wallet/policy/service.ts",
    methods: ["public async recordEnrollmentIntent("],
    declared: ["W0"],
  },
  {
    writer: "contact update",
    file: "src/memory/contacts-repository.ts",
    methods: ["public async update("],
    declared: ["L3"],
  },
  {
    writer: "contact archive",
    file: "src/memory/contacts-repository.ts",
    methods: ["public async archive("],
    declared: ["L3"],
  },
  {
    writer: "apply/reconciler",
    file: "src/wallet/policy/service.ts",
    methods: [],
    declared: ["W1", "W0", "L2"],
    pending: true,
  },
];

/** The expanded body of one chain: the declared methods, with `inline` spliced. */
function chainBody(source: string, chain: Chain): string {
  const inlineBody = chain.inline
    ? methodBody(source, chain.inline.method)
    : "";
  const parts = chain.methods.map((signature) => {
    const body = methodBody(source, signature);
    return chain.inline ? body.split(chain.inline.call).join(inlineBody) : body;
  });
  return parts.join("\n");
}

describe("canonical wallet policy lock order (task 1.9)", () => {
  it("declares exactly the documented canonical vector", () => {
    expect([...CANONICAL]).toEqual([
      "W1",
      "W0",
      "L1",
      "L2",
      "L3",
      "L4",
      "L5",
      "R",
    ]);
    // Positive control: the same vector the documentation ships with, read from
    // the file, so the test and the doc cannot drift apart.
    const doc = repoFile("docs/architecture.md");
    const section = doc.slice(doc.indexOf("## Wallet policy lock order"));
    expect(section.length).toBeGreaterThan(0);
    for (const slot of CANONICAL) {
      expect(section).toContain(slot);
    }
    expect(section).toContain("W1 → W0 → L1 → L2 → L3 → L4 → L5 → R");
    expect(section).toContain("W1 → LX → W0 → L1 → L2 → L3 → L4 → L5");
  });

  it("keeps every declared chain a subsequence of the canonical vector", () => {
    for (const chain of CHAINS) {
      const ranks = chain.declared.map(rank);
      expect(ranks, `${chain.writer} declares an unknown slot`).not.toContain(-1);
      const sorted = [...ranks].sort((left, right) => left - right);
      expect(ranks, `${chain.writer} declares a backward chain`).toEqual(sorted);
    }
  });

  for (const chain of CHAINS.filter((entry) => !entry.pending)) {
    it(`matches ${chain.writer} against its module's real acquisition order`, () => {
      const source = repoFile(chain.file);
      const body = chainBody(source, chain);

      // Positive control: the scan is reading the chain it claims to read. When
      // the chain declares locks, the body must be large enough to hold them and
      // the first declared slot must be present at all.
      expect(body.length, `${chain.writer} body not found`).toBeGreaterThan(
        100,
      );

      const observed = scanSlots(body);
      if (chain.declared.length > 0) {
        expect(
          observed,
          `${chain.writer} takes no declared lock`,
        ).toContain(chain.declared[0]);
      }

      // (1) Monotonic. Going backwards is the deadlock the order exists to
      // prevent, so this is the assertion a future writer trips.
      const ranks = observed.map(rank);
      expect(ranks, `${chain.writer} takes a lower lock after a higher one`).toEqual(
        [...ranks].sort((left, right) => left - right),
      );

      // (2) The declaration equals the measurement, so the declaration cannot
      // quietly become fiction.
      expect(observed, `${chain.writer} chain drift`).toEqual(chain.declared);
    });
  }

  it("opens the claim path with W0, before its advisory L1", () => {
    const source = repoFile("src/wallet/grants/consumption.ts");
    const body = methodBody(source, "public async claimConsumption(");

    const w0 = body.search(
      /from\s+recipient_policy_state[\s\S]{0,600}?for\s+share/i,
    );
    const advisory = body.indexOf("pg_advisory_xact_lock");
    const grantRowLock = body.search(
      /from\s+delegated_grants[\s\S]{0,500}?for\s+update/i,
    );

    // Positive controls: all three positions exist. A `-1` here would make the
    // ordering assertions below vacuously true.
    expect(w0).toBeGreaterThanOrEqual(0);
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(grantRowLock).toBeGreaterThanOrEqual(0);

    expect(w0).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(grantRowLock);
  });

  it("takes the claim's W0 read in FOR SHARE, never FOR UPDATE", () => {
    const source = repoFile("src/wallet/grants/consumption.ts");
    const body = methodBody(source, "public async claimConsumption(");
    const start = body.search(/from\s+recipient_policy_state/i);
    expect(start).toBeGreaterThanOrEqual(0);
    // The FOR clause is searched AFTER the FROM clause: the statement's own
    // explanatory comment above it also names `FOR SHARE`.
    const end = start + body.slice(start).search(/for\s+(share|update)/i);
    expect(end).toBeGreaterThan(start);
    const statement = body.slice(start, end + 20);
    expect(statement).toMatch(/for\s+share of state/i);
    expect(statement).not.toMatch(/for\s+update/i);
  });

  it("keeps the removal's W1 outside the transaction and before W0", () => {
    const source = repoFile("src/wallet/policy/service.ts");
    const remove = methodBody(source, "public async remove(");
    const lease = remove.indexOf("acquirePolicyLease(");
    // The LAST `withUserTransaction` in `remove` is the one wrapping
    // `applyRemoval`; the earlier one is the no-ready-wallet early branch.
    const transaction = remove.lastIndexOf(
      "this.database.withUserTransaction(",
    );
    const applyRemoval = methodBody(source, "private async applyRemoval(");

    expect(lease).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThanOrEqual(0);
    // W1 is taken outside the transaction, so it is never held while the
    // transaction's own locks are held — and never across provider I/O.
    expect(lease).toBeLessThan(transaction);
    expect(applyRemoval.indexOf("lockPolicyState(")).toBeGreaterThanOrEqual(0);
    expect(applyRemoval.indexOf("lockGrantAdvisoryKeys(")).toBeGreaterThan(
      applyRemoval.indexOf("lockPolicyState("),
    );
  });

  it("shares one advisory key between the claim and the removal L1 slot", () => {
    // If the two paths used different keys they would not serialize at all, and
    // the claim ‖ removal case would pass while proving nothing.
    const claim = repoFile("src/wallet/grants/consumption.ts");
    const repository = repoFile("src/wallet/policy/repository.ts");
    expect(claim).toContain("`dgc-grant-${input.grantId}`");
    expect(repository).toContain("`dgc-grant-${grantId}`");
  });

  it("keeps LX a separate user-scoped order, nested with no W/L slot", () => {
    const sources = [
      "src/wallet/embedded.ts",
      "src/wallet/grants/consumption.ts",
      "src/wallet/grants/privy-policy-sync.ts",
      "src/wallet/policy/service.ts",
      "src/wallet/policy/repository.ts",
    ];
    const holders = sources.filter((file) =>
      repoFile(file).includes("nana-wallet-sync"),
    );
    // Positive control: the wallet sync path uses LX and still exists.
    expect(holders).toEqual(["src/wallet/embedded.ts"]);

    // The wallet sync path touches no grant and no recipient row, which is why
    // the two orders never meet. If that ever changes, this assertion fails and
    // the `W1 → LX → W0 → …` rule has to be installed for real.
    const walletSync = repoFile("src/wallet/embedded.ts");
    const lockWalletSync = methodBody(walletSync, "private async lockWalletSync(");
    expect(lockWalletSync).toContain("nana-wallet-sync");
    expect(scanSlots(lockWalletSync)).toEqual([]);
  });
});
