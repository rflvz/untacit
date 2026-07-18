import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from '../resolver/index.js';
import {
  TransformersEmbeddingProvider,
  createEmbeddingProvider,
} from './index.js';

// @huggingface/transformers is intentionally NOT installed in this workspace,
// so these tests pin down the fallback semantics of every config value.

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
    expect(await createEmbeddingProvider({ provider: 'auto' })).toBeNull();
    expect(await createEmbeddingProvider(undefined)).toBeNull();
  });

  it("'transformers' fails loudly with an actionable message when not installed", async () => {
    await expect(createEmbeddingProvider({ provider: 'transformers' })).rejects.toThrow(
      /@huggingface\/transformers/,
    );
  });

  it('rejects unknown provider values', async () => {
    await expect(
      createEmbeddingProvider({ provider: 'qdrant' as never }),
    ).rejects.toThrow(/Unknown embeddings.provider/);
  });
});

describe('TransformersEmbeddingProvider.create', () => {
  it('throws the install hint when the optional dependency is missing', async () => {
    await expect(TransformersEmbeddingProvider.create()).rejects.toThrow(
      /pnpm add @huggingface\/transformers/,
    );
  });
});
