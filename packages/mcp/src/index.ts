/**
 * untacit MCP server (docs/03 §6) — the graph surface for agents whose model
 * lives in the host (Claude Code, Claude Desktop).
 *
 * - Eight read-only query tools over the derived index (reindexes automatically
 *   when the graph repo changed on disk — GraphIndex.open is hash-based).
 * - Agent surface (src/agent.ts): interview gaps, code candidates, document
 *   sections, versioned extractor prompts, and — with `--write` — the
 *   untacit_import_batch write gate, so extraction and interviews run
 *   entirely through MCP with the host's own model.
 * - Transports: stdio (default) and streamable HTTP (src/http.ts).
 */

import {
  EDGE_TYPES,
  GraphIndex,
  NODE_TYPES,
  createEmbeddingProvider,
  formatDiffText,
  loadConfig,
} from '@untacit/core';
import type { EdgeType, EmbeddingProvider, NodeType } from '@untacit/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { registerAgentSurface } from './agent.js';
import {
  conflictsQuery,
  contextQuery,
  diffQuery,
  evidenceQuery,
  exploreQuery,
  pathsQuery,
  similarQuery,
} from './queries.js';
import { registerWriteSurface } from './review.js';

export * from './queries.js';
export { registerAgentSurface } from './agent.js';
export { registerWriteSurface } from './review.js';

const nodeTypeEnum = z.enum(NODE_TYPES as [NodeType, ...NodeType[]]);
const edgeTypeEnum = z.enum(EDGE_TYPES as [EdgeType, ...EdgeType[]]);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export interface ServeOptions {
  /**
   * Enable the write surface (src/review.ts): the untacit_import_batch gate
   * plus the review-queue actions (accept/reject/revert merges, resolve
   * conflicts) — everything that mutates the graph repo.
   */
  write?: boolean;
  /**
   * Register the agent surface (interview gaps, code candidates, doc
   * sections, prompts). Default true. The self-hosted company server
   * (docs/06 §2) passes false for graphs served in "query" mode, where the
   * extraction sources those tools read are not mounted.
   */
  agentSurface?: boolean;
  /**
   * Whether the `git` binary is available for untacit_diff. Default true.
   * Serverless/stateless deployments (docs/06 §4.6) pass false so the tool
   * fails with a clear explanation instead of a spawn error.
   */
  gitAvailable?: boolean;
}

export function createServer(repoRoot: string, opts: ServeOptions = {}): McpServer {
  const server = new McpServer({ name: 'untacit', version: '0.1.0' });
  const openIndex = () => GraphIndex.open(repoRoot);

  // Embedding provider for the semantic seed channel, resolved once from
  // untacit.config.json ('auto' without a local model → null → lexical only).
  let providerPromise: Promise<EmbeddingProvider | null> | undefined;
  const getProvider = (): Promise<EmbeddingProvider | null> => {
    providerPromise ??= createEmbeddingProvider(loadConfig(repoRoot)?.embeddings).catch(() => null);
    return providerPromise;
  };

  server.registerTool(
    'untacit_context',
    {
      title: 'Business context retrieval',
      description:
        'Retrieve the subgraph relevant to a business question. Multi-stage hybrid retrieval: ' +
        'seeds by RRF fusion of full-text and semantic-embedding channels, MMR-diversified, then ' +
        'multi-hop graph expansion (spreading activation blended with personalized PageRank, ' +
        'weighted by edge confidence and type). Start here when you do not know node ids. ' +
        'Example: { "query": "pago anticipado clientes nuevos" }. ' +
        'Deepen with untacit_explore / untacit_evidence; connect concepts with untacit_paths.',
      inputSchema: {
        query: z.string().min(1).describe('Natural-language or keyword query, e.g. "recargo pedidos urgentes"'),
        node_types: z.array(nodeTypeEnum).optional().describe('Restrict seed nodes to these types'),
        limit: z.number().int().min(1).max(50).optional().describe('Max seed nodes (default 15)'),
        depth: z.number().int().min(1).max(3).optional().describe('Graph expansion hops from the seeds (default 2)'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, node_types, limit, depth }) => {
      const index = openIndex();
      try {
        const result = await contextQuery(index, query, {
          nodeTypes: node_types,
          limit,
          depth,
          embeddings: await getProvider(),
        });
        if (result.nodes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No nodes match "${query}". Try broader or Spanish terms (graph content is in the organization language).`,
              },
            ],
          };
        }
        const lines = [
          ...result.nodes.map(
            (n) => `${n.seed ? '*' : ' '} [${n.type}] ${n.id} — ${n.name}: ${n.summary}`,
          ),
          '',
          ...result.edges.map(
            (e) => `${e.source} -${e.type}-> ${e.target} (conf ${e.confidence}${e.status === 'conflicted' ? ', CONFLICTED' : ''})`,
          ),
        ];
        if (result.truncated) lines.push('', '(truncated — refine the query or raise limit)');
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { nodes: result.nodes, edges: result.edges, truncated: result.truncated },
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_explore',
    {
      title: 'Explore a node',
      description:
        'Full detail of one node plus its typed neighborhood with confidences. ' +
        'Requires a node id (find it with untacit_context). Example: ' +
        '{ "node_id": "rule-bloqueo-de-pedido-sin-prepago", "depth": 1 }.',
      inputSchema: {
        node_id: z.string().describe('Canonical node id, e.g. "process-alta-de-pedido"'),
        depth: z.number().int().min(1).max(3).optional().describe('Neighborhood hops (default 1)'),
        edge_types: z.array(edgeTypeEnum).optional().describe('Only follow these edge types'),
      },
      annotations: READ_ONLY,
    },
    async ({ node_id, depth, edge_types }) => {
      const index = openIndex();
      try {
        const result = exploreQuery(index, node_id, { depth, edgeTypes: edge_types });
        if (!result) {
          return {
            content: [
              { type: 'text', text: `Node "${node_id}" not found. Use untacit_context to search by text.` },
            ],
            isError: true,
          };
        }
        const n = result.node;
        const lines = [
          `[${n.type}] ${n.id} — ${n.name} (${n.status})`,
          n.description,
          n.aliases.length > 0 ? `aliases: ${n.aliases.join(', ')}` : '',
          '',
          ...result.neighborhood.edges.map(
            (e) => `${e.source} -${e.type}-> ${e.target} (conf ${e.confidence}${e.status === 'conflicted' ? ', CONFLICTED' : ''})`,
          ),
        ].filter((l) => l !== '');
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_impact',
    {
      title: 'Business blast radius',
      description:
        'Transitive impact closure over DEPENDS_ON / GOVERNS / TRIGGERS. Direction "downstream" ' +
        'answers "what breaks or changes if this node changes"; "upstream" answers "what this ' +
        'node depends on / why it exists". Example: { "node_id": "policy-pago-anticipado-a-clientes-nuevos" }.',
      inputSchema: {
        node_id: z.string().describe('Canonical node id'),
        direction: z.enum(['downstream', 'upstream', 'both']).optional().describe('Default "downstream"'),
      },
      annotations: READ_ONLY,
    },
    async ({ node_id, direction }) => {
      const index = openIndex();
      try {
        if (!index.getNode(node_id)) {
          return {
            content: [
              { type: 'text', text: `Node "${node_id}" not found. Use untacit_context to search by text.` },
            ],
            isError: true,
          };
        }
        const result = index.impact(node_id, { direction });
        const lines = result.nodes.map(
          (n) => `${String(n.distance).padStart(2)} · [${n.type}] ${n.id} — ${n.name}`,
        );
        return {
          content: [
            {
              type: 'text',
              text: lines.length > 1 ? lines.join('\n') : 'No impacted nodes beyond the origin.',
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_paths',
    {
      title: 'Strongest chains between two concepts',
      description:
        'How are two nodes connected? Returns the k best evidence chains between them, ranked by ' +
        'multiplicative strength (edge confidence × edge-type weight per hop), strongest first. ' +
        'Use it to explain *why* a change in one concept touches another. Example: ' +
        '{ "from_id": "rule-bloqueo-de-pedido-sin-prepago", "to_id": "process-facturacion-mensual" }.',
      inputSchema: {
        from_id: z.string().describe('Canonical node id of one endpoint'),
        to_id: z.string().describe('Canonical node id of the other endpoint'),
        max_paths: z.number().int().min(1).max(10).optional().describe('Paths to return (default 3)'),
        max_length: z.number().int().min(1).max(10).optional().describe('Max hops per path (default 6)'),
      },
      annotations: READ_ONLY,
    },
    async ({ from_id, to_id, max_paths, max_length }) => {
      const index = openIndex();
      try {
        const result = pathsQuery(index, from_id, to_id, { maxPaths: max_paths, maxLength: max_length });
        if (!result) {
          return {
            content: [
              { type: 'text', text: `Node "${index.nodeSummary(from_id) ? to_id : from_id}" not found. Use untacit_context to search by text.` },
            ],
            isError: true,
          };
        }
        if (result.paths.length === 0) {
          return {
            content: [
              { type: 'text', text: `No path connects ${from_id} and ${to_id} in the graph.` },
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        const lines = result.paths.map((path, i) => {
          const chain = path.nodes
            .map((n, j) => (j === 0 ? n.id : ` -${path.edges[j - 1]!.type}(${path.edges[j - 1]!.confidence})-> ${n.id}`))
            .join('');
          return `${i + 1}. [strength ${path.strength}] ${chain}`;
        });
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_similar',
    {
      title: 'Similar nodes (duplicate lens)',
      description:
        'Nodes most similar to a given node, blending semantic embeddings (meaning), weighted ' +
        'neighborhood overlap (structure) and name similarity (wording). High-scoring same-type ' +
        'results are merge/duplicate candidates; cross-type results reveal related concepts the ' +
        'graph does not yet link. Example: { "node_id": "rule-recargo-por-pedido-urgente" }.',
      inputSchema: {
        node_id: z.string().describe('Canonical node id'),
        node_types: z.array(nodeTypeEnum).optional().describe('Restrict candidates to these types'),
        limit: z.number().int().min(1).max(30).optional().describe('Max results (default 10)'),
      },
      annotations: READ_ONLY,
    },
    async ({ node_id, node_types, limit }) => {
      const index = openIndex();
      try {
        const result = await similarQuery(index, node_id, {
          nodeTypes: node_types,
          limit,
          embeddings: await getProvider(),
        });
        if (!result) {
          return {
            content: [
              { type: 'text', text: `Node "${node_id}" not found. Use untacit_context to search by text.` },
            ],
            isError: true,
          };
        }
        if (result.similar.length === 0) {
          return {
            content: [{ type: 'text', text: `No similar nodes found for ${node_id}.` }],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        }
        const lines = result.similar.map((n) => {
          const parts = [
            n.semantic !== undefined ? `sem ${n.semantic}` : null,
            `struct ${n.structural}`,
            `lex ${n.lexical}`,
          ].filter((p) => p !== null);
          return `${n.score} · [${n.type}] ${n.id} — ${n.name} (${parts.join(', ')})`;
        });
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_evidence',
    {
      title: 'Provenance of a node or edge',
      description:
        'Complete evidence trail (excerpts + locators + stance + confidence inputs) backing a node ' +
        'or an edge. Pass a node id, or an edge id as returned by other tools. Example: ' +
        '{ "id": "rule-recargo-por-pedido-urgente" }.',
      inputSchema: {
        id: z.string().describe('Node id (e.g. "entity-pedido") or edge id (sha1 as returned by other tools)'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const index = openIndex();
      try {
        const result = evidenceQuery(index, id);
        if (result.items.length === 0) {
          return {
            content: [
              { type: 'text', text: `No evidence found for "${id}". Check the id with untacit_context.` },
            ],
            isError: true,
          };
        }
        const lines = result.items.map((item) => {
          const ev = item.evidence;
          const mark = ev.stance === 'contradicts' ? '-' : '+';
          const validated = ev.validated_by ? ` validated_by=${ev.validated_by}` : '';
          return `${mark} [${ev.source_type}] ${JSON.stringify(ev.locator)}${validated}\n  "${ev.excerpt}"`;
        });
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  server.registerTool(
    'untacit_diff',
    {
      title: 'Drift between two graph states',
      description:
        'Ontology-level diff between two git refs of the graph repo (added/removed/changed nodes ' +
        'and edges — business terms, not YAML lines). Defaults to the two most recent runs. ' +
        'Example: { "ref_a": "HEAD~1", "ref_b": "HEAD" }.',
      inputSchema: {
        ref_a: z.string().optional().describe('Older git ref (default: previous run commit)'),
        ref_b: z.string().optional().describe('Newer git ref (default: last run commit)'),
      },
      annotations: READ_ONLY,
    },
    async ({ ref_a, ref_b }) => {
      if (opts.gitAvailable === false) {
        return {
          content: [
            {
              type: 'text',
              text:
                'untacit_diff is not available in this deployment: it needs the git binary and ' +
                'this server runs without one (serverless/stateless mode). The other untacit ' +
                'tools work normally; run diffs where the graph repo is a live git clone.',
            },
          ],
          isError: true,
        };
      }
      const diff = diffQuery(repoRoot, ref_a, ref_b);
      return {
        content: [{ type: 'text', text: formatDiffText(diff) }],
        structuredContent: diff as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'untacit_conflicts',
    {
      title: 'Open contradictions',
      description:
        'Edges in conflicted state with their opposing evidence side by side — where sources ' +
        'disagree about how the business works. Takes no required input.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const index = openIndex();
      try {
        const conflicts = conflictsQuery(index);
        if (conflicts.length === 0) {
          return { content: [{ type: 'text', text: 'No open conflicts.' }], structuredContent: { conflicts: [] } };
        }
        const lines = conflicts.map((c) => {
          const supports = c.supporting.map((ev) => `  + [${ev.source_type}] "${ev.excerpt}"`);
          const contradicts = c.contradicting.map((ev) => `  - [${ev.source_type}] "${ev.excerpt}"`);
          return [`${c.nodeId} -${c.edgeType}-> ${c.target}`, ...supports, ...contradicts].join('\n');
        });
        return {
          content: [{ type: 'text', text: lines.join('\n\n') }],
          structuredContent: { conflicts } as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  // Agent surface: interview gaps, code candidates, doc sections and the
  // versioned extractor prompts (all read-only).
  if (opts.agentSurface !== false) {
    registerAgentSurface(server, repoRoot);
  }

  // Write surface: import gate + review-queue actions. Independent of the
  // agent surface so the self-hosted server can serve "query + write"
  // graphs whose extraction sources are not mounted (docs/06 §5).
  if (opts.write === true) {
    registerWriteSurface(server, repoRoot);
  }

  return server;
}

export async function serveMcp(repoRoot: string, opts: ServeOptions = {}): Promise<void> {
  const server = createServer(repoRoot, opts);
  await server.connect(new StdioServerTransport());
}

export { serveMcpHttp, type HttpServeOptions } from './http.js';
