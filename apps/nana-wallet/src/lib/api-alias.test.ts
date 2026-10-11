import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { api, setApiTokenSource } from "@/lib/api";

/**
 * El suite corre desde `apps/nana-wallet/` (`npm test`), pero también tiene que
 * funcionar si se lo invoca desde la raíz del repo; se resuelve el prefijo una
 * vez en vez de depender de la URL del módulo.
 */
const FRONT_ROOT = existsSync("src/lib/api.ts") ? "." : "apps/nana-wallet";

function frontFile(relative: string): string {
  return readFileSync(path.join(FRONT_ROOT, relative), "utf8");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okEnvelope(data: unknown, status = 200) {
  return jsonResponse({ ok: true, data }, status);
}

function errEnvelope(code: string, message: string, status: number) {
  return jsonResponse({ ok: false, error: { code, message } }, status);
}

beforeEach(() => {
  setApiTokenSource({ getToken: async () => "test-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setApiTokenSource(null);
});

const ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const OTHER_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";

const RESOLVE_DATA = {
  name: "juan.sns",
  address: ADDRESS,
  resolvedAt: "2026-10-10T18:04:11.482Z",
  resolver: "sns/solana-devnet/v3",
  reverseDomain: null,
  reverseDomainState: "none" as const,
};

const CONTACT_DATA = {
  id: "0b2f0d68-9f43-4a4b-8f2b-1f39a4d3a001",
  name: "Juan",
  description: "",
  address: ADDRESS,
  network: "solana-devnet" as const,
  version: 1,
  status: "active" as const,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  permission: {
    state: "pending" as const,
    desiredRevision: 1,
    appliedRevision: 0,
    retryable: true,
  },
};

/**
 * Task 4.1: the mirrored alias client. The backend contract is the source of
 * truth (`src/contracts/http.ts`); this suite pins the frontend side of the same
 * shape, the taxonomy's code passthrough and the additivity of the paste path.
 */
describe("recipient alias API mirror (task 4.1)", () => {
  it("exposes the two mirrored alias methods", () => {
    // POSITIVE CONTROL: the surface the tests below drive exists, so a later
    // failure is about behavior and not about a missing method.
    expect(typeof api.resolveRecipientAlias).toBe("function");
    expect(typeof api.checkContactAlias).toBe("function");
  });

  it("resolves a name with a strict read-only POST body", async () => {
    expect(typeof api.resolveRecipientAlias).toBe("function");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okEnvelope(RESOLVE_DATA));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.resolveRecipientAlias({ name: "juan.sns" })).resolves.toEqual(RESOLVE_DATA);

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/recipient-aliases/resolve")).toBe(true);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "juan.sns" });
    // A read mints no idempotency key: nothing here can be replayed.
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeNull();
  });

  it("passes every resolution taxonomy code through unchanged", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const rows: Array<[string, number]> = [
      ["DATOS_INVALIDOS", 422],
      ["NOMBRE_NO_SOPORTADO", 422],
      ["NOMBRE_NO_ENCONTRADO", 404],
      ["NOMBRE_AMBIGUO", 409],
      ["RESOLVEDOR_NO_DISPONIBLE", 503],
    ];
    for (const [code, status] of rows) {
      fetchMock.mockResolvedValueOnce(errEnvelope(code, `mensaje ${code}`, status));
      const error = await api.resolveRecipientAlias({ name: "juan.sns" }).catch((caught) => caught);
      expect(error, code).toMatchObject({ code, status });
      expect(String(error?.message), code).toContain(code);
    }
    // The property the spec actually protects: an unreachable resolver is never
    // reported as a non-existent name (nor as a changed one).
    fetchMock.mockResolvedValueOnce(
      errEnvelope("RESOLVEDOR_NO_DISPONIBLE", "No pudimos consultar el nombre.", 503),
    );
    const unreachable = await api
      .resolveRecipientAlias({ name: "juan.sns" })
      .catch((caught) => caught);
    expect(unreachable?.code).not.toBe("NOMBRE_NO_ENCONTRADO");
    expect(unreachable?.code).not.toBe("SNS_DESTINO_CAMBIADO");
  });

  it("keeps the three reverse-domain states distinguishable on the wire", async () => {
    expect(typeof api.resolveRecipientAlias).toBe("function");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    for (const [state, domain] of [
      ["present", "juan.sns"],
      ["none", null],
      ["unknown", null],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        okEnvelope({ ...RESOLVE_DATA, reverseDomain: domain, reverseDomainState: state }),
      );
      const resolved = await api.resolveRecipientAlias({ name: "juan.sns" });
      expect(resolved.reverseDomainState).toBe(state);
      expect(resolved.reverseDomain).toBe(domain);
    }
    // `unknown` is never collapsed into `none` by the client either.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("checks one contact's alias and reports the three drift states", async () => {
    expect(typeof api.checkContactAlias).toBe("function");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    for (const state of ["unchanged", "changed", "unavailable"] as const) {
      fetchMock.mockResolvedValueOnce(
        okEnvelope({
          state,
          storedAddress: ADDRESS,
          ...(state === "changed" ? { observedAddress: OTHER_ADDRESS } : {}),
        }),
      );
      const checked = await api.checkContactAlias("contact-1");
      expect(checked.state).toBe(state);
      expect(checked.storedAddress).toBe(ADDRESS);
    }
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input).endsWith("/v1/contacts/contact-1/check-alias")).toBe(true);
    expect(init?.method).toBe("POST");
  });

  it("surfaces a contact with no alias as its own typed refusal", async () => {
    expect(typeof api.checkContactAlias).toBe("function");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          errEnvelope("CONTACTO_SIN_ALIAS", "Ese contacto no vino de un alias.", 409),
        ),
    );
    await expect(api.checkContactAlias("contact-2")).rejects.toMatchObject({
      code: "CONTACTO_SIN_ALIAS",
      status: 409,
    });
  });

  it("posts the alias arm without an address and reads back the disclosure", async () => {
    expect(typeof api.createContact).toBe("function");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        okEnvelope(
          { ...CONTACT_DATA, duplicateOf: { contactId: "contact-marta", name: "Marta" } },
          201,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await api.createContact({
      name: "Juan",
      description: "",
      source: "sns",
      snsName: "juan.sns",
      expectedAddress: ADDRESS,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      name: "Juan",
      description: "",
      source: "sns",
      snsName: "juan.sns",
      expectedAddress: ADDRESS,
    });
    // The client NEVER posts the address on the alias arm: the server resolves it.
    expect(body).not.toHaveProperty("address");
    expect(created.duplicateOf).toEqual({ contactId: "contact-marta", name: "Marta" });
    expect(created.address).toBe(ADDRESS);
  });

  it("keeps the paste body exactly as it was, with no alias key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okEnvelope(CONTACT_DATA, 201));
    vi.stubGlobal("fetch", fetchMock);

    const created = await api.createContact({
      name: "Ana",
      description: "Mi vecina",
      address: OTHER_ADDRESS,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ name: "Ana", description: "Mi vecina", address: OTHER_ADDRESS });
    for (const aliasKey of ["source", "snsName", "expectedAddress"]) {
      expect(Object.keys(body)).not.toContain(aliasKey);
    }
    expect(created.duplicateOf).toBeUndefined();
  });

  it("passes the create-side alias refusals through by name", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    for (const [code, status] of [
      ["SNS_DESTINO_CAMBIADO", 409],
      ["DIRECCION_PROPIA", 409],
      ["IDEMPOTENCIA_CUERPO_DISTINTO", 409],
      ["NOMBRE_AMBIGUO", 409],
      ["NOMBRE_NO_ENCONTRADO", 404],
      ["RESOLVEDOR_NO_DISPONIBLE", 503],
    ] as Array<[string, number]>) {
      fetchMock.mockResolvedValueOnce(errEnvelope(code, `mensaje ${code}`, status));
      const error = await api
        .createContact({
          name: "Juan",
          description: "",
          source: "sns",
          snsName: "juan.sns",
          expectedAddress: ADDRESS,
        })
        .catch((caught) => caught);
      expect(error, code).toMatchObject({ code, status });
    }
    // The wallet's own address is its own fact, never a duplicate-contact one.
    fetchMock.mockResolvedValueOnce(
      errEnvelope("DIRECCION_PROPIA", "Es tu propia dirección.", 409),
    );
    const own = await api
      .createContact({
        name: "Juan",
        description: "",
        source: "sns",
        snsName: "juan.sns",
        expectedAddress: ADDRESS,
      })
      .catch((caught) => caught);
    expect(own?.code).toBe("DIRECCION_PROPIA");
    expect(own?.code).not.toBe("DUPLICADO");
  });

  it("mirrors the resolve response's closed field set, with no selector and no secret", () => {
    const front = frontFile("src/lib/api-types.ts");
    const block = front.match(/export type RecipientAliasResolveResponse = \{[\s\S]*?\n\};/);
    expect(block, "RecipientAliasResolveResponse block").not.toBeNull();
    const fields = [...block![0].matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields.sort()).toEqual(
      ["address", "name", "resolvedAt", "resolver", "reverseDomain", "reverseDomainState"].sort(),
    );
    // The mirrored type carries no chain selector and no server-side evidence.
    expect(block![0]).not.toMatch(/chain|secret|signature|appSecret|observedOwner|nameAccount/i);
    // And the three reverse states are distinct on this side too.
    expect(front).toContain('export type ReverseDomainState = "present" | "none" | "unknown";');
  });
});
