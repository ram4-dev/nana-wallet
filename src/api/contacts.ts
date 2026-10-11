import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  contactSchema,
  contactPermissionSchema,
  contactRemovalPreviewQuerySchema,
  contactRemovalPreviewSchema,
  createContactInputSchema,
  deleteContactBodySchema,
  deleteContactResponseSchema,
  recipientAliasResolveInputSchema,
  recipientAliasResolveResponseSchema,
  revealedCbuSchema,
  updateContactInputSchema,
  type Contact,
  type DeleteContactResponse,
  type MeResponse,
  type RevealedCbu,
} from "../contracts/http.js";
import {
  ContactsRepository,
} from "../memory/contacts-repository.js";
import { PrivyIdentityError } from "../auth/privy-identity.js";
import {
  EmbeddingService,
  recipientEmbeddingText,
} from "../memory/embedding.js";
import { EMBEDDING_MODEL_ID } from "../memory/types.js";
import { readRecipientMemoryConfig } from "../config/env.js";
import {
  RecipientPolicySeamError,
  type RecipientPolicyService,
} from "../wallet/policy/service.js";
import type { SnsResolver, SnsResolveFailure } from "../wallet/sns/resolver.js";

export type ContactEmbedder = {
  embed(text: string): Promise<number[]>;
};

export type ContactsRouteDependencies = {
  resolveUserId(request: FastifyRequest): Promise<string>;
  contacts: ContactsRepository;
  embedder: ContactEmbedder;
  recipientPolicy: RecipientPolicyService;
  /**
   * The alias resolver (task 5.1, design §1/§7). REQUIRED to be stated, and
   * `null` means "this deployment wired none": an absent resolver is a refusal
   * (`503 RESOLVEDOR_NO_DISPONIBLE`), never an emulated one. A deployment that
   * cannot reach a registry must not answer with an address it did not read.
   *
   * It is injected and never constructed per request, so one connection is not
   * re-created for every keystroke of the screen's "Buscar".
   */
  aliases?: SnsResolver | null;
};

/**
 * The resolver taxonomy mapped onto HTTP (design §1.3/§7). Every member of the
 * union has an entry, so a new failure kind cannot silently become a 500.
 *
 * `not_found` and `unreachable` are deliberately different answers: "el nombre
 * no existe" and "no pudimos consultar" are different facts to the person
 * reading the screen, and the spec forbids reporting the second as the first.
 */
const SNS_FAILURE_HTTP: Record<
  SnsResolveFailure["kind"],
  { status: number; code: string; message: string }
> = {
  malformed_name: {
    status: 422,
    code: "DATOS_INVALIDOS",
    message: "That is not a resolvable `.sns` name.",
  },
  unsupported_tld: {
    status: 422,
    code: "NOMBRE_NO_SOPORTADO",
    message: "Only `.sns` names are supported by this deployment.",
  },
  not_found: {
    status: 404,
    code: "NOMBRE_NO_ENCONTRADO",
    message: "That name is not registered.",
  },
  ambiguous: {
    status: 409,
    code: "NOMBRE_AMBIGUO",
    message:
      "That name account does not carry the owner we require, so it cannot be used as a destination.",
  },
  unreachable: {
    status: 503,
    code: "RESOLVEDOR_NO_DISPONIBLE",
    message:
      "We could not reach the name registry, so this name was not verified. It was not found to be missing either.",
  },
  resolver_misconfigured: {
    status: 503,
    code: "RESOLVEDOR_NO_DISPONIBLE",
    message:
      "This deployment has no working name resolver for the configured network.",
  },
};

export type ContactApiError = {
  ok: false;
  error: { code: string; message: string };
};

export type ContactReply = {
  code(status: number): { send(payload: ContactApiError): void };
};

/**
 * The service seam's refusal codes mapped onto HTTP (design §7). A DATA-driven
 * map rather than a chain of ternaries: the alias arm added four codes whose
 * statuses are not all `409`, and a missing entry would silently become a 500
 * for a refusal that has an answer. `Record` over the closed code union makes a
 * new code a type error here.
 */
const SEAM_ERROR_HTTP_STATUS: Record<string, number> = {
  DATOS_INVALIDOS: 422,
  CONTACTO_NO_ENCONTRADO: 404,
  // Resolver taxonomy: a name this deployment cannot serve is a request problem
  // (422), a name that does not exist is absent (404), an unusable name account
  // is a conflict (409), and an unreachable registry is OUR availability (503).
  NOMBRE_NO_SOPORTADO: 422,
  NOMBRE_NO_ENCONTRADO: 404,
  NOMBRE_AMBIGUO: 409,
  RESOLVEDOR_NO_DISPONIBLE: 503,
  // The alias add's own refusals: the name moved (a conflict) and the address is
  // this wallet's own (a conflict).
  SNS_DESTINO_CAMBIADO: 409,
  DIRECCION_PROPIA: 409,
  IDEMPOTENCIA_CUERPO_DISTINTO: 409,
};

function errorReply(reply: ContactReply, error: unknown): ContactApiError {
  // Identity failures map to 401 via the server-wide handler, never 500.
  if (error instanceof PrivyIdentityError) throw error;
  if (error instanceof RecipientPolicySeamError) {
    reply.code(SEAM_ERROR_HTTP_STATUS[error.code] ?? 409);
    return {
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  reply.code(500);
  return {
    ok: false,
    error: { code: "ERROR_INTERNO", message: "Unexpected contacts error." },
  };
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function projectContact(
  dependencies: ContactsRouteDependencies,
  userId: string,
  contactId: string,
  permission: unknown,
) {
  const contact = await dependencies.contacts.read(userId, contactId);
  if (!contact) throw new Error("policy mutation did not leave a contact projection");
  return contactSchema.parse({
    ...contact,
    permission: contactPermissionSchema.parse(permission),
  });
}

/**
 * /v1/contacts (PMU-008..013): user-scoped contacts CRUD over the recipients
 * projection, RLS-scoped through the resolved internal UUID, with versioned
 * updates (expectedVersion -> 409), soft delete and tap-to-copy reveal.
 */
export async function registerContactsRoutes(
  app: FastifyInstance,
  dependencies: ContactsRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/contacts",
    async (
      request,
      reply,
    ): Promise<
      | { ok: true; data: Contact[] }
      | { ok: false; error: { code: string; message: string } }
    > => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const [contacts, permission] = await Promise.all([
          dependencies.contacts.listActive(userId),
          dependencies.recipientPolicy.readPermissionForUser(userId),
        ]);
        return {
          ok: true,
          data: contacts.map((contact) =>
            contactSchema.parse({
              ...contact,
              permission: contactPermissionSchema.parse(permission),
            }),
          ),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post(
    "/v1/contacts",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<
      | { ok: true; data: Contact }
      | { ok: false; error: { code: string; message: string } }
    > => {
      const parsed = createContactInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const result = await dependencies.recipientPolicy.create(
          userId,
          parsed.data,
          { origin: "screen", idempotencyKey: idempotencyKey(request) },
        );
        reply.code(201);
        return {
          ok: true,
          data: await projectContact(
            dependencies,
            userId,
            result.contact.id,
            result.permission,
          ),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.post(
    "/v1/recipient-aliases/resolve",
    async (
      request: FastifyRequest<{ Body: unknown }>,
      reply,
    ): Promise<
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } }
    > => {
      const parsed = recipientAliasResolveInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      try {
        // Authenticated, like every other surface here: resolution is performed
        // on the user's behalf even though it writes nothing.
        await dependencies.resolveUserId(request);
        const resolver = dependencies.aliases ?? null;
        if (!resolver) {
          // Fail closed on an unwired deployment. Emulating a resolver here would
          // mean inventing a destination, and answering "not found" would report
          // a fact nobody checked.
          reply.code(503);
          return {
            ok: false,
            error: {
              code: "RESOLVEDOR_NO_DISPONIBLE",
              message:
                "This deployment has no SNS resolver wired, so no name can be verified. Nothing was written.",
            },
          };
        }
        const outcome = await resolver.resolve(parsed.data.name);
        if (!outcome.ok) {
          const mapping = SNS_FAILURE_HTTP[outcome.failure.kind];
          reply.code(mapping.status);
          return {
            ok: false,
            error: { code: mapping.code, message: mapping.message },
          };
        }
        // Exactly the six names the client needs; `observedOwner`, `nameAccount`,
        // `observedParent` and `slot` stay server-side (design §7).
        reply.code(200);
        return {
          ok: true,
          data: recipientAliasResolveResponseSchema.parse({
            name: outcome.value.name,
            address: outcome.value.address,
            resolvedAt: outcome.value.resolvedAt,
            resolver: outcome.value.resolver,
            reverseDomain: outcome.value.reverseDomain,
            reverseDomainState: outcome.value.reverseDomainState,
          }),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.patch(
    "/v1/contacts/:id",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply,
    ): Promise<
      | { ok: true; data: Contact }
      | { ok: false; error: { code: string; message: string } }
    > => {
      const parsed = updateContactInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: parsed.error.message },
        };
      }
      if (
        parsed.data.name === undefined &&
        parsed.data.description === undefined &&
        parsed.data.address === undefined
      ) {
        reply.code(422);
        return {
          ok: false,
          error: {
            code: "DATOS_INVALIDOS",
            message: "At least one editable field is required.",
          },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const result = await dependencies.recipientPolicy.edit(
          userId,
          request.params.id,
          parsed.data,
          { origin: "screen", idempotencyKey: idempotencyKey(request) },
        );
        return {
          ok: true,
          data: await projectContact(
            dependencies,
            userId,
            result.contact.id,
            result.permission,
          ),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.delete(
    "/v1/contacts/:id",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: unknown;
        Body: unknown;
      }>,
      reply,
    ): Promise<
      | { ok: true; data: DeleteContactResponse }
      | { ok: false; error: { code: string; message: string } }
    > => {
      const query = contactRemovalPreviewQuerySchema.safeParse(request.query);
      const body = deleteContactBodySchema.safeParse(request.body);
      if (!query.success || !body.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: "Invalid removal request." },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const result = await dependencies.recipientPolicy.remove(
          userId,
          request.params.id,
          query.data.expectedVersion,
          idempotencyKey(request),
          {
            origin: "screen",
            idempotencyKey: idempotencyKey(request),
            expectedRevokedGrantIds: body.data.expectedRevokedGrantIds,
          },
        );
        return {
          ok: true,
          data: deleteContactResponseSchema.parse({
            contact: await projectContact(
              dependencies,
              userId,
              result.contact.id,
              result.permission,
            ),
            revocation: result.revocation,
          }),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.get(
    "/v1/contacts/:id/removal-preview",
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: unknown }>,
      reply,
    ) => {
      const query = contactRemovalPreviewQuerySchema.safeParse(request.query);
      if (!query.success) {
        reply.code(422);
        return {
          ok: false,
          error: { code: "DATOS_INVALIDOS", message: "Invalid removal preview." },
        };
      }
      try {
        const userId = await dependencies.resolveUserId(request);
        const preview = await dependencies.recipientPolicy.previewRemoval(
          userId,
          request.params.id,
          query.data.expectedVersion,
        );
        return {
          ok: true,
          data: contactRemovalPreviewSchema.parse({
            contactId: preview.contact.id,
            contactVersion: preview.contact.version,
            revokedGrantIds: preview.revokedGrantIds,
            lastAlias: preview.lastAlias,
          }),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );

  app.get("/v1/recipient-policy", async (request, reply) => {
    try {
      const userId = await dependencies.resolveUserId(request);
      return {
        ok: true,
        data: contactPermissionSchema.parse(
          await dependencies.recipientPolicy.readPermissionForUser(userId),
        ),
      };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post("/v1/recipient-policy/retry", async (request, reply) => {
    try {
      const userId = await dependencies.resolveUserId(request);
      const permission = await dependencies.recipientPolicy.retryForUser(userId);
      reply.code(202);
      return { ok: true, data: contactPermissionSchema.parse(permission) };
    } catch (error) {
      return errorReply(reply, error);
    }
  });

  app.post(
    "/v1/contacts/:id/reveal-cbu",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply,
    ): Promise<
      | { ok: true; data: RevealedCbu }
      | { ok: false; error: { code: string; message: string } }
    > => {
      try {
        const userId = await dependencies.resolveUserId(request);
        const address = await dependencies.contacts.revealAddress(
          userId,
          request.params.id,
        );
        if (!address) {
          reply.code(404);
          return {
            ok: false,
            error: {
              code: "CONTACTO_NO_ENCONTRADO",
              message: "Contact not found.",
            },
          };
        }
        return {
          ok: true,
          data: revealedCbuSchema.parse({ id: request.params.id, address }),
        };
      } catch (error) {
        return errorReply(reply, error);
      }
    },
  );
}

/** Builds the contacts embedder from the configured recipient-memory settings. */
export function createContactsEmbedder(
  environment: NodeJS.ProcessEnv = process.env,
): ContactEmbedder {
  const config = readRecipientMemoryConfig(environment);
  return new EmbeddingService(config.modelCacheDirectory);
}

export type { MeResponse };
