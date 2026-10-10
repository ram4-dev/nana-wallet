#!/usr/bin/env node
/**
 * Driver for `scripts/run-trusted-recipient-browser-e2e.mjs` (task 3.4, design §12.2).
 *
 * WHY THIS DRIVER EXISTS
 * ----------------------
 * Production identity is ALWAYS the Privy verifier: `buildServer()` needs
 * `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` and resolves a real user per request,
 * and the old `IDENTITY_PROVIDER=demo` switch was removed
 * (`src/server.ts`, `tests/fixtures/test-server.ts`). An out-of-process HTTP
 * harness therefore cannot authenticate without real credentials — which this
 * change never touches. This driver boots the REAL backend on a real port through
 * the repository's documented seam (`buildTestServer`, the same one the
 * integration suites use) against the REAL database, so the harness still drives
 * real HTTP + real Postgres + the real policy adapter, and the browser layer can
 * talk to it unauthenticated.
 *
 * THE POLICY TRANSPORT IS NEVER LIVE. `buildServer()` wires the recipient-policy
 * service with the `unavailable` apply port in this deployment (no signed
 * authorization capability is configured), so the composer records durable intent
 * and issues no PATCH: the honest readiness stays `pending` / `retryable_failure`
 * and never `applied`. That is the fake transport the harness runs over.
 *
 * PROTOCOL
 * --------
 *   E2E_DRIVER_READY {"url":…,"userId":…}      once the server is listening
 *   E2E_SCENARIO {"status":…,"name":…,"detail":…}   one line per scenario
 * The process keeps serving until SIGTERM/SIGINT, which is when it cleans up the
 * recipients it created and closes the server.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { buildTestServer, TEST_USER_ID } from "../tests/fixtures/test-server.js";

const BACKEND_PORT = Number(process.env.NANA_E2E_BACKEND_PORT ?? "3129");
const DB_CONTAINER = process.env.NANA_E2E_DB_CONTAINER ?? "colloseumfeat-solana-operational-db-1";
const DB_NAME = process.env.NANA_E2E_DB_NAME ?? "wdk_agent";
const DB_PORT = process.env.NANA_E2E_DB_PORT ?? "55470";

process.env.DATABASE_URL ??=
  `postgresql://postgres@127.0.0.1:${DB_PORT}/${DB_NAME}?options=-csearch_path%3Dpublic,extensions`;
process.env.WDK_TOOLS_SOURCE ??= "fixture";
process.env.RECIPIENT_POLICY_RECONCILER ??= "disabled";
// The browser layer runs on another origin and the backend's default CORS
// allowlist is narrow (`scripts/run-browser-e2e.mjs` records the same blocker),
// so the frontend origin is allowed explicitly. Defaults to the localhost pair.
const FRONTEND_PORT = process.env.NANA_E2E_FRONTEND_PORT ?? "5201";
process.env.CORS_ORIGINS ??= [
  process.env.NANA_E2E_FRONTEND_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`,
  `http://localhost:${FRONTEND_PORT}`,
]
  .map((origin) => new URL(origin).origin)
  .join(",");

const ADDRESS_1 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const NAME_1 = "E2E-TR Alias";
const NAME_2 = "E2E-TR Alias Dos";
const NAME_3 = "E2E-TR Editable";
const runId = randomUUID();
const key = (what: string) => `e2e-tr-${what}-${runId}`;
const BASE = `http://127.0.0.1:${BACKEND_PORT}`;

const ALL_STATES = [
  "saved_not_configured",
  "pending",
  "syncing",
  "applied",
  "retryable_failure",
  "blocked_conflict",
  "blocked_configuration",
] as const;

const KEY_MATERIAL = /secret|signature|token|appSecret|apiKey/i;

function report(status: "PASS" | "FAIL" | "BLOCKED", name: string, detail?: string): void {
  console.log(`E2E_SCENARIO ${JSON.stringify({ status, name, detail: detail ?? "" })}`);
}

function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      DB_NAME,
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

type Permission = {
  state: (typeof ALL_STATES)[number];
  desiredRevision: number;
  appliedRevision: number;
  retryable: boolean;
  reason?: string;
};

type Contact = {
  id: string;
  name: string;
  address: string;
  version: number;
  permission: Permission;
};

type Reply = { status: number; body: any };

async function call(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null);
  return { status: response.status, body: parsed };
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

/** The honesty rule the contract owes (design §4.1/§9.1/§9.2), asserted on what was served. */
function dishonest(permission: Permission | undefined): string | null {
  if (!permission || typeof permission !== "object") return "no permission object";
  if (!ALL_STATES.includes(permission.state)) return `unknown state ${String(permission.state)}`;
  if (permission.appliedRevision > permission.desiredRevision) {
    return `appliedRevision ${permission.appliedRevision} > desiredRevision ${permission.desiredRevision}`;
  }
  if (permission.state === "applied" && permission.appliedRevision !== permission.desiredRevision) {
    return "applied with appliedRevision !== desiredRevision";
  }
  const retryableExpected =
    permission.state === "pending" ||
    permission.state === "syncing" ||
    permission.state === "retryable_failure";
  if (permission.retryable !== retryableExpected) {
    return `retryable=${permission.retryable} for state ${permission.state}`;
  }
  return null;
}

async function scenarios(): Promise<void> {
  // Positive control: the harness is talking to a real authenticated API.
  const me = await call("GET", "/v1/me");
  const meUserId = me.body?.data?.userId ?? me.body?.userId;
  const meOk = me.status === 200 && meUserId === TEST_USER_ID;
  report(
    meOk ? "PASS" : "FAIL",
    "positive control: GET /v1/me resolves the fixture identity",
    meOk ? `userId=${TEST_USER_ID}` : `http=${me.status} body=${JSON.stringify(me.body)}`,
  );

  // create
  const created = await call(
    "POST",
    "/v1/contacts",
    { name: NAME_1, description: "", address: ADDRESS_1 },
    key("create"),
  );
  const contact1 = created.body?.data as Contact | undefined;
  const createProblem = dishonest(contact1?.permission);
  const createOk = created.status === 201 && createProblem === null;
  report(
    createOk ? "PASS" : "FAIL",
    "create: POST /v1/contacts persists the recipient with an honest permission snapshot",
    createOk
      ? `id=${contact1!.id} state=${contact1!.permission.state}`
      : `http=${created.status} problem=${createProblem ?? "no contact"} body=${JSON.stringify(created.body)}`,
  );

  const leaked = keysOf(created.body).filter((k) => KEY_MATERIAL.test(k));
  report(
    leaked.length === 0 ? "PASS" : "FAIL",
    "create: the served payload carries no key material",
    leaked.length === 0 ? "no secret|signature|token|appSecret|apiKey key" : leaked.join(","),
  );

  // The two extra contacts the later scenarios need (one is the second alias).
  const alias = await call(
    "POST",
    "/v1/contacts",
    { name: NAME_2, description: "", address: ADDRESS_1 },
    key("alias"),
  );
  const editable = await call(
    "POST",
    "/v1/contacts",
    { name: NAME_3, description: "", address: ADDRESS_1 },
    key("editable"),
  );

  // reload
  const reloaded = await call("GET", "/v1/contacts");
  const row = ((reloaded.body?.data ?? []) as Contact[]).find((c) => c.id === contact1?.id);
  const reloadOk =
    reloaded.status === 200 &&
    row?.permission?.state === contact1?.permission?.state &&
    dishonest(row?.permission) === null;
  report(
    reloadOk ? "PASS" : "FAIL",
    "reload: GET /v1/contacts observes the same permission.state",
    reloadOk
      ? `state=${row!.permission.state} (unchanged across the reload)`
      : `created=${contact1?.permission?.state} reloaded=${row?.permission?.state}`,
  );

  // retry
  const retry = await call("POST", "/v1/recipient-policy/retry", {}, key("retry"));
  const retried = retry.body?.data as Permission | undefined;
  const retryProblem = retried ? dishonest(retried) : null;
  const retryAccepted = [200, 202, 409, 503].includes(retry.status);
  report(
    retryAccepted && (retried === undefined || retryProblem === null) ? "PASS" : "FAIL",
    "retry: POST /v1/recipient-policy/retry answers honestly, never a fabricated applied",
    `http=${retry.status} state=${retried?.state ?? "n/a"} retryable=${retried?.retryable ?? "n/a"}${
      retryProblem ? ` problem=${retryProblem}` : ""
    }`,
  );
  report(
    retried === undefined || retried.retryable === true || retry.status === 409 ? "PASS" : "FAIL",
    "retry from retryable_failure: the deployment stays retryable instead of claiming success",
    `state=${retried?.state ?? "n/a"} reason=${retried?.reason ?? "n/a"}`,
  );

  // duplicate alias
  const aliasOk = alias.status === 201 && editable.status === 201;
  report(
    aliasOk ? "PASS" : "FAIL",
    "duplicate alias: a second recipient with the same address is accepted as a distinct alias",
    aliasOk
      ? `${alias.body.data.id} and ${editable.body.data.id} share one address`
      : `alias=${alias.status} editable=${editable.status} body=${JSON.stringify(alias.body)}`,
  );

  const editableContact = editable.body?.data as Contact | undefined;
  const aliasContact = alias.body?.data as Contact | undefined;
  const preview = await call(
    "GET",
    `/v1/contacts/${editableContact?.id}/removal-preview?expectedVersion=${editableContact?.version}&action=address_change`,
  );
  const previewOk =
    preview.status === 200 &&
    preview.body?.data?.lastAlias === false &&
    Array.isArray(preview.body?.data?.revokedGrantIds);
  report(
    previewOk ? "PASS" : "FAIL",
    "duplicate alias: the address-change pre-flight read reports the surviving alias (lastAlias=false)",
    previewOk
      ? `revokedGrantIds=${preview.body.data.revokedGrantIds.length} lastAlias=false`
      : `http=${preview.status} body=${JSON.stringify(preview.body)}`,
  );

  // edit: address replacement (the path the screen gates behind the disclosure)
  const edited = await call(
    "PATCH",
    `/v1/contacts/${editableContact?.id}`,
    {
      address: ADDRESS_2,
      expectedVersion: editableContact?.version,
      expectedPolicyRevision: editableContact?.permission?.desiredRevision,
    },
    key("edit"),
  );
  const editedContact = edited.body?.data as Contact | undefined;
  const editProblem = dishonest(editedContact?.permission);
  const editOk = edited.status === 200 && editedContact?.address === ADDRESS_2 && editProblem === null;
  report(
    editOk ? "PASS" : "FAIL",
    "edit: PATCH /v1/contacts/:id replaces the address and returns an honest permission",
    editOk
      ? `state=${editedContact!.permission.state} address=${ADDRESS_2.slice(0, 8)}…`
      : `http=${edited.status} problem=${editProblem ?? edited.body?.error?.code} body=${JSON.stringify(edited.body)}`,
  );

  // FINDING (reported, not hidden): the mirrored contract and the mirrored
  // frontend both send `expectedRevokedGrantIds` on an address replacement
  // (`src/contracts/http.ts` accepts it on PATCH "exactly as before this contract
  // mirror"), but the service's own strict schema rejects it with 422. The
  // disclosure-carrying body is therefore rejected end to end today; the harness
  // names the exact error instead of quietly dropping the field.
  const disclosureEdit = await call(
    "PATCH",
    `/v1/contacts/${aliasContact?.id}`,
    {
      address: ADDRESS_2,
      expectedVersion: aliasContact?.version,
      expectedPolicyRevision: aliasContact?.permission?.desiredRevision,
      expectedRevokedGrantIds: [],
    },
    key("edit-disclosure"),
  );
  const disclosureAccepted =
    disclosureEdit.status === 200 || disclosureEdit.status === 409;
  report(
    disclosureAccepted ? "PASS" : "FAIL",
    "edit: an address replacement carrying the contract-approved pre-flight disclosure is accepted",
    disclosureAccepted
      ? `http=${disclosureEdit.status}`
      : `http=${disclosureEdit.status} code=${disclosureEdit.body?.error?.code ?? "n/a"} message=${disclosureEdit.body?.error?.message ?? "n/a"}`,
  );

  // the disclosure channel the screen reads BEFORE submitting
  const editPreview = await call(
    "GET",
    `/v1/contacts/${aliasContact?.id}/removal-preview?expectedVersion=${aliasContact?.version}&action=address_change`,
  );
  report(
    editPreview.status === 200 && Array.isArray(editPreview.body?.data?.revokedGrantIds)
      ? "PASS"
      : "FAIL",
    "edit disclosure: the address-change pre-flight read carries the affected grants before submitting",
    `http=${editPreview.status} revokedGrantIds=${editPreview.body?.data?.revokedGrantIds?.length ?? "n/a"} lastAlias=${editPreview.body?.data?.lastAlias ?? "n/a"}`,
  );

  // remove: the disclosure object + the honesty rule
  const removalPreview = await call(
    "GET",
    `/v1/contacts/${contact1?.id}/removal-preview?expectedVersion=${contact1?.version}`,
  );
  const removed = await call(
    "DELETE",
    `/v1/contacts/${contact1?.id}?expectedVersion=${contact1?.version}`,
    { expectedRevokedGrantIds: removalPreview.body?.data?.revokedGrantIds ?? [] },
    key("remove"),
  );
  const revocation = removed.body?.data?.revocation as
    | { grantIds: string[]; state: string }
    | undefined;
  const removalOk =
    removed.status === 200 &&
    Array.isArray(revocation?.grantIds) &&
    ["pending", "applied", "retryable_failure"].includes(revocation?.state ?? "") &&
    (revocation!.state !== "applied" || revocation!.grantIds.length > 0);
  report(
    removalOk ? "PASS" : "FAIL",
    "remove: DELETE returns {contact, revocation} and never announces an unverified revocation as applied",
    removalOk
      ? `grantIds=${revocation!.grantIds.length} state=${revocation!.state}`
      : `http=${removed.status} body=${JSON.stringify(removed.body)}`,
  );

  const second = await call(
    "DELETE",
    `/v1/contacts/${contact1?.id}?expectedVersion=${contact1?.version}`,
    { expectedRevokedGrantIds: [] },
    key("remove-again"),
  );
  report(
    second.status === 404 ? "PASS" : "FAIL",
    "remove: a second DELETE is a 404, not a second revocation",
    `http=${second.status} code=${second.body?.error?.code ?? "n/a"}`,
  );

  // no chain picker: only the fixed Solana scope is representable
  const chainChoice = await call(
    "POST",
    "/v1/contacts",
    { name: "E2E-TR Chain", description: "", address: ADDRESS_2, network: "ethereum" },
    key("chain"),
  );
  report(
    chainChoice.status === 422 && chainChoice.body?.error?.code === "DATOS_INVALIDOS"
      ? "PASS"
      : "FAIL",
    "no chain picker: an explicit chain is refused as an unknown key (DATOS_INVALIDOS)",
    `http=${chainChoice.status} code=${chainChoice.body?.error?.code ?? "n/a"}`,
  );

  // a wallet with no ready permission stays saved-and-not-enabled, with no policy write
  const activeRecipients = psql(
    `SELECT count(*) FROM recipients WHERE user_id = '${TEST_USER_ID}' AND name LIKE 'E2E-TR %' AND status = 'active'`,
  );
  const appliedPolicies = psql(
    `SELECT count(*) FROM recipient_policy_state WHERE user_id = '${TEST_USER_ID}' AND applied_policy_id IS NOT NULL`,
  );
  report(
    Number(activeRecipients) >= 2 && appliedPolicies === "0" ? "PASS" : "FAIL",
    "no ready permission: the recipient stays saved-and-not-enabled with no applied policy id",
    `active E2E-TR recipients=${activeRecipients} applied_policy_id rows=${appliedPolicies}`,
  );

  // The recomposition itself landed: the intent is durable and the revisions advanced.
  const revisions = psql(
    `SELECT coalesce(max(desired_revision), 0) FROM recipient_policy_sync_intent WHERE user_id = '${TEST_USER_ID}' AND idempotency_key LIKE 'e2e-tr-%'`,
  );
  report(
    Number(revisions) > 0 ? "PASS" : "FAIL",
    "durable intent: the fake transport recorded the composed revision instead of writing a policy",
    `max desired_revision from this run's intents=${revisions}`,
  );
}

async function main(): Promise<void> {
  const app = buildTestServer({ userId: TEST_USER_ID });
  await app.listen({ port: BACKEND_PORT, host: "127.0.0.1" });
  console.log(
    `E2E_DRIVER_READY ${JSON.stringify({ url: BASE, userId: TEST_USER_ID })}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // `recipient_policy_sync_intent.contact_id` references the recipient row
      // (the guarded, NOT VALID FK) and `recipient_versions` references it without
      // a cascade, so both go first or the delete is refused. The append-only
      // `recipient_policy_audit` rows stay by design. One psql call: the harness
      // leaks nothing when it is interrupted, and repeated runs start clean.
      psql(`
        DELETE FROM recipient_policy_sync_intent WHERE user_id = '${TEST_USER_ID}' AND contact_id IN (SELECT id FROM recipients WHERE user_id = '${TEST_USER_ID}' AND name LIKE 'E2E-TR %');
        DELETE FROM recipient_versions WHERE recipient_id IN (SELECT id FROM recipients WHERE user_id = '${TEST_USER_ID}' AND name LIKE 'E2E-TR %');
        DELETE FROM recipients WHERE user_id = '${TEST_USER_ID}' AND name LIKE 'E2E-TR %';
      `);
    } catch {
      // Best effort: the append-only audit/intent rows stay by design.
    }
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  try {
    await scenarios();
  } catch (error) {
    report("FAIL", "driver scenario suite", error instanceof Error ? error.message : String(error));
  }
  console.log("E2E_DRIVER_SCENARIOS_DONE");
}

void main();
