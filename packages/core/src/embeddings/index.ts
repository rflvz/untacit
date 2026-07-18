/**
 * Embedding providers beyond the built-in hash placeholder (docs/03 §3).
 *
 * The real multilingual model (e5/bge family) runs locally through
 * transformers.js. `@huggingface/transformers` is deliberately NOT a
 * dependency of @untacit/core: it is resolved with a dynamic import so the
 * core stays lean, offline installs keep working, and the provider remains
 * pluggable. Install it in the workspace (`pnpm add @huggingface/transformers`)
 * to activate the model; without it, `provider: 'auto'` disables the semantic
 * channel (fuzzy matching then relies on name similarity alone).
 */

import { HashEmbeddingProvider } from '../resolver/index.js';
import type { EmbeddingKind, EmbeddingProvider } from '../resolver/index.js';
import type { EmbeddingsConfig } from '../types.js';

/** Small, multilingual, ONNX-quantized — the docs/03 §3 default family. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

/** Minimal surface of the transformers.js feature-extraction pipeline. */
interface FeatureExtractionOutput {
  tolist(): number[][];
}
type FeatureExtractionPipeline = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

/**
 * Local multilingual model via transformers.js. e5-family models are trained
 * with asymmetric "query: " / "passage: " prefixes; they are applied here so
 * callers only declare the kind.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly pipe: FeatureExtractionPipeline;
  private readonly e5: boolean;

  private constructor(model: string, pipe: FeatureExtractionPipeline) {
    this.name = `transformers:${model}`;
    this.pipe = pipe;
    this.e5 = /(^|\/)(multilingual-)?e5\b|-e5-/i.test(model);
  }

  /**
   * Load the model (downloads weights to the local cache on first use).
   * Throws a descriptive error when transformers.js is not installed.
   */
  static async create(model: string = DEFAULT_EMBEDDING_MODEL): Promise<TransformersEmbeddingProvider> {
    // Non-literal specifier: the module is optional and intentionally not a
    // dependency, so TypeScript must not try to resolve its types.
    const specifier = '@huggingface/transformers';
    let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
    try {
      mod = (await import(specifier)) as typeof mod;
    } catch {
      throw new Error(
        'Embedding provider "transformers" requires @huggingface/transformers — ' +
          'install it in the workspace (pnpm add @huggingface/transformers) or set ' +
          'embeddings.provider to "hash"/"auto" in untacit.config.json',
      );
    }
    const pipe = (await mod.pipeline('feature-extraction', model)) as FeatureExtractionPipeline;
    return new TransformersEmbeddingProvider(model, pipe);
  }

  async embed(texts: string[], kind: EmbeddingKind = 'passage'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const input = this.e5 ? texts.map((t) => `${kind}: ${t}`) : texts;
    const output = await this.pipe(input, { pooling: 'mean', normalize: true });
    return output.tolist();
  }
}

/**
 * Resolve the configured embedding provider (untacit.config.json →
 * `embeddings`, docs/03 §3):
 *
 * - 'none'         → null (semantic channel disabled)
 * - 'hash'         → deterministic char-trigram provider (tests, offline demos)
 * - 'transformers' → local multilingual model; throws if not installed
 * - 'auto'         → transformers when available, else null (default)
 *
 * 'auto' deliberately falls back to null, not to 'hash': character-trigram
 * cosine over same-domain prose produces spurious gray-zone scores, so the
 * hash provider must be an explicit choice, never a silent default.
 */
export async function createEmbeddingProvider(
  config?: EmbeddingsConfig | null,
): Promise<EmbeddingProvider | null> {
  const kind = config?.provider ?? 'auto';
  switch (kind) {
    case 'none':
      return null;
    case 'hash':
      return new HashEmbeddingProvider();
    case 'transformers':
      return TransformersEmbeddingProvider.create(config?.model);
    case 'auto':
      try {
        return await TransformersEmbeddingProvider.create(config?.model);
      } catch (err) {
        // Module not installed → the documented, silent fallback. Anything
        // else (bad model id, failed download) is a misconfiguration the
        // user should hear about instead of silently losing the channel.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('pnpm add @huggingface/transformers')) {
          console.warn(`[untacit] embeddings 'auto': local model unavailable (${message}); semantic channel disabled`);
        }
        return null;
      }
    default:
      throw new Error(`Unknown embeddings.provider "${String(kind)}"`);
  }
}
