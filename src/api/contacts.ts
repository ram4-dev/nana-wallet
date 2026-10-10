import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  contactSchema,
  contactPermissionSchema,
  contactRemovalPreviewQuerySchema,
  contactRemovalPreviewSchema,
  createContactInputSchema,
  deleteContactBodySchema,
  deleteContactResponseSchema,
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

export type ContactEmbedder = {
  embed(text: string): Promise<number[]>;
};

export type ContactsRouteDependencies = {
  resolveUserId(request: FastifyRequest): Promise<string>;
  contacts: ContactsRepository;
  embedder: ContactEmbedder;
  recipientPolicy: RecipientPolicyService;
};

export type ContactApiError = {
  ok: false;
  error: { code: string; message: string };
};

export type ContactReply = {
  code(status: number): { send(payload: ContactApiError): void };
};

function errorReply(reply: ContactReply, error: unknown): ContactApiError {
  // Identity failures map to 401 via the server-wide handler, never 500.
  if (error instanceof PrivyIdentityError) throw error;
  if (error instanceof RecipientPolicySeamError) {
    const status =
      error.code === "DATOS_INVALIDOS"
        ? 422
        : error.code === "CONTACTO_NO_ENCONTRADO"
          ? 404
          : 409;
    reply.code(status);
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
