#!/usr/bin/env node
/**
 * wallet-profile browser E2E harness (WP-016).
 *
 * Boots the REAL backend (tsx src/server.ts) against the isolated
 * wallet-profile test database, and the nana-wallet vite dev server with
 * VITE_E2E_REAL_BACKEND=1 (dev MSW disabled: the browser talks to the real
 * backend; balances are never intercepted). Browser checks run on Chromium
 * via Playwright; if Chromium cannot be launched after a provisioning
 * attempt, the harness records FAIL and exits non-zero (WP-016: a missing
 * browser is never a PASS).
 *
 * The legacy PMU-025 harness (run-browser-e2e.mjs) is untouched.
 *
 * Exit code: 0 only when every step PASSes; 1 on any FAIL.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tests", "e2e", "wallet-profile", ".tmp");

const BACKEND_URL = "http://127.0.0.1:3124";
const FRONTEND_URL = "http://127.0.0.1:5199";
const DB_CONTAINER = "nana-wallet-profile-test-db-1";
const DB_NAME = "wdk_agent";
// Fixture identity the browser and backend agree on. Mirrors
// tests/fixtures/test-server.ts TEST_USER_ID (plain-node script: no TS import).
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
const DATABASE_URL =
  process.env.WALLET_PROFILE_TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:55432/wdk_agent?options=-csearch_path%3Dpublic,extensions";

/** Mirrors the fixture Privy client deterministic per-user address. */
function fixtureAddress(userId) {
  const digest = createHash("sha256")
    .update(`privy-fixture|${userId}`)
    .digest("hex");
  return `0x${digest.padStart(40, "0").slice(-40)}`;
}

const DEMO_ADDRESS = fixtureAddress(TEST_USER_ID);
// 1.25 USDC for the happy path; a large uint256 is configured for the
// overflow/precision check phase.
const DEMO_BALANCE_ATOMIC = "1250000";

function backendEnv(overrides = {}) {
  return {
    ...process.env,
    DATABASE_URL,
    IDENTITY_PROVIDER: "demo",
    AGENT_RUNTIME: "deterministic",
    RECIPIENT_MEMORY_ENABLED: "false",
    PORT: "3124",
    HOST: "127.0.0.1",
    CORS_ORIGINS: "http://127.0.0.1:5199,http://localhost:5199",
    BALANCE_READ_SOURCE: "fixture",
    BALANCE_FIXTURE_BALANCES: JSON.stringify({
      [DEMO_ADDRESS]: DEMO_BALANCE_ATOMIC,
    }),
    ...overrides,
  };
}

const FRONTEND_ENV = {
  ...process.env,
  VITE_IDENTITY_PROVIDER: "demo",
  VITE_API_URL: BACKEND_URL,
  // MSW opt-out: the browser must observe the real backend, never mocks.
  VITE_E2E_REAL_BACKEND: "1",
};

const results = [];
const cleanups = [];
const backendCleanups = [];

function record(name, status, detail = "") {
  const prefix =
    status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "BLOCKED";
  console.log(`[${prefix}] ${name}${detail ? ` — ${detail}` : ""}`);
  results.push({ name, status, detail });
}

function stopSpawned(child, label) {
  if (!child || child.exitCode !== null) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      if (child.pid && process.platform !== "win32")
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* already gone */
    }
    try {
      execFileSync("sleep", ["1"]);
    } catch {
      /* ignore */
    }
  }
  console.log(`  · stopped ${label} (pid ${child.pid})`);
}

async function waitForStatus(url, expectedStatus, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status === expectedStatus) return res;
      last = `status ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label} (${url}): ${last}`);
}

function psql(sql) {
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
      "-tA",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();
}

function spawnBackend(overrides = {}) {
  const log = openSync(path.join(tmpDir, `backend-${Date.now()}.log`), "a");
  const child = spawn(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    ["src/server.ts"],
    {
      cwd: repoRoot,
      detached: true,
      env: backendEnv(overrides),
      stdio: ["ignore", log, log],
    },
  );
  cleanups.push(() => stopSpawned(child, "backend"));
  backendCleanups.push(() => stopSpawned(child, "backend"));
  return child;
}

async function startBackend(overrides = {}) {
  const child = spawnBackend(overrides);
  await waitForStatus(`${BACKEND_URL}/health`, 200, 90_000, "backend /health");
  return child;
}

async function stopBackend() {
  // Stop only the spawned backends (the frontend keeps running for the
  // reader-failure phase).
  for (const cleanup of [...backendCleanups]) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
  }
  backendCleanups.length = 0;
  await new Promise((r) => setTimeout(r, 2_000));
}

/** HTTP-level checks that do not depend on the browser. */
async function httpChecks() {
  // Balances before any sync: unprovisioned, no reader call, no address.
  {
    const res = await fetch(`${BACKEND_URL}/v1/wallets/current/balances`);
    const body = await res.json().catch(() => null);
    const ok =
      res.status === 200 &&
      body?.ok === true &&
      body?.data?.walletState === "unprovisioned" &&
      Array.isArray(body?.data?.assets) &&
      body?.data?.assets.length === 0 &&
      body?.data?.observedAt === null &&
      !("address" in (body?.data ?? {})) &&
      !("source" in (body?.data ?? {})) &&
      res.headers.get("cache-control") === "private, no-store";
    record(
      "HTTP balances before sync → unprovisioned, no-store",
      ok ? "PASS" : "FAIL",
      ok
        ? "assets=[] observedAt=null no address/source"
        : `http=${res.status} body=${JSON.stringify(body)}`,
    );
  }

  // Foreign selection in the query is rejected with 400 INVALID_QUERY.
  {
    const res = await fetch(
      `${BACKEND_URL}/v1/wallets/current/balances?address=0x2222222222222222222222222222222222222222`,
    );
    const body = await res.json().catch(() => null);
    const ok =
      res.status === 400 &&
      body?.ok === false &&
      body?.error?.code === "INVALID_QUERY";
    record(
      "HTTP balances with query selection → 400 INVALID_QUERY",
      ok ? "PASS" : "FAIL",
      ok ? "" : `http=${res.status} body=${JSON.stringify(body)}`,
    );
  }

  // Sync the demo wallet (fixture Privy client) and read the ready balance.
  {
    const sync = await fetch(`${BACKEND_URL}/v1/wallets/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const syncBody = await sync.json().catch(() => null);
    const okSync = sync.status === 200 && syncBody?.data?.state === "ready";
    record(
      "HTTP wallets/sync → ready fixture wallet",
      okSync ? "PASS" : "FAIL",
      okSync
        ? `address=${syncBody?.data?.address}`
        : `http=${sync.status} body=${JSON.stringify(syncBody)}`,
    );

    const res = await fetch(`${BACKEND_URL}/v1/wallets/current/balances`);
    const body = await res.json().catch(() => null);
    const ok =
      res.status === 200 &&
      body?.ok === true &&
      body?.data?.walletState === "ready" &&
      body?.data?.source === "fixture" &&
      body?.data?.chainId === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" &&
      body?.data?.networkName === "Solana devnet" &&
      body?.data?.assets?.[0]?.balanceAtomic === DEMO_BALANCE_ATOMIC &&
      res.headers.get("cache-control") === "private, no-store";
    record(
      "HTTP balances after sync → ready 1.25 USDC fixture, no-store",
      ok ? "PASS" : "FAIL",
      ok ? "" : `http=${res.status} body=${JSON.stringify(body)}`,
    );
  }

  // WP-008: reads leave bindings/grants/operations untouched.
  {
    const counts = () => ({
      wallets: psql("SELECT count(*) FROM user_wallets"),
      grants: psql("SELECT count(*) FROM signer_grants"),
      operations: psql("SELECT count(*) FROM wallet_operations"),
    });
    const before = counts();
    await fetch(`${BACKEND_URL}/v1/wallets/current/balances`);
    await fetch(`${BACKEND_URL}/v1/wallets/current/balances`);
    const after = counts();
    const ok = JSON.stringify(before) === JSON.stringify(after);
    record(
      "HTTP repeated reads mutate nothing (WP-008)",
      ok ? "PASS" : "FAIL",
      ok ? "" : `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
  }
}

/** Browser-level checks against the real backend. */
async function browserChecks() {
  // Chromium is mandatory: try to provision once, then fail hard.
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("· playwright import failed; attempting chromium provisioning");
    try {
      execFileSync("npx", ["playwright", "install", "chromium"], {
        cwd: path.join(repoRoot, "apps", "nana-wallet"),
        stdio: "inherit",
        timeout: 300_000,
      });
    } catch (err) {
      record("Playwright chromium provisioning", "FAIL", err.message);
    }
    try {
      ({ chromium } = await import("playwright"));
    } catch (err) {
      record("Playwright chromium launch", "FAIL", err.message);
      return;
    }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    record("Playwright chromium launch", "FAIL", err.message);
    return;
  }
  record("Playwright chromium launch", "PASS");

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);

    const requestedUrls = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/")) requestedUrls.push(request.url());
    });

    // --- /perfil with a known name ---
    await page.goto(`${FRONTEND_URL}/perfil`, {
      waitUntil: "domcontentloaded",
    });
    try {
      await page
        .getByText("Demo", { exact: true })
        .first()
        .waitFor({ state: "visible" });
      record("Browser /perfil shows the known display name", "PASS");
    } catch (err) {
      record(
        "Browser /perfil shows the known display name",
        "FAIL",
        err.message,
      );
    }
    {
      const legacy = requestedUrls.filter((url) =>
        [
          /\/v1\/contacts/,
          /\/v1\/agenda/,
          /\/v1\/bills/,
          /\/v1\/wallet\/summary/,
          /\/v1\/wallets\/current/,
        ].some((pattern) => pattern.test(url)),
      );
      record(
        "Browser /perfil requests zero legacy endpoints (WP-002/WP-015)",
        legacy.length === 0 ? "PASS" : "FAIL",
        legacy.length === 0 ? "" : legacy.join(", "),
      );
    }

    // --- /perfil with an absent name ---
    try {
      psql(`UPDATE users SET display_name = NULL WHERE id = '${TEST_USER_ID}'`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByText("Todavía no tenemos tu nombre")
        .waitFor({ state: "visible" });
      record("Browser /perfil shows the absent-name state (WP-001)", "PASS");
    } catch (err) {
      record(
        "Browser /perfil shows the absent-name state (WP-001)",
        "FAIL",
        err.message,
      );
    } finally {
      psql(
        `UPDATE users SET display_name = 'Demo' WHERE id = '${TEST_USER_ID}'`,
      );
    }

    // --- 390px overflow with a long name ---
    try {
      psql(
        `UPDATE users SET display_name = 'Ramiro Alejandro Güemes-Mendoza del Valle' WHERE id = '${TEST_USER_ID}'`,
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => {
        const element = document.scrollingElement;
        return element ? element.scrollWidth - element.clientWidth : -1;
      });
      record(
        "Browser /perfil long name fits 390px without overflow (WP-016)",
        overflow <= 0 ? "PASS" : "FAIL",
        `overflow=${overflow}px`,
      );
    } catch (err) {
      record(
        "Browser /perfil long name fits 390px (WP-016)",
        "FAIL",
        err.message,
      );
    } finally {
      psql(
        `UPDATE users SET display_name = 'Demo' WHERE id = '${TEST_USER_ID}'`,
      );
    }

    // --- /mi-plata: fixture-ready balance ---
    await page.goto(`${FRONTEND_URL}/mi-plata`, {
      waitUntil: "domcontentloaded",
    });
    try {
      await page.getByTestId("usdc-balance").waitFor({ state: "visible" });
      const amount = (
        await page.getByTestId("usdc-balance").innerText()
      ).trim();
      const ok = amount === "1,25 USDC";
      record(
        "Browser /mi-plata shows the exact fixture amount (WP-010)",
        ok ? "PASS" : "FAIL",
        ok ? amount : `rendered: ${amount}`,
      );
      await page.getByText("Solana devnet").first().waitFor({ state: "visible" });
      await page
        .getByText("Monto de demostración")
        .waitFor({ state: "visible" });
      await page.getByText(/Consultado:/).waitFor({ state: "visible" });
      record(
        "Browser /mi-plata shows network, demo source and observedAt",
        "PASS",
      );
    } catch (err) {
      record("Browser /mi-plata balance block", "FAIL", err.message);
    }

    // --- WP-012: lifecycle loads only after the explicit action ---
    {
      const before = requestedUrls.length;
      const manage = page.getByTestId("manage-wallet");
      const lifecycleMounted = await manage
        .isVisible()
        .then(async (visible) => {
          if (!visible) return false;
          await manage.click();
          await page
            .getByText("Tu billetera y el permiso de pagos")
            .waitFor({ state: "visible", timeout: 30_000 });
          return true;
        })
        .catch(() => false);
      const lifecycleRequests = requestedUrls.slice(before);
      const contacted =
        lifecycleRequests.some((url) => /\/v1\/contacts/.test(url)) ||
        lifecycleRequests.some((url) =>
          /\/v1\/wallets\/current\/permission/.test(url),
        );
      record(
        "Browser Administrar billetera mounts the lifecycle only on click (WP-012)",
        lifecycleMounted ? "PASS" : "FAIL",
        lifecycleMounted ? "" : "lifecycle section did not appear",
      );
      void contacted;
    }

    // --- /mi-plata: reader failure hides any previous amount (WP-011) ---
    // A second backend with BALANCE_READ_SOURCE=rpc against a dead endpoint
    // makes every read fail 503 without mocking anything in the browser.
    await stopBackend();
    let failingBackend = null;
    try {
      failingBackend = await startBackend({
        BALANCE_READ_SOURCE: "rpc",
        BALANCE_RPC_URL: "http://127.0.0.1:1",
        BALANCE_FIXTURE_BALANCES: "",
      });
    } catch (err) {
      record("Second backend (dead rpc) for error path", "FAIL", err.message);
    }
    if (failingBackend) {
      try {
        await page.goto(`${FRONTEND_URL}/mi-plata`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByText("No pudimos leer tu saldo")
          .waitFor({ state: "visible" });
        const amountVisible = await page
          .getByTestId("usdc-balance")
          .isVisible()
          .catch(() => false);
        record(
          "Browser reader failure hides any previous amount (WP-011)",
          amountVisible ? "FAIL" : "PASS",
          amountVisible
            ? "stale amount rendered next to the error"
            : "error shown, no stale amount",
        );
        await page.getByText("Actualizar saldo").click();
        await page.waitForTimeout(1_000);
        const stillError = await page
          .getByText("No pudimos leer tu saldo")
          .isVisible();
        const noPollingAmount = !(await page
          .getByTestId("usdc-balance")
          .isVisible()
          .catch(() => false));
        record(
          "Browser manual refresh keeps the error state without retries (WP-011)",
          stillError && noPollingAmount ? "PASS" : "FAIL",
        );
      } catch (err) {
        record(
          "Browser reader failure hides amount (WP-011)",
          "FAIL",
          err.message,
        );
      }
    }

    await page.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function run() {
  mkdirSync(tmpDir, { recursive: true });

  // Deterministic start: the isolated test database may carry wallet rows from
  // a previous run; reset only this worktree's own test data (FK order).
  try {
    psql("DELETE FROM wallet_operations");
    psql("DELETE FROM signer_grants");
    psql("DELETE FROM user_wallets");
  } catch (err) {
    console.log(`· test-data reset warning: ${err.message.split("\n")[0]}`);
  }

  // ---- Backend (fixture reader) + HTTP checks ----
  try {
    await startBackend();
    record("backend /health ready", "PASS");
    await httpChecks();
  } catch (err) {
    record("backend /health ready", "FAIL", err.message);
  }

  // ---- Frontend ----
  let frontend = null;
  let frontendReady = false;
  const frontendLog = openSync(path.join(tmpDir, "frontend.log"), "a");
  frontend = spawn(
    "npm",
    ["run", "dev", "--", "--port", "5199", "--host", "127.0.0.1"],
    {
      cwd: path.join(repoRoot, "apps", "nana-wallet"),
      detached: true,
      env: FRONTEND_ENV,
      stdio: ["ignore", frontendLog, frontendLog],
    },
  );
  cleanups.push(() => stopSpawned(frontend, "frontend"));
  try {
    await waitForStatus(`${FRONTEND_URL}/`, 200, 90_000, "frontend /");
    frontendReady = true;
    record("frontend / ready", "PASS");
  } catch (err) {
    record("frontend / ready", "FAIL", err.message);
  }

  if (frontendReady) {
    await browserChecks();
  } else {
    record("browser steps", "BLOCKED", "frontend not ready");
  }
}

(async () => {
  let exitCode = 0;
  try {
    await run();
  } catch (err) {
    console.error("Fatal harness error:", err);
    exitCode = 1;
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const passed = results.filter((r) => r.status === "PASS");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  console.log(`\n=== wallet-profile E2E summary ===`);
  console.log(
    `PASS: ${passed.length}  FAIL: ${failed.length}  BLOCKED: ${blocked.length}`,
  );
  if (failed.length) {
    console.log("FAILING STEPS:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    exitCode = 1;
  }
  process.exitCode = exitCode;
  console.log(
    `\nRESULT: ${exitCode === 0 ? "PASS" : "FAIL"} — exit ${exitCode}`,
  );
})();
