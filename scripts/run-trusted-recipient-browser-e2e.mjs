#!/usr/bin/env node
/**
 * Trusted-recipient browser E2E harness (task 3.4, design §12.2 "Browser E2E").
 *
 * Shape follows the sibling harnesses (`scripts/run-browser-e2e.mjs`,
 * `scripts/run-notifications-browser-e2e.mjs`): one plain-node orchestrator with
 * recorded PASS/FAIL/BLOCKED steps, spawned-process cleanup, and exit 1 on any
 * FAIL. What differs is the boot: identity is ALWAYS Privy now
 * (`src/server.ts`), so an out-of-process harness cannot authenticate without real
 * credentials. The real backend is therefore booted on a real port by
 * `scripts/trusted-recipient-browser-e2e-driver.ts` through the repository's
 * documented seam (`buildTestServer`, the same one the integration suites use),
 * against the REAL database, and the browser layer talks to that same server.
 *
 * WHAT THIS EXECUTES
 * ------------------
 *   1. HTTP + DB layer over the REAL api + database + policy adapter. The adapter
 *      transport is NEVER live here: no signed authorization capability is
 *      configured, so the service holds the `unavailable` port and the readiness
 *      stays `pending` / `retryable_failure` — the honest, unverified outcome.
 *      Scenarios: create / edit / remove, reload with the same `permission.state`,
 *      retry from `retryable_failure`, the honest (never verified) revocation
 *      disclosure, the duplicate alias, a recipient on a wallet with no ready
 *      permission staying saved-and-not-enabled, and the refusal of any chain
 *      selection. Reported by the driver and merged here.
 *   2. MSW-fixture layer: every readiness state and every new error code is served
 *      by the mirrored fixture layer, proven by its own suites.
 *   3. Browser layer (playwright chromium, dev MSW worker opted out): the real
 *      recipient screen against the real API.
 *
 * A missing chromium or an unstartable dev server is reported BLOCKED with its
 * exact blocker and never counted as a pass; the summary prints the full scenario
 * list so "executed" and "not executed" are never conflated.
 *
 * `npm run db:migrate` is deliberately not run (it fails locally on a pre-existing
 * `relation "conversations" already exists`); the database already reflects the
 * Supabase chain. Knobs: NANA_E2E_DB_CONTAINER, NANA_E2E_DB_NAME, NANA_E2E_DB_PORT,
 * NANA_E2E_DATABASE_URL, NANA_E2E_BACKEND_PORT, NANA_E2E_FRONTEND_PORT,
 * NANA_E2E_FRONTEND_URL, NANA_E2E_HEADLESS=0.
 */

import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tests", "e2e", "browser", ".tmp");
const appDir = path.join(repoRoot, "apps", "nana-wallet");

const BACKEND_PORT = process.env.NANA_E2E_BACKEND_PORT ?? "3129";
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_PORT = process.env.NANA_E2E_FRONTEND_PORT ?? "5201";
const FRONTEND_URL = process.env.NANA_E2E_FRONTEND_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;

const ADDRESS_2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const results = [];
const children = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitForStatus(url, expectedStatus, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === expectedStatus) return res;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label} (${url}): ${last}`);
}

function spawnDetached(command, args, { cwd, env, log }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log],
  });
  children.push(child);
  return child;
}

async function stop(child, label) {
  if (!child || child.exitCode !== null) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
    if (signal === "SIGTERM") {
      try {
        execFileSync("sleep", ["1"]);
      } catch {
        // Ignore.
      }
    }
  }
  console.log(`  · stopped ${label} (pid ${child.pid})`);
}

/**
 * Runs the driver, collecting its scenario lines. Resolves with the driver process
 * once every HTTP/DB scenario has been reported — the driver keeps serving so the
 * browser layer can use the same real api.
 */
function startDriver(load) {
  const script = path.join(repoRoot, "scripts", "trusted-recipient-browser-e2e-driver.ts");
  const child = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), [script], {
    cwd: repoRoot,
    env: { ...process.env, NANA_E2E_BACKEND_PORT: BACKEND_PORT },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffered = "";
  let scenariosDone;
  const done = new Promise((resolve) => {
    scenariosDone = resolve;
  });

  const consume = (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("E2E_DRIVER_READY ")) {
        load(JSON.parse(line.slice("E2E_DRIVER_READY ".length)));
      } else if (line.startsWith("E2E_SCENARIO ")) {
        const scenario = JSON.parse(line.slice("E2E_SCENARIO ".length));
        record(scenario.status, scenario.name, scenario.detail);
      } else if (line.startsWith("E2E_DRIVER_SCENARIOS_DONE")) {
        scenariosDone();
      } else if (line.trim()) {
        console.log(`  · driver: ${line}`);
      }
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.log(`  · driver(stderr): ${line}`);
    }
  });
  return { child, scenariosDone: done };
}

const BROWSER_SCENARIOS = [
  'browser: the recipient row renders the readback-backed state and never "habilitado"',
  "browser: the address edit shows the revocation disclosure before submitting anything",
  "browser: the recipient form exposes no chain picker",
  "browser: removing the recipient shows the disclosure dialog before deleting",
];

async function browserLayer() {
  let browser = null;
  let chromiumBlocker = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: process.env.NANA_E2E_HEADLESS !== "0" });
    record("PASS", "browser: playwright chromium launch");
  } catch (error) {
    chromiumBlocker = error instanceof Error ? error.message : String(error);
    record("BLOCKED", "browser: playwright chromium launch", chromiumBlocker);
  }

  if (!browser) {
    for (const scenario of BROWSER_SCENARIOS) record("BLOCKED", scenario, chromiumBlocker);
    return;
  }

  const frontendLog = openSync(path.join(tmpDir, "trusted-recipient-frontend.log"), "a");
  spawnDetached("npm", ["run", "dev", "--", "--port", FRONTEND_PORT, "--host", "127.0.0.1"], {
    cwd: appDir,
    env: {
      VITE_IDENTITY_PROVIDER: "demo",
      VITE_API_URL: BACKEND_URL,
      // Opts the dev MSW worker out so the browser observes the REAL backend
      // (`apps/nana-wallet/src/client.tsx`).
      VITE_E2E_REAL_BACKEND: "1",
    },
    log: frontendLog,
  });

  let frontendReady = false;
  try {
    await waitForStatus(`${FRONTEND_URL}/`, 200, 90_000, "frontend /");
    frontendReady = true;
    record("PASS", "browser: frontend dev server ready (dev MSW worker opted out)", FRONTEND_URL);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record("BLOCKED", "browser: frontend dev server ready", detail);
    for (const scenario of BROWSER_SCENARIOS) record("BLOCKED", scenario, detail);
  }

  if (frontendReady) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const consoleLogs = [];
    page.on("console", (msg) => consoleLogs.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${err.message}`));
    const diagnose = async () => {
      const main = await page.locator("main").first().innerText().catch(() => "");
      return `${main.slice(0, 500)}\n--- console ---\n${consoleLogs.slice(-12).join("\n")}`;
    };
    const fail = async (name, error) => {
      if (!results.some((entry) => entry.name === name)) {
        const detail = `${error instanceof Error ? error.message : String(error)}\n${await diagnose()}`;
        record("FAIL", name, detail);
      }
    };

    try {
      await page.goto(`${FRONTEND_URL}/perfil`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("add-recipient").waitFor({ state: "visible" });
      await page.getByText("E2E-TR", { exact: false }).first().waitFor({ state: "visible" });
    } catch (error) {
      // An unauthenticated browser is a BLOCKER for the whole browser layer, not a
      // defect in the screen: the frontend attaches only `usePrivy().getAccessToken()`
      // (`apps/nana-wallet/src/routes/__root.tsx`, `ApiTokenBridge`), so without a
      // Privy session every read is unauthenticated. Detect that exact state
      // (Privy gate redirect, or the profile error the unauthenticated read renders)
      // and report the blocker instead of a screen failure. Anything else stays a FAIL.
      const path = (() => {
        try {
          return new URL(page.url()).pathname;
        } catch {
          return "";
        }
      })();
      const body = await page.locator("body").innerText().catch(() => "");
      const noSession =
        /^\/login\b/.test(path) || /No pudimos leer tu perfil/.test(body);
      const detail = noSession
        ? "no authenticated browser session: the frontend attaches only usePrivy().getAccessToken() (apps/nana-wallet/src/routes/__root.tsx) and this environment has no Privy credentials, so the real API answers 401 and the recipient surface never renders"
        : "the recipient surface never rendered; see the first failure";
      if (noSession) {
        record("BLOCKED", "browser layer: an authenticated session is required", detail);
      } else {
        await fail(BROWSER_SCENARIOS[0], error);
      }
      const first = noSession
        ? BROWSER_SCENARIOS
        : BROWSER_SCENARIOS.slice(1);
      for (const scenario of first) record("BLOCKED", scenario, detail);
      await browser.close().catch(() => {});
      return;
    }

    try {
      const body = await page.locator("body").innerText();
      const claimsEnabled = /habilitad/i.test(body);
      record(
        claimsEnabled ? "FAIL" : "PASS",
        BROWSER_SCENARIOS[0],
        claimsEnabled
          ? "the screen claims an enabled recipient without a verified readback"
          : 'no "habilitado" wording on an unverified deployment',
      );
    } catch (error) {
      await fail(BROWSER_SCENARIOS[0], error);
    }

    try {
      const row = page.locator("li", { hasText: "E2E-TR Editable" }).first();
      await row.getByRole("button", { name: "Editar" }).click();
      const addressField = page.getByLabel("Dirección");
      await addressField.waitFor({ state: "visible" });
      await addressField.fill(ADDRESS_2);
      await page.getByRole("button", { name: "Guardar cambios" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor({ state: "visible" });
      const dialogText = await dialog.innerText();
      const stillOnScreen = await page.getByLabel("Dirección").isVisible();
      record(
        stillOnScreen ? "PASS" : "FAIL",
        BROWSER_SCENARIOS[1],
        `disclosure="${dialogText.split("\n").slice(0, 2).join(" / ")}"`,
      );
      await dialog.getByRole("button", { name: "Cancelar" }).click();
    } catch (error) {
      await fail(BROWSER_SCENARIOS[1], error);
    }

    try {
      const comboboxes = await page.getByRole("combobox").count();
      record(comboboxes === 0 ? "PASS" : "FAIL", BROWSER_SCENARIOS[2], `comboboxes=${comboboxes}`);
    } catch (error) {
      await fail(BROWSER_SCENARIOS[2], error);
    }

    try {
      const row = page.locator("li", { hasText: "E2E-TR Editable" }).first();
      await row.getByRole("button", { name: "Quitar" }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor({ state: "visible" });
      const dialogText = await dialog.innerText();
      const stillOnScreen = await row.isVisible();
      record(
        stillOnScreen ? "PASS" : "FAIL",
        BROWSER_SCENARIOS[3],
        `disclosure="${dialogText.split("\n").slice(0, 2).join(" / ")}"`,
      );
      await dialog.getByRole("button", { name: "Cancelar" }).click();
    } catch (error) {
      await fail(BROWSER_SCENARIOS[3], error);
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  await browser.close().catch(() => {});
  try {
    closeSync(frontendLog);
  } catch {
    // Already closed.
  }
}

async function mswFixtureLayer() {
  const name =
    "MSW fixtures: every readiness state and every new error code is served by the fixture layer";
  try {
    execFileSync(
      "npx",
      ["vitest", "run", "src/mocks/handlers.test.ts", "src/features/wallet/AddTrustedRecipient.test.tsx"],
      { cwd: appDir, encoding: "utf8", stdio: "pipe" },
    );
    record("PASS", name, "src/mocks/handlers.test.ts + AddTrustedRecipient.test.tsx");
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`
      .split("\n")
      .filter((line) => line.trim())
      .slice(-10)
      .join(" | ");
    record("FAIL", name, output || String(error));
  }
}

async function main() {
  mkdirSync(tmpDir, { recursive: true });
  const backendLog = openSync(path.join(tmpDir, "trusted-recipient-backend.log"), "a");

  let driverReady = null;
  const driver = startDriver((info) => {
    driverReady = info;
  });

  const readyDeadline = Date.now() + 60_000;
  while (!driverReady && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!driverReady) {
    record("FAIL", "driver: real backend booted with the fixture identity seam", "no E2E_DRIVER_READY line within 60 s");
  } else {
    record(
      "PASS",
      "driver: real backend listening over the real database with the fixture identity seam",
      driverReady.url,
    );
    await Promise.race([
      driver.scenariosDone,
      new Promise((resolve) => setTimeout(resolve, 120_000)),
    ]);
  }

  await mswFixtureLayer();
  await browserLayer();

  console.log("\n=== trusted-recipient browser E2E scenario list ===");
  for (const entry of results) console.log(`  [${entry.status}] ${entry.name}`);

  const passed = results.filter((entry) => entry.status === "PASS");
  const failed = results.filter((entry) => entry.status === "FAIL");
  const blocked = results.filter((entry) => entry.status === "BLOCKED");
  console.log(
    `\nSCENARIOS: ${results.length}  PASS: ${passed.length}  FAIL: ${failed.length}  BLOCKED: ${blocked.length}`,
  );
  if (failed.length) {
    console.log("FAILING SCENARIOS:");
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
  }
  if (blocked.length) {
    console.log("BLOCKED SCENARIOS (implemented, NOT executed — exact blocker):");
    for (const entry of blocked) console.log(`  - ${entry.name}: ${entry.detail}`);
  }

  for (const child of children.slice().reverse()) {
    await stop(child, "harness child");
  }
  for (const fd of [backendLog]) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }

  if (failed.length) {
    console.log("\nRESULT: FAIL (at least one scenario failed) — exit 1");
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nRESULT: PASS (no failed scenario)${blocked.length ? ` with ${blocked.length} BLOCKED (not executed)` : ""} — exit 0`,
  );
}

main().catch((error) => {
  console.error("Fatal harness error:", error);
  process.exitCode = 1;
});
