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
