/**
 * The task-5.7 SCREEN operation, driven against the deployed stack (live).
 *
 * WHAT IS GENUINELY LIVE HERE
 * ---------------------------
 * The real HTTP API (`buildServer`) with the real contacts routes, the real
 * `RecipientPolicyService`, the real Postgres database, the real SNS resolver
 * (`SNS_RPC_URL`, i.e. a real devnet RPC read of the name account) and the real
 * policy write path into `recipient_policy_sync_intent`. The deployment's OWN
 * reconciler (the process running in `nana-privy-impl-backend-1`, behind
 * `RECIPIENT_POLICY_RECONCILER`) is what applies the recorded revision to the
 * real Privy policy; this harness only records the intent and then OBSERVES.
 *
 * WHAT IS INJECTED
 * ----------------
 * Exactly one thing: the identity seam. An out-of-process caller cannot
 * authenticate (identity is ALWAYS Privy in `src/server.ts`), so the server is
 * booted IN PROCESS inside the container with `DemoIdentityProvider(USER_ID)`.
 * `wallet`, `walletReads` and `privyServer` are deliberately NOT injected, so
 * the real per-user Privy Solana wallet, the real capability and the real
 * resolver serve every route. This harness is live for API/DB/RPC/resolver and
 * for the policy write; it is NOT live for authentication.
 *
 * WHY TWO PROCESS-LEVEL SWITCHES ARE SET FOR THE IN-PROCESS SERVER
 * ---------------------------------------------------------------
 *   `RECIPIENT_POLICY_RECONCILER=disabled` — otherwise this short-lived process
 *     would start a SECOND 30 s reconciler loop contending for the same wallet
 *     lease (`backend-provider-wallet`) as the deployment's own loop. The
 *     deployment's loop is the actor that must apply the revision, so this
 *     harness must not race it. Nothing about the deployed loop is changed.
 *   `NOTIFICATIONS_OUTBOX_ENABLED=false` — no dispatcher worker in a throwaway
 *     process against the shared database.
 * Both are process-level and end with this process.
 *
 * NOT PERFORMED HERE, DELIBERATELY
 * --------------------------------
 * No transfer of any size is previewed, confirmed or broadcast. No secret is
 * read or printed (bounded ids/statuses/addresses only). `Test1` is never
 * touched: the harness only ever targets the id it created itself.
 *
 * USAGE (inside the backend container, which mounts no `scripts/` volume):
 *
 *   docker exec -i -e SCREEN_USER_ID=<uuid> -e SCREEN_INCLUDE_REMOVE=1 \
 *     nana-privy-impl-backend-1 node --input-type=module - \
 *     < scripts/privy-recipient-live-screen.mjs
 */
process.env.RECIPIENT_POLICY_RECONCILER = "disabled";
process.env.NOTIFICATIONS_OUTBOX_ENABLED = "false";

const userId = process.env.SCREEN_USER_ID?.trim();
if (!userId) {
  console.error("BLOCKED: SCREEN_USER_ID is required.");
  process.exit(2);
}
const snsName = process.env.SCREEN_SNS_NAME?.trim() || "sophie.sns";
const contactName = process.env.SCREEN_CONTACT_NAME?.trim() || "Sophie";
const doRemove = process.env.SCREEN_INCLUDE_REMOVE === "1";
/** Pre-flight: resolve the name and stop. Performs NO write of any kind. */
const resolveOnly = process.env.SCREEN_RESOLVE_ONLY === "1";
const observeSeconds = Number(process.env.SCREEN_OBSERVE_SECONDS ?? "0");
const walletId = process.env.SCREEN_WALLET_ID?.trim() || null;

/**
 * A MEMORY GUARD, AND WHY IT EXISTS
 * ---------------------------------
 * The FIRST attempt at this operation was killed by the shared Docker VM's OOM
 * killer with `OOMKilled: true` while the embedding model loaded, and no
 * mutation had committed. `buildServer` builds TWO `EmbeddingService`
 * instances — the contacts route's embedder and the `onReady` prefetch — and
 * each loads its own copy of the sentence-transformers weights from
 * `/app/.cache/recipient-memory-model` (458 MB on disk, more in RSS). The
 * deployment itself already holds ~1.2 GiB, and this machine runs many other
 * stacks against the same VM, so the free headroom fluctuates.
 *
 * Two consequences, both deliberate:
 *
 *   1. The harness REFUSES TO START when `MemAvailable` inside this namespace is
 *      below `SCREEN_MIN_AVAILABLE_MB` (default 1 500). It prints a typed
 *      refusal and exits without importing the server, so a marginal VM is never
 *      asked to absorb a model load the deployment may not survive.
 *   2. The prefetch warm-up is disabled (below). The source documents it as "an
 *      optimization; the first create loads on demand", so disabling it removes
 *      the SECOND model copy without touching the route's real embedder: the
 *      vector written to `recipients.embedding` still comes from the real model.
 *      This is a disclosed harness adaptation, not a fixture.
 */
const { readFile } = await import("node:fs/promises");
const minAvailableMb = Number(process.env.SCREEN_MIN_AVAILABLE_MB ?? "1500");
const meminfo = await readFile("/proc/meminfo", "utf8");
const availableKb = Number(
  /MemAvailable:\s+(\d+) kB/.exec(meminfo)?.[1] ?? "0",
);
if (availableKb > 0 && availableKb < minAvailableMb * 1024) {
  console.log(
    "SCREEN_OPERATION_BLOCKED=" +
      JSON.stringify(
        {
          reason: "insufficient_vm_memory_for_the_embedding_model_load",
          memAvailableMb: Math.floor(availableKb / 1024),
          requiredMb: minAvailableMb,
          precedent: "the first attempt was OOM-killed (OOMKilled: true) with no mutation committed",
          override: "SCREEN_MIN_AVAILABLE_MB",
        },
        null,
        2,
      ),
  );
  process.exit(3);
}
console.log(
  "SCREEN_MEMORY_GUARD=" +
    JSON.stringify({ memAvailableMb: Math.floor(availableKb / 1024), requiredMb: minAvailableMb }),
);

const { buildServer } = await import("/app/dist/server.js");
const { DemoIdentityProvider } = await import("/app/dist/auth/identity.js");
const { EmbeddingService } = await import("/app/dist/memory/embedding.js");
// Single model load: the route's real embedder stays real; only the warm-up copy
// goes away. Patched before any instance is built.
EmbeddingService.prototype.prefetch = async () => {};
const { createConfiguredDatabaseClient } = await import("/app/dist/db/client.js");
const { RecipientPolicyRepository } = await import("/app/dist/wallet/policy/repository.js");

const owner = `live-screen-${Date.now()}`;
const idempotency = (step) => `${owner}-${step}`;

const database = createConfiguredDatabaseClient();
const repository = new RecipientPolicyRepository(database);

const out = {
  owner,
  userId,
  snsName,
  contactName,
  doRemove,
  identitySeam: "DemoIdentityProvider (injected)",
  live: [
    "HTTP API + contacts routes",
    "RecipientPolicyService",
    "Postgres",
    "SNS resolver over SNS_RPC_URL",
    "policy-intent write path",
    "the deployment's own reconciler (observed, not started here)",
  ],
  processSwitches: {
    RECIPIENT_POLICY_RECONCILER: process.env.RECIPIENT_POLICY_RECONCILER,
    NOTIFICATIONS_OUTBOX_ENABLED: process.env.NOTIFICATIONS_OUTBOX_ENABLED,
  },
  steps: [],
};

/** One bounded HTTP step: status and body only, never a header or a token. */
async function call(app, step, method, url, payload, headers = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { "idempotency-key": idempotency(step), ...headers },
  });
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = { raw: String(response.body).slice(0, 200) };
  }
  const record = { step, method, url, status: response.statusCode, body };
  out.steps.push(record);
  return record;
}

/** The wallet's recorded policy state, read straight from the database. */
async function readState() {
  if (!walletId) return null;
  const state = await repository.readPolicyState(userId, walletId);
  if (!state) return null;
  return {
    desiredRevision: state.desiredRevision,
    appliedRevision: state.appliedRevision,
    appliedPolicyId: state.appliedPolicyId,
    appliedRecipients: state.appliedRecipients,
    consentBaseline: state.consentBaseline,
    status: state.status,
    statusReason: state.statusReason ?? null,
  };
}

/** Bounded observation of the deployment's own reconciler against the DB. */
async function observe(seconds, label) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started <= seconds * 1000) {
    const state = await readState();
    const last = samples[samples.length - 1];
    if (!last || JSON.stringify(last.state) !== JSON.stringify(state)) {
      samples.push({ atMs: Date.now() - started, state });
    }
    if (seconds === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  out[`observations_${label}`] = samples;
  return samples;
}

let app;
try {
  app = buildServer({ identity: new DemoIdentityProvider(userId) });
  await app.ready();
  out.appReady = true;

  if (walletId) out.stateBefore = await readState();

  // Step 1 — the screen's "Buscar": resolve the name the user typed.
  await call(app, "resolve-alias", "POST", "/v1/recipient-aliases/resolve", {
    name: snsName,
  });
  const resolved = out.steps[out.steps.length - 1].body?.data ?? null;
  out.resolvedAddress = resolved?.address ?? null;
  out.resolvedAt = resolved?.resolvedAt ?? null;
  out.resolver = resolved?.resolver ?? null;

  if (resolveOnly) {
    // The pre-flight stops here: the name resolved (or refused) and the process
    // mutated nothing. This is what makes the authorised write a deliberate step
    // rather than a side effect of validating the harness.
    out.resolveOnly = true;
    console.log("SCREEN_OPERATION=" + JSON.stringify(out, null, 2));
  } else {
  // Step 2 — the screen's add. The alias arm MUST echo the address the screen
  // displayed, which is what lets the server veto a name that moved.
  await call(app, "create-contact", "POST", "/v1/contacts", {
    name: contactName,
    source: "sns",
    snsName,
    ...(resolved?.address ? { expectedAddress: resolved.address } : {}),
  });
  const created = out.steps[out.steps.length - 1].body?.data ?? null;
  out.createdContactId = created?.id ?? null;
  out.createdContactVersion = created?.version ?? null;
  out.createdContactNetwork = created?.network ?? null;
  out.createdContactAlias = created?.alias ?? null;
  out.createdContactPermission = created?.permission ?? null;

  await call(app, "list-contacts", "GET", "/v1/contacts");
  out.contactsAfterAdd = out.steps[out.steps.length - 1].body?.data ?? null;
  await call(app, "read-permission", "GET", "/v1/recipient-policy");
  out.permissionAfterAdd = out.steps[out.steps.length - 1].body?.data ?? null;

  if (observeSeconds > 0) await observe(observeSeconds, "afterAdd");
  else out.stateAfterAdd = await readState();

  // Step 3 — the removal, through the same screen path: the preview the screen
  // shows first, then the delete carrying the disclosed grant set.
  if (doRemove && out.createdContactId && out.createdContactVersion) {
    await call(
      app,
      "removal-preview",
      "GET",
      `/v1/contacts/${out.createdContactId}/removal-preview?expectedVersion=${out.createdContactVersion}`,
    );
    const preview = out.steps[out.steps.length - 1].body?.data ?? null;
    out.removalPreview = preview;

    await call(
      app,
      "remove-contact",
      "DELETE",
      `/v1/contacts/${out.createdContactId}?expectedVersion=${out.createdContactVersion}`,
      { expectedRevokedGrantIds: preview?.revokedGrantIds ?? [] },
    );
    out.removedContact = out.steps[out.steps.length - 1].body?.data ?? null;

    await call(app, "list-contacts-after-remove", "GET", "/v1/contacts");
    out.contactsAfterRemove = out.steps[out.steps.length - 1].body?.data ?? null;
    await call(app, "read-permission-after-remove", "GET", "/v1/recipient-policy");
    out.permissionAfterRemove = out.steps[out.steps.length - 1].body?.data ?? null;

    if (observeSeconds > 0) await observe(observeSeconds, "afterRemove");
    else out.stateAfterRemove = await readState();
  }

  out.stateFinal = await readState();
  console.log("SCREEN_OPERATION=" + JSON.stringify(out, null, 2));
  }
} catch (error) {
  console.log(
    "SCREEN_OPERATION_FAILED=" +
      JSON.stringify(
        {
          ...out,
          errorName: error?.constructor?.name ?? null,
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
        },
        null,
        2,
      ),
  );
  process.exitCode = 1;
} finally {
  try {
    await app?.close();
  } catch {
    // A throwaway in-process server that fails to close must not hide the result.
  }
  await database.close();
}
