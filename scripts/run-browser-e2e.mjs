#!/usr/bin/env node
/**
 * PMU-025 browser E2E harness (fixture mode, REAL backend).
 *
 * Boots the real backend (`npx tsx src/server.ts`) and the nana-wallet vite dev
 * server, then runs HTTP-level checks directly against the backend (node fetch,
 * no MSW) and, when Playwright chromium is available, browser-level checks
 * against the frontend.
 *
 * Browser notes:
 *  - The nana-wallet dev server starts MSW (mocks/browser) because it runs in
 *    `import.meta.env.DEV`. MSW mocks `/v1/me`, `/v1/contacts`, `/v1/agenda`,
 *    `/v1/bills` and `/v1/wallet/summary` with a wildcard 'v1' path prefix, so
 *    the browser cannot observe the real-backend contact on `/perfil` unless
 *    MSW is disabled (there is no env flag; it is hardcoded in client.tsx).
 *  - The backend default CORS allowlist only permits `localhost:8083` and
 *    `127.0.0.1:8083`. A browser page at `127.0.0.1:5199` is therefore blocked
 *    on any direct browser→backend fetch (net::ERR_FAILED).
 *  - Conversation endpoints `passthrough()` only when `VITE_AGENT_BACKEND=1`,
 *    which we set so the chat confirm-preview flow hits the real backend.
 * Exit code: 1 if any step FAILs (excluding a recorded chromium blocker).
 */

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tests", "e2e", "browser", ".tmp");

const BACKEND_URL = "http://127.0.0.1:3123";
const PORTLESS_NAME = process.env.NANA_E2E_PORTLESS_NAME;
const FRONTEND_URL = process.env.NANA_E2E_FRONTEND_URL ??
  (PORTLESS_NAME ? `https://${PORTLESS_NAME}.localhost` : "http://127.0.0.1:5199");
const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
// Fixture identity the browser and backend agree on. Mirrors
// tests/fixtures/test-server.ts TEST_USER_ID (plain-node script: no TS import).
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
const RECIPIENT_ADDR = "0x9999999999999999999999999999999999999999";
const CONTACT = {
  name: "E2E Lucas",
  description: "e2e",
  address: RECIPIENT_ADDR,
};
const TRANSFER_MESSAGE = "Send 10 USDT to " + RECIPIENT_ADDR;
const DB_CONTAINER = "nana-privy-impl-db-1";
const DB_NAME = "wdk_agent";

const BACKEND_ENV = {
  DATABASE_URL:
    "postgresql://postgres@127.0.0.1:5432/wdk_agent?options=-csearch_path%3Dpublic,extensions",
  AGENT_RUNTIME: "deterministic",
  RECIPIENT_MEMORY_ENABLED: "true",
  IDENTITY_PROVIDER: "demo",
  PORT: "3123",
  CORS_ORIGINS: `${FRONTEND_ORIGIN},http://localhost:5199`,
  HOST: "127.0.0.1",
};

const FRONTEND_ENV = {
  VITE_IDENTITY_PROVIDER: "demo",
  VITE_API_URL: BACKEND_URL,
  // MSW passthrough gate: without this the conversation flow is mocked, so we
  // need it to exercise the real backend on the chat confirm-preview path.
  VITE_AGENT_BACKEND: "1",
  VITE_E2E_REAL_BACKEND: "1",
};

const results = [];
const cleanups = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const prefix =
    status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "BLOCKED";
  console.log(`[${prefix}] ${name}${detail ? ` — ${detail}` : ""}`);
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${label} (${url}): ${last}`);
}

function walletOperationsCount() {
  const out = execFileSync(
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
      "SELECT count(*) FROM wallet_operations;",
    ],
    { encoding: "utf8" },
  );
  const n = parseInt(out.trim(), 10);
  if (Number.isNaN(n))
    throw new Error(`Unexpected wallet_operations count output: ${out.trim()}`);
  return n;
}

function stopSpawned(child, label) {
  if (!child || child.exitCode !== null) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      // detached group: signal the whole tree
      if (child.pid && process.platform !== "win32")
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // ignore: already gone
    }
    // give SIGTERM a moment to land before SIGKILL
    if (signal === "SIGTERM") {
      try {
        execFileSync("sleep", ["1"]);
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`  · stopped ${label} (pid ${child.pid})`);
}

async function run() {
  mkdirSync(tmpDir, { recursive: true });
  const backendLog = createWriteStream(path.join(tmpDir, "backend.log"));
  const frontendLog = createWriteStream(path.join(tmpDir, "frontend.log"));

  let backend = null;
  let backendReady = false;
  // Reuse an already-running correct backend on 3100 (avoids EADDRINUSE and
  // avoids killing a process we do not own). Only spawn one if absent.
  try {
    await waitForStatus(
      `${BACKEND_URL}/health`,
      200,
      8_000,
      "existing backend /health",
    );
    backendReady = true;
    record("backend /health ready (reused pre-existing)", "PASS");
  } catch {
    const backendBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    backend = spawn(backendBin, ["src/server.ts"], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, ...BACKEND_ENV },
      stdio: ["ignore", backendLog, backendLog],
    });
    cleanups.push(() => stopSpawned(backend, "backend"));
    console.log(`· spawned backend pid ${backend.pid}`);
    try {
      await waitForStatus(
        `${BACKEND_URL}/health`,
        200,
        60_000,
        "backend /health",
      );
      backendReady = true;
      record("backend /health ready (spawned)", "PASS");
    } catch (err) {
      record("backend /health ready", "FAIL", err.message);
    }
  }

  // ---- Spawn frontend ----
  const frontend = spawn(
    PORTLESS_NAME ? "portless" : "npm",
    PORTLESS_NAME
      ? [PORTLESS_NAME, "npm", "run", "dev", "--", "--host", "127.0.0.1"]
      : ["run", "dev", "--", "--port", "5199", "--host", "127.0.0.1"],
    {
      cwd: path.join(repoRoot, "apps", "nana-wallet"),
      detached: true,
      env: { ...process.env, ...FRONTEND_ENV },
      stdio: ["ignore", frontendLog, frontendLog],
    },
  );
  cleanups.push(() => stopSpawned(frontend, "frontend"));
  console.log(`· spawned frontend pid ${frontend.pid}`);

  let frontendReady = false;
  if (backendReady) {
    try {
      const res = await waitForStatus(
        `${FRONTEND_URL}/`,
        200,
        60_000,
        "frontend /",
      );
      frontendReady = true;
      void res;
      record("frontend / ready", "PASS");
    } catch (err) {
      record("frontend / ready", "FAIL", err.message);
    }
  } else {
    record("frontend / ready", "BLOCKED", "backend not ready; skipped");
  }

  // ---- HTTP-level steps (direct fetch, no MSW) ----
  let contactId = null;
  let baselineCount = null;

  if (backendReady) {
    // GET /health body
    try {
      const res = await fetch(`${BACKEND_URL}/health`, { method: "GET" });
      const body = await res.json();
      record(
        'HTTP GET /health body.status === "ok"',
        res.status === 200 && body.status === "ok" ? "PASS" : "FAIL",
        res.status === 200 && body.status === "ok"
          ? `status=${body.status}`
          : `http=${res.status} body=${JSON.stringify(body)}`,
      );
    } catch (err) {
      record('HTTP GET /health body.status === "ok"', "FAIL", err.message);
    }

    // POST /v1/contacts
    try {
      const res = await fetch(`${BACKEND_URL}/v1/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(CONTACT),
      });
      const body = await res.json().catch(() => null);
      const ok =
        res.status === 201 &&
        body?.ok === true &&
        body?.data?.name === CONTACT.name;
      contactId = body?.data?.id ?? null;
      record(
        "HTTP POST /v1/contacts → 201",
        ok ? "PASS" : "FAIL",
        ok
          ? `id=${contactId}`
          : `http=${res.status} body=${JSON.stringify(body)}`,
      );
    } catch (err) {
      record("HTTP POST /v1/contacts → 201", "FAIL", err.message);
    }

    // GET /v1/contacts contains it
    try {
      const res = await fetch(`${BACKEND_URL}/v1/contacts`, { method: "GET" });
      const body = await res.json().catch(() => null);
      const found =
        body?.ok === true && body?.data?.some((c) => c.name === CONTACT.name);
      record(
        "HTTP GET /v1/contacts contains contact",
        found ? "PASS" : "FAIL",
        found
          ? "found E2E Lucas"
          : `http=${res.status} body=${JSON.stringify(body)}`,
      );
    } catch (err) {
      record("HTTP GET /v1/contacts contains contact", "FAIL", err.message);
    }

    // GET /v1/me
    try {
      const res = await fetch(`${BACKEND_URL}/v1/me`, { method: "GET" });
      const body = await res.json().catch(() => null);
      // /v1/me returns the ApiEnvelope { ok: true, data: { userId, displayName } }.
      const userId = body?.data?.userId ?? body?.data?.userId ?? body?.userId;
      const ok = res.status === 200 && userId === TEST_USER_ID;
      record(
        "HTTP GET /v1/me → userId",
        ok ? "PASS" : "FAIL",
        ok
          ? `userId=${userId}`
          : `http=${res.status} body=${JSON.stringify(body)}`,
      );
    } catch (err) {
      record("HTTP GET /v1/me → userId", "FAIL", err.message);
    }

    // POST /v1/conversations
    let conversationId = null;
    try {
      const res = await fetch(`${BACKEND_URL}/v1/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      conversationId = body?.conversationId ?? null;
      const ok = res.status === 200 && Boolean(conversationId);
      record(
        "HTTP POST /v1/conversations → conversationId",
        ok ? "PASS" : "FAIL",
        ok
          ? `conversationId=${conversationId}`
          : `http=${res.status} body=${JSON.stringify(body)}`,
      );
    } catch (err) {
      record(
        "HTTP POST /v1/conversations → conversationId",
        "FAIL",
        err.message,
      );
    }

    // Baseline wallet_operations count (before the transfer turn)
    try {
      baselineCount = walletOperationsCount();
      record(
        "DB baseline wallet_operations count",
        "PASS",
        `count=${baselineCount}`,
      );
    } catch (err) {
      record("DB baseline wallet_operations count", "FAIL", err.message);
    }

    // POST /v1/conversations/:id/turns → confirmation_required
    let turnRecipient = null;
    if (conversationId) {
      try {
        const res = await fetch(
          `${BACKEND_URL}/v1/conversations/${conversationId}/turns`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: TRANSFER_MESSAGE }),
          },
        );
        const body = await res.json().catch(() => null);
        turnRecipient = body?.preview?.recipient ?? null;
        const ok =
          res.status === 200 &&
          body?.status === "confirmation_required" &&
          turnRecipient === RECIPIENT_ADDR;
        record(
          "HTTP POST /v1/conversations/:id/turns → confirmation_required",
          ok ? "PASS" : "FAIL",
          ok
            ? `status=${body.status} recipient=${turnRecipient}`
            : `http=${res.status} body=${JSON.stringify(body)}`,
        );
      } catch (err) {
        record(
          "HTTP POST /v1/conversations/:id/turns → confirmation_required",
          "FAIL",
          err.message,
        );
      }
    } else {
      record(
        "HTTP POST /v1/conversations/:id/turns → confirmation_required",
        "BLOCKED",
        "no conversationId to send a turn",
      );
    }

    // No-confirm → no new wallet_operations row
    try {
      const afterCount = walletOperationsCount();
      const ok = baselineCount !== null && afterCount === baselineCount;
      record(
        "DB: no new wallet_operations row after unconfirmed turn",
        ok ? "PASS" : "FAIL",
        ok
          ? `count=${afterCount} (unchanged)`
          : `before=${baselineCount} after=${afterCount}`,
      );
    } catch (err) {
      record(
        "DB: no new wallet_operations row after unconfirmed turn",
        "FAIL",
        err.message,
      );
    }
  } else {
    for (const s of [
      'HTTP GET /health body.status === "ok"',
      "HTTP POST /v1/contacts → 201",
      "HTTP GET /v1/contacts contains contact",
      "HTTP GET /v1/me → userId",
      "HTTP POST /v1/conversations → conversationId",
      "DB baseline wallet_operations count",
      "HTTP POST /v1/conversations/:id/turns → confirmation_required",
      "DB: no new wallet_operations row after unconfirmed turn",
    ]) {
      record(s, "BLOCKED", "backend not ready");
    }
  }

  // ---- Browser-level steps ----
  let browser = null;
  let browserAvailable = false;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    browserAvailable = true;
    record("Playwright chromium launch", "PASS");
  } catch (err) {
    browserAvailable = false;
    record("Playwright chromium launch", "BLOCKED", err.message);
  }

  if (browserAvailable && frontendReady) {
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      const consoleLogs = [];
      page.on("console", (msg) =>
        consoleLogs.push(`[console.${msg.type()}] ${msg.text()}`),
      );
      page.on("pageerror", (err) =>
        consoleLogs.push(`[pageerror] ${err.message}`),
      );

      // /perfil asserts the real-backend contact name is rendered.
      try {
        await page.goto(`${FRONTEND_URL}/perfil`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const name = page.getByText(CONTACT.name, { exact: true }).first();
        await name.waitFor({ state: "visible", timeout: 30_000 });
        record("Browser /perfil renders contact name", "PASS");
      } catch (err) {
        record(
          "Browser /perfil renders contact name",
          "FAIL",
          `${err.message} (dev MSW mocks /v1/me + /v1/contacts, so the real backend contact is not observable)`,
        );
      }

      // / chat: send the same message, expect the confirmation preview; do NOT confirm.
      try {
        await page.goto(`${FRONTEND_URL}/`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const input = page.getByLabel("Mensaje para el agente");
        await input.waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForFunction(
          () => {
            const el = document.querySelector(
              'input[aria-label="Mensaje para el agente"]',
            );
            return el && !el.disabled;
          },
          { timeout: 60_000 },
        );
        await input.fill(TRANSFER_MESSAGE);
        await input.press("Enter");
        await page
          .getByText(RECIPIENT_ADDR)
          .first()
          .waitFor({ state: "visible", timeout: 60_000 });
        record("Browser / chat shows confirmation preview (recipient)", "PASS");
      } catch (err) {
        let pageText = "";
        try {
          pageText = (await page.locator("main").first().innerText()).slice(
            0,
            800,
          );
        } catch {
          /* ignore */
        }
        const alerts = await page
          .locator('[role="alert"]')
          .allInnerTexts()
          .catch(() => []);
        record(
          "Browser / chat shows confirmation preview (recipient)",
          "FAIL",
          `${err.message}\n  --- rendered <main> ---\n${pageText}\n  --- {role=alert} ---\n${alerts.join(" | ")}\n  --- console ---\n${consoleLogs.slice(-25).join("\n")}`,
        );
      }

      await page.close();
    } catch (err) {
      record("Browser-level steps", "FAIL", err.message);
    }
  } else if (browserAvailable && !frontendReady) {
    record(
      "Browser /perfil renders contact name",
      "BLOCKED",
      "frontend not ready",
    );
    record(
      "Browser / chat shows confirmation preview (recipient)",
      "BLOCKED",
      "frontend not ready",
    );
  } else {
    record(
      "Browser /perfil renders contact name",
      "BLOCKED",
      "chromium unavailable",
    );
    record(
      "Browser / chat shows confirmation preview (recipient)",
      "BLOCKED",
      "chromium unavailable",
    );
  }

  if (browser) await browser.close().catch(() => {});

  // ---- Summary ----
  console.log("\n=== PMU-025 E2E summary ===");
  const failed = results.filter((r) => r.status === "FAIL");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const passed = results.filter((r) => r.status === "PASS");
  console.log(
    `PASS: ${passed.length}  FAIL: ${failed.length}  BLOCKED: ${blocked.length}`,
  );
  if (failed.length) {
    console.log("FAILING STEPS:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }

  return { failed, blocked, passed, browserAvailable };
}

(async () => {
  let outcome;
  try {
    outcome = await run();
  } catch (err) {
    console.error("Fatal harness error:", err);
    process.exitCode = 1;
    return;
  } finally {
    // Kill spawned processes regardless of how the run ended.
    for (const c of cleanups) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
  }

  // Exit 1 on any FAIL. A chromium blocker is not a FAIL (-> exit 0, documented BLOCKED).
  const anyFail = outcome.failed.length > 0;
  if (anyFail) {
    process.exitCode = 1;
    console.log("\nRESULT: FAIL (at least one step failed) — exit 1");
  } else {
    console.log(
      "\nRESULT: PASS (no failed steps)" +
        (outcome.blocked.length ? " with BLOCKED steps" : "") +
        " — exit 0",
    );
  }
})();
