/**
 * Bridges the recipient projection to the policy service's deliberately narrow
 * mutation port.  Keeping this beside `ContactsRepository` means the policy
 * package never learns about embeddings or the recipients table.
 */
import type { Queryable } from "../db/client.js";
import {
  ContactsConflictError,
  ContactsNotFoundError,
  ContactsRepository,
} from "./contacts-repository.js";
import {
  recipientEmbeddingText,
} from "./embedding.js";
import { EMBEDDING_MODEL_ID, type Embedding } from "./types.js";
import {
  RecipientContactMissingError,
  RecipientContactVersionConflictError,
  type RecipientContactMutationPort,
  type RecipientContactPatchInput,
  type RecipientContactRecord,
  type RecipientContactWriteInput,
} from "../wallet/policy/service.js";

export type ContactEmbedder = {
  embed(text: string): Promise<Embedding>;
};

function project(record: {
  id: string;
  name: string;
  description: string;
  address: string;
  network?: "solana-devnet" | null;
  version: number;
}): RecipientContactRecord {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    address: record.address,
    network: record.network ?? null,
    version: record.version,
  };
}

/**
 * The only production adapter allowed to write contacts for policy mutations.
 * Every method receives the policy service's transaction client, so the contact
 * projection, desired revision and sync intent commit or roll back together.
 */
export function createRecipientContactMutationPort(input: {
  contacts: ContactsRepository;
  embedder: ContactEmbedder;
}): RecipientContactMutationPort {
  const embeddingFor = (name: string, description: string) =>
    input.embedder.embed(recipientEmbeddingText(name, description));

  return {
    async create(userId, contact, client) {
      const record = await input.contacts.create(
        userId,
        contact,
        await embeddingFor(contact.name, contact.description),
        EMBEDDING_MODEL_ID,
        client,
      );
      return project(record);
    },

    async update(userId, contactId, patch, client) {
      const current = await input.contacts.readActive(userId, contactId, client);
      if (!current) throw new RecipientContactMissingError();
      try {
        const record = await input.contacts.update(
          userId,
          contactId,
          patch,
          await embeddingFor(
            patch.name ?? current.name,
            patch.description ?? current.description,
          ),
          EMBEDDING_MODEL_ID,
          client,
        );
        return project(record);
      } catch (error) {
        if (error instanceof ContactsConflictError) {
          throw new RecipientContactVersionConflictError();
        }
        if (error instanceof ContactsNotFoundError) {
          throw new RecipientContactMissingError();
        }
        throw error;
      }
    },

    async archive(userId, contactId, expectedVersion, client) {
      const record = await input.contacts.archive(
        userId,
        contactId,
        expectedVersion,
        client,
      );
      if (!record) {
        const current = await input.contacts.readActive(userId, contactId, client);
        if (!current) throw new RecipientContactMissingError();
        throw new RecipientContactVersionConflictError();
      }
      return project(record);
    },

    async readActive(userId: string, contactId: string, client?: Queryable) {
      const record = await input.contacts.readActive(userId, contactId, client);
      return record ? project(record) : null;
    },
  };
}
