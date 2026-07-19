/**
 * Write surface of the untacit MCP server: EVERYTHING that mutates the graph
 * repo, gathered behind the single `write` switch (docs/03 §6, docs/06 §7).
 *
 * - untacit_import_batch — the validate → resolve → materialize → commit
 *   pipeline every extractor uses (the only way new nodes/edges enter).
 * - untacit_review_queue — the three review trays (pending merges, low
 *   confidence, conflicts) plus revertible merges, so a remote agent can run
 *   the same review workflow as the desktop app.
 * - untacit_merge_accept / untacit_merge_reject / untacit_merge_revert and
 *   untacit_conflict_resolve — the review actions themselves, mirroring the
 *   sidecar endpoints: one core operation, store.write(), one git commit.
 *
 * Registered only when the server runs with writes enabled
 * (`untacit serve-mcp --write`, `untacit-mcp --write [--http]`, or a
 * write-granted session on the self-hosted server, docs/06 §5).
 */

import {
  BATCH_JSON_SCHEMA,
  DEFAULT_REVIEW_THRESHOLD,
  EDGE_TYPES,
  GraphIndex,
  GraphStore,
  acceptMergeProposal,
  gitCommitAll,
  importBatch,
  loadMergesFile,
  rejectMergeProposal,
  resolveConflictEdge,
  revertMerge,
} from '@untacit/core';
import type { EdgeType, StoredMergeRecord } from '@untacit/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Non-destructive writes: additive imports and recorded, reversible decisions. */
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Uniform error surface: core throws with actionable messages — relay them. */
function toolError(err: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

export function registerWriteSurface(server: McpServer, repoRoot: string): void {
  const edgeTypeEnum = z.enum(EDGE_TYPES as [EdgeType, ...EdgeType[]]);

  // ---------------------------------------------------------------------------
  // untacit_import_batch — how new knowledge enters the graph
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_import_batch',
    {
      title: 'Import an extraction batch into the graph repo',
      description:
        'Validate → resolve entities → materialize canonical files → commit (one run = one ' +
        'commit). This is the ONLY way new nodes/edges enter the graph: emit them as an extraction ' +
        'batch (contract untacit/extraction-batch.v1 — get it via the untacit-extract-* or ' +
        'untacit-interview prompts). Invalid items are rejected with reasons, valid ones are ' +
        'salvaged. Re-importing an identical batch is a no-op (idempotent). ' +
        'Interview batches: evidence validated live must carry "validated_by": "<rol>".',
      inputSchema: {
        batch: z
          .record(z.unknown())
          .describe(
            'Extraction batch JSON: { run_id, source_type: "code"|"document"|"interview", nodes: [...], edges: [...] } per untacit/extraction-batch.v1',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ batch }) => {
      const result = await importBatch(repoRoot, batch);
      const s = result.stats;
      const lines = [
        result.noop
          ? `run ${result.runId}: sin cambios (re-import idéntico)`
          : `run ${result.runId}: +${s.nodes_created}/~${s.nodes_updated} nodos, +${s.edges_created}/~${s.edges_updated} aristas, +${s.evidence_added} evidencias`,
        ...(result.commit !== null ? [`commit ${result.commit.slice(0, 10)}`] : []),
        ...result.rejections.map((r) => `rechazado ${r.path}: ${r.message}`),
        ...result.proposals.map(
          (p) => `¿merge? ${p.sourceNodeId} -> ${p.targetNodeId} (score ${p.score}) — pendiente en la cola de revisión`,
        ),
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          runId: result.runId,
          noop: result.noop,
          commit: result.commit,
          stats: result.stats,
          rejections: result.rejections,
          proposals: result.proposals,
        } as unknown as Record<string, unknown>,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // untacit_review_queue — what a human (or delegated agent) must decide
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_review_queue',
    {
      title: 'Review queue: pending merges, low confidence, conflicts',
      description:
        'The three review trays of the graph (docs/03 §7): pending merge proposals (act with ' +
        'untacit_merge_accept / untacit_merge_reject), edges below the confidence threshold, and ' +
        'open conflicts with per-evidence keys (act with untacit_conflict_resolve). Also lists ' +
        'accepted merges that can still be undone with untacit_merge_revert. Takes no required input.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const index = GraphIndex.open(repoRoot);
      try {
        const merges = loadMergesFile(repoRoot);
        const proposals = merges.proposals.filter((p) => p.status === 'pending');
        const revertible = (merges.merges as StoredMergeRecord[]).filter(
          (m) => m.reverted_at === undefined,
        );
        const lowConfidence = index.lowConfidenceEdges();
        const conflicts = index.conflicts();
        const lines = [
          `Merges pendientes (${proposals.length}):`,
          ...proposals.map(
            (p) => `  ${p.id}: ${p.sourceNodeId} -> ${p.targetNodeId} («${p.mention}», score ${p.score})`,
          ),
          '',
          `Aristas de baja confianza (< ${DEFAULT_REVIEW_THRESHOLD}) (${lowConfidence.length}):`,
          ...lowConfidence.map((e) => `  ${e.source} -${e.type}-> ${e.target} (conf ${e.confidence})`),
          '',
          `Conflictos abiertos (${conflicts.length}):`,
          ...conflicts.flatMap((c) => [
            `  ${c.nodeId} -${c.edgeType}-> ${c.target}`,
            ...c.supporting.map((ev) => `    + [${ev.key}] [${ev.source_type}] "${ev.excerpt}"`),
            ...c.contradicting.map((ev) => `    - [${ev.key}] [${ev.source_type}] "${ev.excerpt}"`),
          ]),
          ...(revertible.length > 0
            ? [
                '',
                `Merges aceptados reversibles (${revertible.length}):`,
                ...revertible.map((m) => `  ${m.id}: ${m.fromNodeId} -> ${m.intoNodeId}`),
              ]
            : []),
        ];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            proposals,
            lowConfidence,
            conflicts,
            revertibleMerges: revertible,
            threshold: DEFAULT_REVIEW_THRESHOLD,
          } as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // untacit_merge_accept / untacit_merge_reject / untacit_merge_revert
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_merge_accept',
    {
      title: 'Accept a pending merge proposal',
      description:
        'Absorb the proposal\'s provisional node into its target: aliases and evidence merged, ' +
        'edges re-keyed, inbound edges retargeted, decision committed. Reversible later with ' +
        'untacit_merge_revert. Find proposal ids with untacit_review_queue. ' +
        'Example: { "proposal_id": "a1b2c3d4e5", "by": "administracion" }.',
      inputSchema: {
        proposal_id: z.string().min(1).describe('Proposal id from untacit_review_queue'),
        by: z.string().optional().describe('Role recording the decision (never a person\'s name)'),
      },
      annotations: WRITE,
    },
    async ({ proposal_id, by }) => {
      try {
        const store = GraphStore.load(repoRoot);
        const record = acceptMergeProposal(store, proposal_id, by);
        store.write();
        const commit = gitCommitAll(
          repoRoot,
          `untacit: accept merge ${record.fromNodeId} -> ${record.intoNodeId} (proposal ${proposal_id})`,
        );
        return {
          content: [
            {
              type: 'text',
              text: `merge aceptado: ${record.fromNodeId} -> ${record.intoNodeId} (id ${record.id}${commit !== null ? `, commit ${commit.slice(0, 10)}` : ''})`,
            },
          ],
          structuredContent: { ok: true, proposalId: proposal_id, record, commit } as unknown as Record<
            string,
            unknown
          >,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'untacit_merge_reject',
    {
      title: 'Reject a pending merge proposal',
      description:
        'Mark the proposal rejected: the provisional node stays as its own node. ' +
        'Example: { "proposal_id": "a1b2c3d4e5" }.',
      inputSchema: {
        proposal_id: z.string().min(1).describe('Proposal id from untacit_review_queue'),
        by: z.string().optional().describe('Role recording the decision (never a person\'s name)'),
      },
      annotations: WRITE,
    },
    async ({ proposal_id, by }) => {
      try {
        rejectMergeProposal(repoRoot, proposal_id, by);
        const commit = gitCommitAll(repoRoot, `untacit: reject merge proposal ${proposal_id}`);
        return {
          content: [{ type: 'text', text: `merge rechazado: propuesta ${proposal_id}` }],
          structuredContent: { ok: true, proposalId: proposal_id, commit } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'untacit_merge_revert',
    {
      title: 'Revert an accepted merge',
      description:
        'Restore the absorbed node from its snapshot and retarget the rewired inbound edges back. ' +
        'Evidence folded into pre-existing edges during the merge stays there (documented v1 ' +
        'limitation). Find merge ids with untacit_review_queue. Example: { "merge_id": "f6e5d4c3b2" }.',
      inputSchema: {
        merge_id: z.string().min(1).describe('Merge record id from untacit_review_queue'),
      },
      annotations: WRITE,
    },
    async ({ merge_id }) => {
      try {
        const store = GraphStore.load(repoRoot);
        revertMerge(store, merge_id);
        store.write();
        const commit = gitCommitAll(repoRoot, `untacit: revert merge ${merge_id}`);
        return {
          content: [{ type: 'text', text: `merge revertido: ${merge_id}` }],
          structuredContent: { ok: true, mergeId: merge_id, commit } as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // untacit_conflict_resolve — close a contradiction by picking the winner
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_conflict_resolve',
    {
      title: 'Resolve a conflicted edge',
      description:
        'Mark the winning evidence of a conflicted edge: a supporting winner returns the edge to ' +
        'active, a contradicting winner deprecates it; the decision is recorded on the edge and ' +
        'survives identical re-imports. Get node/edge/target and per-evidence keys from ' +
        'untacit_review_queue or untacit_conflicts. Example: { "node_id": ' +
        '"rule-recargo-por-pedido-urgente", "edge_type": "GOVERNS", "target": ' +
        '"process/process-alta-de-pedido", "winner_key": "1a2b3c4d5e", "by": "gerencia" }.',
      inputSchema: {
        node_id: z.string().min(1).describe('Node that owns the conflicted edge'),
        edge_type: edgeTypeEnum.describe('Type of the conflicted edge'),
        target: z.string().min(1).describe('Target ref exactly as stored, e.g. "process/process-alta-de-pedido"'),
        winner_key: z.string().min(1).describe('Key of the winning evidence (untacit_review_queue lists one per evidence)'),
        by: z.string().optional().describe('Role recording the decision (never a person\'s name)'),
      },
      annotations: WRITE,
    },
    async ({ node_id, edge_type, target, winner_key, by }) => {
      try {
        const store = GraphStore.load(repoRoot);
        const { edge, resolution } = resolveConflictEdge(store, {
          nodeId: node_id,
          edgeType: edge_type,
          target,
          winnerKey: winner_key,
          by,
        });
        store.write();
        const commit = gitCommitAll(
          repoRoot,
          `untacit: resolve conflict ${node_id} -${edge_type}-> ${target} (${resolution.status})`,
        );
        return {
          content: [
            {
              type: 'text',
              text: `conflicto resuelto: ${node_id} -${edge_type}-> ${target} → ${edge.status}${commit !== null ? ` (commit ${commit.slice(0, 10)})` : ''}`,
            },
          ],
          structuredContent: { ok: true, status: edge.status, resolution, commit } as unknown as Record<
            string,
            unknown
          >,
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
