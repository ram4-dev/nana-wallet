import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handlers } from "@/mocks/handlers";

/** Se resuelve el prefijo una vez: el suite corre desde `apps/nana-wallet/`. */
const FRONT_ROOT = existsSync("src/lib/api.ts") ? "." : "apps/nana-wallet";

function frontFile(relative: string): string {
  return readFileSync(path.join(FRONT_ROOT, relative), "utf8");
}

/**
 * Task 4.1: the MSW fixtures that mirror the alias contract. Every row below is
 * reached through the real HTTP path the app uses, so a fixture that drifts from
 * the mirrored shapes fails here rather than in a screen test.
 */
const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "http://localhost:3000/v1";

function handlerPaths(): string[] {
  return handlers.map((handler) => String(handler.info.path));
}

/**
 * The guard that makes the failures below attributable: without the handler the
 * assertions would fail on an unhandled request instead of on the fixture.
 */
function requireHandler(path: string): void {
  expect(handlerPaths(), `${path} is registered as an MSW fixture`).toContain(path);
}

async function post(path: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ALIAS_RESOLVED_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const SOPHIE_ADDRESS = "swqrv48gsrwpBFbftEwnP2vB4jckpvfGJfXkwaniLCC";

describe("alias resolution fixtures (task 4.1)", () => {
  it("keeps the pre-existing contact fixtures reachable", async () => {
    // POSITIVE CONTROL: the fixture module is loaded and serving today's
    // surface, so a later failure is about the alias fixtures and nothing else.
    const response = await fetch(`${BASE}/contacts`);
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as { ok: boolean; data: unknown[] };
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data)).toBe(true);
  });

  it("registers the resolve and check-alias handlers", () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    requireHandler("*/v1/contacts/:id/check-alias");
  });

  it("serves one fixture per resolution taxonomy row", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const rows: Array<[string, number, string]> = [
      ["juan", 422, "DATOS_INVALIDOS"],
      ["juan.sol", 422, "NOMBRE_NO_SOPORTADO"],
      ["fantasma.sns", 404, "NOMBRE_NO_ENCONTRADO"],
      ["ambiguo.sns", 409, "NOMBRE_AMBIGUO"],
      ["lento.sns", 503, "RESOLVEDOR_NO_DISPONIBLE"],
    ];
    for (const [name, status, code] of rows) {
      const response = await post("/recipient-aliases/resolve", { name });
      expect(response.status, name).toBe(status);
      const envelope = (await response.json()) as { ok: boolean; error?: { code: string } };
      expect(envelope.ok, name).toBe(false);
      expect(envelope.error?.code, name).toBe(code);
    }
    // The unreachable row is never the not-found row: a 503 instead of a 404.
    const unreachable = await post("/recipient-aliases/resolve", { name: "lento.sns" });
    expect(unreachable.status).not.toBe(404);
  });

  it("serves the resolved name with each of the three reverse states", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const rows: Array<[string, string, string | null]> = [
      ["sophie.sns", "present", "sophie.sns"],
      ["juan.sns", "none", null],
      ["raro.sns", "unknown", null],
    ];
    for (const [name, state, domain] of rows) {
      const response = await post("/recipient-aliases/resolve", { name });
      expect(response.status, name).toBe(200);
      const envelope = (await response.json()) as {
        ok: boolean;
        data: { address: string; name: string; reverseDomainState: string; reverseDomain: unknown };
      };
      expect(envelope.data.name, name).toBe(name);
      expect(envelope.data.reverseDomainState, name).toBe(state);
      expect(envelope.data.reverseDomain, name).toBe(domain);
      expect(envelope.data.address, name).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      // Nothing secret-ish and no chain selector on the wire.
      expect(Object.keys(envelope.data).sort()).toEqual(
        ["address", "name", "resolvedAt", "resolver", "reverseDomain", "reverseDomainState"].sort(),
      );
    }
  });

  it("refuses a resolve body that is not exactly `{ name }`", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    for (const body of [{}, { name: "juan.sns", chain: "solana" }, { alias: "juan.sns" }]) {
      const response = await post("/recipient-aliases/resolve", body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("check-alias drift fixtures (task 4.1)", () => {
  it("reports each drift state for a contact that carries an alias", async () => {
    requireHandler("*/v1/contacts/:id/check-alias");
    const rows: Array<[string, string]> = [
      ["contact-alias-unchanged", "unchanged"],
      ["contact-alias-changed", "changed"],
      ["contact-alias-unreachable", "unavailable"],
    ];
    for (const [contactId, state] of rows) {
      const response = await post(`/contacts/${contactId}/check-alias`);
      expect(response.status, contactId).toBe(200);
      const envelope = (await response.json()) as { ok: boolean; data: { state: string } };
      expect(envelope.data.state, contactId).toBe(state);
    }
  });

  it("refuses a contact with no alias and one that does not exist", async () => {
    requireHandler("*/v1/contacts/:id/check-alias");
    const noAlias = await post("/contacts/contact-sofia/check-alias");
    expect(noAlias.status).toBe(409);
    expect(((await noAlias.json()) as { error: { code: string } }).error.code).toBe(
      "CONTACTO_SIN_ALIAS",
    );
    const missing = await post("/contacts/contact-nowhere/check-alias");
    expect(missing.status).toBe(404);
    // La palabra del frente para "no existe" es `NO_ENCONTRADO` (la que usan
    // todos los handlers de contactos de este archivo); el código del backend en
    // la tabla del design §7 es `CONTACTO_NO_ENCONTRADO` y no tiene miembro
    // propio en `ErrCode` — una brecha preexistente que esta unidad no cambia.
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "NO_ENCONTRADO",
    );
  });

  it("never reports an unreachable resolver as a changed name", async () => {
    requireHandler("*/v1/contacts/:id/check-alias");
    const response = await post("/contacts/contact-alias-unreachable/check-alias");
    const envelope = (await response.json()) as {
      data: { state: string; observedAddress?: string };
    };
    expect(envelope.data.state).toBe("unavailable");
    expect(envelope.data.observedAddress).toBeUndefined();
  });
});

describe("alias create fixtures (task 4.1)", () => {
  it("stores the server-resolved address with its alias evidence", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const response = await post("/contacts", {
      source: "sns",
      name: "Sofía",
      snsName: "sophie.sns",
      expectedAddress: SOPHIE_ADDRESS,
      description: "",
      network: "solana-devnet",
    });
    expect(response.status).toBe(201);
    const envelope = (await response.json()) as {
      data: { address: string; alias?: { name: string } | null; duplicateOf?: unknown };
    };
    // The stored destination is the resolved address, never the alias.
    expect(envelope.data.address).toBe(SOPHIE_ADDRESS);
    expect(envelope.data.alias).toEqual({
      name: "sophie.sns",
      resolvedAt: expect.any(String),
    });
    // The disclosure is a flat sibling field, never a wrapper object, and it is
    // `null` when no active contact holds that address.
    expect(envelope.data).toHaveProperty("duplicateOf");
    expect(envelope.data.duplicateOf).toBeNull();
  });

  it("discloses an existing holder by name and still creates the contact", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const response = await post("/contacts", {
      source: "sns",
      name: "Juan",
      snsName: "juan.sns",
      expectedAddress: ALIAS_RESOLVED_ADDRESS,
      description: "",
    });
    expect(response.status).toBe(201);
    const envelope = (await response.json()) as {
      data: { address: string; duplicateOf?: { contactId: string; name: string } | null };
    };
    expect(envelope.data.address).toBe(ALIAS_RESOLVED_ADDRESS);
    expect(envelope.data.duplicateOf).toEqual({
      contactId: "contact-alias-unchanged",
      name: "Nieta Sol",
    });
  });

  it("still writes a pasted address with no alias evidence", async () => {
    const response = await post("/contacts", {
      name: "Ana",
      description: "Mi vecina",
      address: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    });
    expect(response.status).toBe(201);
    const envelope = (await response.json()) as { data: { address: string; alias?: unknown } };
    expect(envelope.data.address).toBe("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
    expect(envelope.data.alias ?? null).toBeNull();
  });

  it("refuses the wallet's own address on the alias arm", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const response = await post("/contacts", {
      source: "sns",
      name: "Nana",
      snsName: "nanatest.sns",
      expectedAddress: "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv",
      description: "",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "DIRECCION_PROPIA",
    );
  });

  it("refuses a name the fake deployment does not know instead of resolving it live", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const response = await post("/contacts", {
      source: "sns",
      name: "Juan",
      snsName: "desconocido.sns",
      expectedAddress: ALIAS_RESOLVED_ADDRESS,
      description: "",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "NOMBRE_NO_ENCONTRADO",
    );
  });

  it("refuses an alias create whose echoed address no longer matches", async () => {
    requireHandler("*/v1/recipient-aliases/resolve");
    const response = await post("/contacts", {
      source: "sns",
      name: "Sofía",
      snsName: "sophie.sns",
      expectedAddress: ALIAS_RESOLVED_ADDRESS,
      description: "",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "SNS_DESTINO_CAMBIADO",
    );
  });
});

describe("front/back separation (task 4.1)", () => {
  it("keeps the mirrored frontend files free of backend imports", () => {
    for (const relative of ["src/lib/api-types.ts", "src/lib/api.ts", "src/mocks/handlers.ts"]) {
      const source = frontFile(relative);
      expect(source, relative).not.toMatch(/from\s+["'][^"']*\.\.\/\.\.\/\.\.\/src\//);
      expect(source, relative).not.toMatch(/from\s+["'][^"']*\/src\/(contracts|wallet|agent)\//);
      expect(source, relative).not.toMatch(/@bonfida|@solana\/web3/);
    }
  });
});
