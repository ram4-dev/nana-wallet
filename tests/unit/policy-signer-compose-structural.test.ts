import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Design §6.2/§6.3, task 2.6 — the deployment wiring of the signed-authorization
 * capability, asserted structurally.
 *
 * WHY STRUCTURAL, AND WHY IT CARRIES THE SECRET-SAFETY GUARANTEE
 * --------------------------------------------------------------
 * The properties this unit must hold are properties of the deployment
 * description, not of any runtime behaviour: no signer service publishes a port,
 * both signer services share their consumer's network namespace, and no key
 * variable or key mount reaches `frontend`, `backend` or `voice-worker`. A test
 * that reads the compose files proves all three without starting a container and
 * without reading, printing or storing a secret value — it never resolves the
 * `${...}` interpolations, only their NAMES.
 *
 * The positive control comes first in every case: the assertions below assert on
 * a service block that was really found, so "no key variable is declared" cannot
 * pass because the block or the file was missing.
 */

const COMPOSE_FILES = ["compose.privy-local.yaml", "compose.yaml"] as const;

/** Variables that identify or unlock the authorization signing key. */
const KEY_VARIABLES = [
  "PRIVY_AUTHORIZATION_PRIVATE_KEY",
  "PRIVY_SIGNER_KEY_FILE",
] as const;
/** The shared bearer token is a capability the two consumers legitimately hold. */
const TOKEN_VARIABLE = "PRIVY_SIGNER_TOKEN";
/** A mount of the private key file into a consumer container. */
const KEY_MOUNT = "privy-authorization-private-key";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Splits a compose file into `service name -> that service's lines`. Compose
 * service keys sit at two-space indentation directly under `services:`; every
 * key inside a service block is indented further, and `name:`/`x-identity:`/
 * `volumes:` are top-level, so this small shape is enough and needs no YAML
 * dependency (the repository has none; the same reason
 * `tests/unit/signer-worker-path.test.ts` reads files instead of models).
 */
function servicesOf(file: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let inServices = false;
  let current: string | undefined;

  for (const line of file.split("\n")) {
    if (/^services:\s*$/u.test(line)) {
      inServices = true;
      current = undefined;
      continue;
    }
    if (/^\S/u.test(line)) {
      inServices = false;
      current = undefined;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/u.exec(line);
    if (service) {
      current = service[1];
      found.set(current, []);
      continue;
    }
    if (current) found.get(current)?.push(line);
  }

  return found;
}

function blockOf(file: string, service: string): string[] {
  const services = servicesOf(file);
  const block = services.get(service);
  // Positive control: fail loudly HERE if the service was not parsed, so every
  // negative assertion below is guarded against a vacuous pass.
  expect(
    block,
    `${service} must exist in this compose file`,
  ).toBeDefined();
  return block ?? [];
}

function composeYaml(): { file: string; services: Map<string, string[]> }[] {
  return COMPOSE_FILES.map((path) => {
    const file = repoFile(path);
    const services = servicesOf(file);
    // Positive control for the parser itself.
    expect(services.size, `${path} must declare services`).toBeGreaterThan(0);
    return { file: path, services };
  });
}

describe("compose files declare the signed-authorization capability", () => {
  it("runs one loopback signing sidecar per consumer namespace", () => {
    const local = servicesOf(repoFile("compose.privy-local.yaml"));

    for (const [service, consumer, port] of [
      ["backend-signer", "backend", "8788"],
      ["voice-worker-signer", "voice-worker", "8789"],
    ] as const) {
      const block = local.get(service);
      expect(block, `${service} must exist`).toBeDefined();
      const lines = (block ?? []).join("\n");

      expect(lines).toContain(`network_mode: "service:${consumer}"`);
      expect(lines).toContain('entrypoint: ["/bin/sh", "-c"]');
      expect(lines).toContain("node dist/wallet/signer/server.js");
      expect(lines).toContain(`PRIVY_SIGNER_HOST: 127.0.0.1`);
      expect(lines).toContain(`PRIVY_SIGNER_PORT: "${port}"`);
      expect(lines).toContain(
        "PRIVY_SIGNER_KEY_FILE: /run/secrets/privy-authorization-private-key",
      );
      expect(lines).toContain(":/run/secrets:ro");
      // The first line of defence: a signer service publishes NO host port.
      expect(lines).not.toMatch(/^\s*ports:/mu);
    }
  });

  it("reaches the sidecar over the consumer's own loopback and accepts no key", () => {
    const local = servicesOf(repoFile("compose.privy-local.yaml"));

    for (const [service, port] of [
      ["backend", "8788"],
      ["voice-worker", "8789"],
    ] as const) {
      const lines = blockOf(repoFile("compose.privy-local.yaml"), service).join(
        "\n",
      );
      expect(local.get(service), `${service} must exist`).toBeDefined();
      expect(lines).toContain(`PRIVY_SIGNER_URL: "http://127.0.0.1:${port}/sign"`);
      expect(lines).toContain("PRIVY_SIGNER_TIMEOUT_MS");
      expect(lines).toContain("PRIVY_SIGNER_TOKEN:");
      // The backend and the worker hold the capability, never the key.
      for (const variable of KEY_VARIABLES) {
        expect(lines).not.toContain(variable);
      }
      expect(lines).not.toContain(KEY_MOUNT);
    }
  });

  it("declares no key variable, token or key mount on frontend, backend or voice-worker in any compose file", () => {
    for (const { file, services } of composeYaml()) {
      for (const consumer of ["frontend", "backend", "voice-worker"] as const) {
        const block = services.get(consumer);
        if (!block) continue; // compose.yaml gates these behind profiles.
        const lines = block.join("\n");
        for (const variable of KEY_VARIABLES) {
          expect(lines, `${file}:${consumer} must not declare ${variable}`).not.toContain(
            variable,
          );
        }
        expect(lines, `${file}:${consumer} must not mount the key`).not.toContain(
          KEY_MOUNT,
        );
      }
    }

    // Positive control: `frontend` really was found and really is key-free, with
    // only the browser app id it always had.
    const frontend = blockOf(repoFile("compose.privy-local.yaml"), "frontend").join(
      "\n",
    );
    expect(frontend).toContain("VITE_PRIVY_APP_ID");
    expect(frontend).not.toContain(TOKEN_VARIABLE);
  });

  it("documents the three signer variables by name, with no value, in the environment template", () => {
    const template = repoFile(".env.example");

    for (const variable of [
      "PRIVY_SIGNER_URL",
      "PRIVY_SIGNER_TOKEN",
      "PRIVY_SIGNER_TIMEOUT_MS",
    ]) {
      expect(template, `.env.example must document ${variable}`).toContain(
        variable,
      );
    }
    // Names and placeholders only: the template must never carry a key.
    expect(template).not.toContain(KEY_MOUNT);
  });
  it("gives both consumers the quorum and public key required to verify their signing authority", () => {
    for (const consumer of ["backend", "voice-worker"]) {
      const lines = blockOf(repoFile("compose.privy-local.yaml"), consumer).join("\n");
      expect(lines).toContain("PRIVY_AUTHORIZATION_KEY_QUORUM_ID:");
      expect(lines).toContain("PRIVY_AUTHORIZATION_PUBLIC_KEY:");
    }
  });

});
