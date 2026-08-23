export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL_ID = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';

export type Embedding = readonly number[];

export type RecipientInput = {
  name: string;
  description: string;
  address: string;
  provenance?: Record<string, unknown>;
};

export type UserMemoryInput = {
  fact: string;
  kind?: string;
  provenance?: Record<string, unknown>;
};

export type RecipientRecord = {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  description: string;
  address: string;
  version: number;
  status: 'active' | 'inactive';
  embeddingModelRevision: string;
};

export type RecipientCandidate = Omit<RecipientRecord, 'address' | 'userId'> & {
  evidence: string;
  score: number;
};

export type UserMemoryFact = {
  id: string;
  fact: string;
  kind: string;
  version: number;
  evidence: string;
  score: number;
};
