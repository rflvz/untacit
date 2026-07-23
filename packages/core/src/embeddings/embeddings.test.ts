import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from '../resolver/index.js';
import {
  TransformersEmbeddingProvider,
  createEmbeddingProvider,
  transformersAvailable,
  type TransformersModule,
} from './index.js';

// The workspace root ships @huggingface/transformers, but tests must not
// depend on network (model downloads) or on the install state — the loader
// injection keeps every path deterministic.

/**
 * Simulates the module being absent: the real loader (loadTransformers)
 * catches the failed import and throws this exact actionable hint.
 */
const missingModule = (): Promise<TransformersModule> =>
  Promise.reject(
    new Error(
      'Embedding provider "transformers" requires @huggingface/transformers — ' +
        'install it in the workspace (pnpm add @huggingface/transformers) or set ' +
        'embeddings.provider to "hash"/"auto" in untacit.config.json',
    ),
  );

/** Fake pipeline: unit vector per text, records the exact inputs received. */
function fakeModule(received: string[][]): TransformersModule {
  return {
    pipeline: async (_task: string, _model: string) => {
      return async (texts: string[], _opts: unknown) => {
        received.push(texts);
        return { tolist: () => texts.map(() => [1, 0]) };
      };
    },
  };
}

describe('createEmbeddingProvider', () => {
  it("'none' disables the semantic channel", async () => {
    expect(await createEmbeddingProvider({ provider: 'none' })).toBeNull();
  });

  it("'hash' returns the deterministic offline provider", async () => {
    const provider = await createEmbeddingProvider({ provider: 'hash' });
    expect(provider).toBeInstanceOf(HashEmbeddingProvider);
    expect(provider!.name).toBe('hash-char-trigram-256');
  });

  it("'auto' falls back to null (not hash) when transformers.js is absent", async () => {
    expect(await createEmbeddingProvider({ provider: 'auto' }, missingModule)).toBeNull();
    expect(await createEmbeddingProvider(undefined, missingModule)).toBeNull();
  });

  it("'auto' returns the local model when the module loads", async () => {
    const provider = await createEmbeddingProvider({ provider: 'auto' }, async () =>
      fakeModule([]),
    );
    expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    expect(provider!.name).toBe('transformers:Xenova/multilingual-e5-small');
  });

  it("'transformers' fails loudly with an actionable message when not installed", async () => {
    await expect(
      createEmbeddingProvider({ provider: 'transformers' }, missingModule),
    ).rejects.toThrow(/pnpm add @huggingface\/transformers/);
  });

  it('rejects unknown provider values', async () => {
    await expect(
      createEmbeddingProvider({ provider: 'qdrant' as never }),
    ).rejects.toThrow(/Unknown embeddings.provider/);
  });
});

describe('TransformersEmbeddingProvider.create', () => {
  it('throws the install hint when the optional dependency is missing', async () => {
    await expect(
      TransformersEmbeddingProvider.create(undefined, missingModule),
    ).rejects.toThrow(/pnpm add @huggingface\/transformers/);
  });

  it('applies e5 query/passage prefixes; non-e5 models pass texts through', async () => {
    const e5Inputs: string[][] = [];
    const e5 = await TransformersEmbeddingProvider.create(undefined, async () =>
      fakeModule(e5Inputs),
    );
    await e5.embed(['hola'], 'query');
    await e5.embed(['mundo'], 'passage');
    expect(e5Inputs).toEqual([['query: hola'], ['passage: mundo']]);

    const plainInputs: string[][] = [];
    const plain = await TransformersEmbeddingProvider.create('Xenova/bge-m3', async () =>
      fakeModule(plainInputs),
    );
    await plain.embed(['hola'], 'query');
    expect(plainInputs).toEqual([['hola']]);
  });
});

describe('transformersAvailable', () => {
  it('reports whether the workspace resolves @huggingface/transformers', async () => {
    // The monorepo root declares it as a dependency, so this must be true in CI.
    expect(await transformersAvailable()).toBe(true);
  });
});
