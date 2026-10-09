#!/usr/bin/env node
/**
 * Focused notifications E2E against an isolated Postgres database, the real
 * Fastify API, and the real nana-wallet browser route. The DB container/name,
 * URL, backend port, and Portless route can be overridden for CI or worktrees.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const ROOT = process.cwd();
const DB_CONTAINER = process.env.NANA_E2E_DB_CONTAINER ?? "nana-privy-impl-db-1";
const DB_NAME = process.env.NANA_E2E_DB_NAME ?? "wdk_agent";
const DATABASE_URL = process.env.NANA_E2E_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/wdk_agent?options=-csearch_path%3Dpublic,extensions";
// Fixture identity the seed and the backend agree on. Mirrors
// tests/fixtures/test-server.ts TEST_USER_ID (plain-node script: no TS import).
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
const BACKEND_PORT = process.env.NANA_E2E_BACKEND_PORT ?? "3124";
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const PORTLESS_NAME = process.env.NANA_E2E_PORTLESS_NAME ?? "slice5-notifications-e2e";
const FRONTEND_URL = process.env.NANA_E2E_FRONTEND_URL ?? `https://${PORTLESS_NAME}.localhost`;
const seedId = randomUUID();
const chainSignature = `e2e-${seedId}`;
const chainDedupeKey = `chain:solana-devnet:${createHash("sha256")
  .update(["solana-devnet", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", chainSignature, "confirmed_transfer"].join("|"))
  .digest("hex")}`;
const children = [];
let seeded;

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", DB_NAME, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function start(command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

async function waitFor(url, expectedStatus, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Already stopped.
  }
}

async function main() {
  let browser;
  try {
    start("./node_modules/.bin/tsx", ["src/server.ts"], {
      cwd: ROOT,
      env: {
        DATABASE_URL,
        WDK_TOOLS_SOURCE: "fixture",
        AGENT_RUNTIME: "deterministic",
        IDENTITY_PROVIDER: "demo",
        NOTIFICATIONS_RECONCILIATION_ENABLED: "false",
        PORT: BACKEND_PORT,
        HOST: "127.0.0.1",
        CORS_ORIGINS: new URL(FRONTEND_URL).origin,
      },
    });
    await waitFor(`${BACKEND_URL}/health`, 200);

    seeded = JSON.parse(
      execFileSync("./node_modules/.bin/tsx", ["scripts/seed-notifications-browser-e2e.ts"], {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL,
          NOTIFICATIONS_E2E_SEED_ID: seedId,
        },
        encoding: "utf8",
      }).trim(),
    );

    let feedBody;
    const feedDeadline = Date.now() + 30_000;
    while (Date.now() < feedDeadline) {
      const feedResponse = await fetch(`${BACKEND_URL}/v1/notifications`);
      feedBody = await feedResponse.json();
      const titles = new Set(feedBody?.data?.map((item) => item.title));
      if (
        feedResponse.ok &&
        titles.has("Transferencia enviada") &&
        titles.has("Depósito confirmado")
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const titles = new Set(feedBody?.data?.map((item) => item.title));
    if (!titles.has("Transferencia enviada") || !titles.has("Depósito confirmado")) {
      throw new Error(`Feed did not receive outbox + reconciled events: ${JSON.stringify(feedBody)}`);
    }
    console.log("PASS HTTP feed receives assistant outbox and reconciled inbound events");

    start("portless", [PORTLESS_NAME, "npm", "run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: `${ROOT}/apps/nana-wallet`,
      env: {
        VITE_IDENTITY_PROVIDER: "demo",
        VITE_API_URL: BACKEND_URL,
        VITE_E2E_REAL_BACKEND: "1",
        VITE_AGENT_BACKEND: "1",
      },
    });
    await waitFor(FRONTEND_URL, 200);

    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${FRONTEND_URL}/notificaciones`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("notifications-page").waitFor({ state: "visible" });
    await page.getByText("Transferencia enviada", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("Depósito confirmado", { exact: true }).waitFor({ state: "visible" });
    for (const title of ["Transferencia enviada", "Depósito confirmado"]) {
      const markRead = page.getByRole("button", { name: `Marcar como leída: ${title}` });
      await markRead.waitFor({ state: "visible" });
      await markRead.click();
      await markRead.waitFor({ state: "detached" });
    }
    await page.getByText("Estás al día.", { exact: true }).waitFor({ state: "visible" });

    const read = psql(
      `SELECT count(*) FROM wallet_notifications
       WHERE user_id = '${TEST_USER_ID}'
         AND dedupe_key IN ('${seeded.assistantDedupeKey}', '${seeded.chainDedupeKey}')
         AND read_at IS NOT NULL`,
    );
    if (read !== "2") throw new Error(`Expected both rows marked read in Postgres (got ${read})`);
    console.log("PASS browser inbox renders both event sources and marks them read in Postgres");
  } finally {
    await browser?.close().catch(() => {});
    for (const child of children.reverse()) await stop(child);
    try {
      psql(
        `DELETE FROM wallet_notifications WHERE user_id = '${TEST_USER_ID}'
         AND dedupe_key IN ('assistant-transfer:${seedId}:submitted', '${chainDedupeKey}')`,
      );
      psql(`DELETE FROM assistant_lifecycle_outbox WHERE attempt_id = '${seedId}'`);
      psql(`DELETE FROM reconciliation_cursors WHERE wallet_id = '${seedId}'`);
      psql(`DELETE FROM user_wallets WHERE id = '${seedId}'`);
      psql(`DELETE FROM conversations WHERE id = '${seedId}'`);
    } catch {
      // The DB may not have been reachable before seeding.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
