import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, type Embedding } from './types.js';

const ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;

type FeatureExtractionOutput = { tolist(): number[] | number[][] };
type FeatureExtractionPipeline = (text: string, options: { pooling: 'mean'; normalize: true }) => Promise<FeatureExtractionOutput>;
type PipelineLoader = () => Promise<FeatureExtractionPipeline>;

export function redactAddressLikeText(value: string): string {
  return value.replace(ADDRESS_PATTERN, '[address removed]');
}

export function normalizeMemoryText(value: string): string {
  return redactAddressLikeText(value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es');
}

/**
 * The COMPARISON key for a contact name: {@link normalizeMemoryText} folded one
 * step further, so a diacritic is never the difference between the user's own
 * contact and the name they typed or said.
 *
 * WHY A SEPARATE KEY, AND NOT A CHANGED `normalizeMemoryText`
 * ----------------------------------------------------------
 * `normalizeMemoryText` is not a comparison helper: it produces the value that is
 * STORED in `recipients.normalized_name`, it is part of the text that is EMBEDDED
 * for retrieval, and the repository's exact-match bonus (`normalized_name = $2`)
 * is evaluated against it in SQL. Changing it would therefore rewrite the meaning
 * of every existing row — including the retrieval bonus and the embedding text of
 * rows already written — and would leave every stored row comparing under the OLD
 * rules until a backfill re-normalized it (`normalized_name` is a plain column,
 * not a generated one, so nothing recomputes it). The defect is a COMPARISON
 * defect, so it is fixed at comparison time:
 *
 *   - no stored value changes and no backfill or migration is needed;
 *   - existing rows compare correctly the moment this deploys;
 *   - the embeddings keep the punctuation of the language they were trained on.
 *
 * The fold is `NFD` and drop the combining marks. `Sofía` -> `sofia`. Dropping a
 * tilde also folds `ñ` onto `n`, so `Muñoz` and `Munoz` compare equal: that can
 * only ever turn ONE candidate into an AMBIGUITY (two rows, one folded name),
 * never resolve a name onto a different person, and asking is the safe direction.
 */
export function comparisonTextKey(value: string): string {
  return normalizeMemoryText(value).normalize('NFD').replace(/\p{M}+/gu, '');
}

export function recipientEmbeddingText(name: string, description: string): string {
  return `name: ${normalizeMemoryText(name)}\ndescription: ${normalizeMemoryText(description)}`;
}

export function factEmbeddingText(fact: string): string {
  return `fact: ${normalizeMemoryText(fact)}`;
}

function defaultPipelineLoader(cacheDirectory: string): PipelineLoader {
  return async () => {
    const transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = cacheDirectory;
    const pipeline = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
      // This model publishes model.onnx but no model_quantized.onnx; fp32 keeps
      // the pinned model portable across local and containerized deployments.
      dtype: 'fp32',
    });
    return pipeline as unknown as FeatureExtractionPipeline;
  };
}

export class EmbeddingService {
  private pipeline: Promise<FeatureExtractionPipeline> | undefined;

  public constructor(
    private readonly cacheDirectory: string,
    private readonly loadPipeline: PipelineLoader = defaultPipelineLoader(cacheDirectory),
  ) {}

  public async prefetch(): Promise<void> {
    await this.getPipeline();
  }

  public async embed(text: string): Promise<number[]> {
    const output = await (await this.getPipeline())(normalizeMemoryText(text), { pooling: 'mean', normalize: true });
    const values = output.tolist();
    const vector = Array.isArray(values[0]) ? values[0] as number[] : values as number[];
    if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding model returned an invalid vector; expected ${EMBEDDING_DIMENSIONS} finite dimensions.`);
    }
    return vector;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipeline ??= this.loadPipeline();
    return this.pipeline;
  }
}

export function vectorLiteral(embedding: Embedding): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding must have exactly ${EMBEDDING_DIMENSIONS} finite dimensions.`);
  }
  return `[${embedding.join(',')}]`;
}
