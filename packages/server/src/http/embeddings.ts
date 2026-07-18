/**
 * Background embedding freshness (docs/06 §4.6, product priority): after a
 * graph changes on disk (external `git pull` → the next tool call reindexes
 * by staleness), the semantic channel must catch up without anyone running
 * `untacit embed`. The refresher re-runs GraphIndex.updateEmbeddings —
 * incremental by content hash, a cheap no-op when nothing changed — once per
 * scheduled graph, serialized so concurrent graphs never compete for CPU.
 *
 * Scheduling points: server startup (all graphs) and after every handled MCP
 * POST (the only moment a staleness reindex can have happened).
 */

import {
  GraphIndex,
  createEmbeddingProvider,
  loadConfig,
  type EmbeddingProvider,
} from '@untacit/core';

import type { GraphEntry } from '../config.js';

export class EmbeddingsRefresher {
  private readonly graphs = new Map<string, GraphEntry>();
  private readonly providers = new Map<string, Promise<EmbeddingProvider | null>>();
  private readonly pending = new Set<string>();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    graphs: GraphEntry[],
    private readonly log: (message: string) => void = () => {},
  ) {
    for (const graph of graphs) this.graphs.set(graph.id, graph);
  }

  /** Queue a refresh for one graph (deduplicated while pending). */
  schedule(graphId: string): void {
    if (this.stopped || !this.graphs.has(graphId)) return;
    this.pending.add(graphId);
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
  }

  scheduleAll(): void {
    for (const id of this.graphs.keys()) this.schedule(id);
  }

  /** Resolves when the queue is fully drained — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  private providerFor(graph: GraphEntry): Promise<EmbeddingProvider | null> {
    let promise = this.providers.get(graph.id);
    if (!promise) {
      // Resolved once per graph from its own untacit.config.json; 'auto'
      // without a local model → null → semantic channel off for that graph.
      promise = createEmbeddingProvider(loadConfig(graph.path).embeddings).catch((err) => {
        this.log(`graph "${graph.id}": embedding provider unavailable (${(err as Error).message})`);
        return null;
      });
      this.providers.set(graph.id, promise);
    }
    return promise;
  }

  private async run(): Promise<void> {
    while (this.pending.size > 0 && !this.stopped) {
      const graphId = this.pending.values().next().value as string;
      this.pending.delete(graphId);
      const graph = this.graphs.get(graphId);
      if (!graph) continue;
      try {
        const provider = await this.providerFor(graph);
        if (!provider) continue;
        const index = GraphIndex.open(graph.path);
        try {
          const result = await index.updateEmbeddings(provider);
          if (result.computed > 0 || result.removed > 0) {
            this.log(
              `graph "${graphId}": embeddings refreshed (+${result.computed}/-${result.removed}, provider ${provider.name})`,
            );
          }
        } finally {
          index.close();
        }
      } catch (err) {
        this.log(`graph "${graphId}": embedding refresh failed: ${(err as Error).message}`);
      }
    }
  }
}
