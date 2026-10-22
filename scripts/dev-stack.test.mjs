import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureBindingPair, normalizeAuthorizationKey, parseProjectRef, readLinkedSupabaseMetadata, remoteDatabaseUrl, requiredVaultKeys, validateInfrastructureHealth, verifySupabaseTarget } from "./dev-stack.mjs";

test("normaliza el prefijo wallet-auth", () => {
  assert.equal(normalizeAuthorizationKey(" wallet-auth:abc123 "), "abc123");
  assert.equal(normalizeAuthorizationKey("abc123"), "abc123");
});

test("acepta solamente el ref del proyecto Supabase", () => {
  assert.equal(parseProjectRef("https://jnhemqouecznsziytzhm.supabase.co"), "jnhemqouecznsziytzhm");
  assert.throws(() => parseProjectRef("https://nana-landing.example.com"), /NANA_SUPABASE_URL/);
});

test("compone un pooler remoto SSL", () => {
  const url = remoteDatabaseUrl("postgresql://postgres.jnhemqouecznsziytzhm@aws-0-us-east-1.pooler.supabase.com:5432/postgres", "synthetic password", "jnhemqouecznsziytzhm");
  assert.match(url, /sslmode=verify-full/);
  assert.equal(new URL(url).searchParams.get("sslrootcert"), "/run/certs/supabase-ca.crt");
  assert.match(url, /pooler\.supabase\.com/);
  assert.throws(() => remoteDatabaseUrl("postgresql://postgres@localhost/postgres", "secret", "jnhemqouecznsziytzhm"), /pooler remoto/);
});

test("rechaza metadata y URL de Supabase que no coinciden", () => {
  assert.throws(() => verifySupabaseTarget({ NANA_SUPABASE_URL: "https://jnhemqouecznsziytzhm.supabase.co", SUPABASE_PASSWORD_NANA_WALLET: "synthetic" }, { ref: "aaaaaaaaaaaaaaaaaaaa", poolerUrl: "postgresql://postgres.jnhemqouecznsziytzhm@aws-0-us-east-1.pooler.supabase.com:5432/postgres" }), /no coincide/);
});

test("rechaza un usuario de pooler parecido al ref y credenciales guardadas en metadata", () => {
  const ref = "aaaaaaaaaaaaaaaaaaaa";
  for (const user of [`postgres.${ref}-other`, `other.${ref}`]) {
    assert.throws(() => remoteDatabaseUrl(`postgresql://${user}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, "synthetic", ref), /no coincide/);
  }
  assert.throws(() => remoteDatabaseUrl(`postgresql://postgres.${ref}:old-secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, "synthetic", ref), /no coincide/);
});

test("lee metadata desde un checkout común", () => {
  const root = mkdtempSync(join(tmpdir(), "nana-stack-meta-"));
  try {
    const common = join(root, "common");
    mkdirSync(join(common, "supabase/.temp"), { recursive: true });
    writeFileSync(join(common, "supabase/.temp/project-ref"), "jnhemqouecznsziytzhm\n");
    writeFileSync(join(common, "supabase/.temp/pooler-url"), "postgresql://postgres.jnhemqouecznsziytzhm@aws-0-us-east-1.pooler.supabase.com:5432/postgres\n");
    assert.equal(readLinkedSupabaseMetadata(join(root, "worktree"), common).ref, "jnhemqouecznsziytzhm");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retiene el par de binding Ed25519 en archivos restringidos", () => {
  const state = mkdtempSync(join(tmpdir(), "nana-stack-binding-"));
  try {
    const first = ensureBindingPair(state);
    const second = ensureBindingPair(state);
    assert.equal(first.privateKey, second.privateKey);
    assert.match(first.publicKey, /BEGIN PUBLIC KEY/);
    assert.equal(statSync(join(state, "live-binding-private.pem")).mode & 0o777, 0o600);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("declara las credenciales requeridas para Vault", () => {
  assert.deepEqual(requiredVaultKeys.slice(0, 3), ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_AUTHORIZATION_PRIVATE_KEY"]);
  assert.ok(requiredVaultKeys.includes("SUPABASE_PASSWORD_NANA_WALLET"));
});

test("acepta la degradación por usuario de Privy y exige signer verificado", () => {
  const health = { mode: "live", network: "solana-devnet", provider: { status: "degraded", reason: "Privy wallet health is evaluated per authenticated user." }, policySigner: { capable: true, code: "verified" } };
  assert.doesNotThrow(() => validateInfrastructureHealth(health));
  assert.throws(() => validateInfrastructureHealth({ ...health, policySigner: { capable: false, code: "signer_unavailable" } }), /sidecar firmante/);
});
