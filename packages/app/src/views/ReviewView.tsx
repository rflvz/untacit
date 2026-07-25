import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import type {
  ApiEdge,
  Conflict,
  ConflictEvidence,
  MergeProposal,
  NodeDetailResponse,
  ReviewResponse,
} from '../api-types.js';
import { Button, GlassCard, MetaPill, SectionHeader } from '../ds/index.js';
import { locatorText } from './DetailPanel.js';

const CARD_PAD = '18px 22px';
const REVIEWER_KEY = 'untacit.reviewer';

/** A node id rendered as a jump-to-graph link. */
function NodeLink({ id, onOpenNode }: { id: string; onOpenNode: (id: string) => void }) {
  return (
    <button
      type="button"
      className="node-link"
      title="Ver este nodo en el grafo"
      onClick={() => onOpenNode(id)}
    >
      {id}
    </button>
  );
}

/** The three review trays (docs/03 §7 point 3): merges, low confidence, conflicts. */
export function ReviewView({
  onChanged,
  onOpenNode,
  onGoToInterview,
}: {
  onChanged: () => void;
  /** Jump to the graph tab focused on a node. */
  onOpenNode: (id: string) => void;
  /** Jump to the interview tab (cross-check of low-confidence edges). */
  onGoToInterview: () => void;
}) {
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState(
    () => window.localStorage.getItem(REVIEWER_KEY) ?? '',
  );

  const load = useCallback(() => {
    api.review().then(setReview).catch(() => setReview(null));
  }, []);

  useEffect(load, [load]);

  const setAndStoreReviewer = (value: string) => {
    setReviewer(value);
    window.localStorage.setItem(REVIEWER_KEY, value);
  };
  // Role recorded in merges.json / conflict resolutions (a role, never a name).
  const by = reviewer.trim() === '' ? undefined : reviewer.trim();

  const act = async (proposalId: string, action: 'accept' | 'reject') => {
    setBusy(proposalId);
    try {
      const result =
        action === 'accept'
          ? await api.acceptMerge(proposalId, by)
          : await api.rejectMerge(proposalId, by);
      setMessage(
        `Propuesta ${proposalId} ${result.action === 'accepted' ? 'aceptada' : 'rechazada'}${result.commit ? ` (commit ${result.commit.slice(0, 8)})` : ''}`,
      );
      load();
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const resolveConflict = async (conflict: Conflict, winner: ConflictEvidence) => {
    setBusy(conflict.id);
    try {
      const result = await api.resolveConflict({
        nodeId: conflict.nodeId,
        edgeType: conflict.edgeType,
        target: conflict.target,
        winnerKey: winner.key,
        ...(by !== undefined ? { by } : {}),
      });
      setMessage(
        `Conflicto resuelto: ${conflict.nodeId} -${conflict.edgeType}→ ${conflict.target} → ${result.status}${result.commit ? ` (commit ${result.commit.slice(0, 8)})` : ''}`,
      );
      load();
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!review) return <div className="page dim">Cargando cola de revisión…</div>;

  const pending = review.proposals.filter((p) => p.status === 'pending');

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="02"
          kicker="revisión"
          title="Cola de revisión"
          lead="Nada entra al grafo sin pasar por aquí: merges propuestos, aristas dudosas y conflictos abiertos."
        />
        <label className="reviewer-field" title="Se registra en cada decisión (merges.json, resoluciones). Un rol, nunca un nombre.">
          <span className="dim" style={{ fontSize: 12.5, flexShrink: 0 }}>
            Decides como (rol):
          </span>
          <input
            type="text"
            placeholder="p. ej. responsable-operaciones"
            value={reviewer}
            onChange={(e) => setAndStoreReviewer(e.target.value)}
          />
        </label>
        {message && (
          <div className="dim mono" style={{ marginBottom: 18, fontSize: 12 }}>
            ✓ {message}
          </div>
        )}

        <section className="tray">
          <h3>Merges propuestos ({pending.length})</h3>
          {pending.length === 0 && (
            <div className="empty">Nada pendiente: el resolver no tiene dudas.</div>
          )}
          {pending.map((p) => (
            <MergeCard
              key={p.id}
              proposal={p}
              busy={busy === p.id}
              onOpenNode={onOpenNode}
              onAct={(action) => act(p.id, action)}
            />
          ))}
        </section>

        <section className="tray">
          <h3>
            Aristas bajo el umbral de confianza ({review.lowConfidence.length}, umbral{' '}
            {review.threshold})
          </h3>
          {review.lowConfidence.length === 0 && <div className="empty">Ninguna.</div>}
          {review.lowConfidence.length > 0 && (
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="dim" style={{ fontSize: 12.5 }}>
                Estas afirmaciones se verifican con una persona: la entrevista las presenta como
                claims para confirmar o refutar.
              </span>
              <Button size="sm" variant="glass" onClick={onGoToInterview}>
                Verificar en entrevista
              </Button>
            </div>
          )}
          {review.lowConfidence.map((edge: ApiEdge) => (
            <GlassCard key={edge.id} pad={CARD_PAD} style={{ marginBottom: 12 }}>
              <div className="row">
                <span className="mono">
                  <NodeLink id={edge.source} onOpenNode={onOpenNode} /> -{edge.type}→{' '}
                  <NodeLink id={edge.targetId} onOpenNode={onOpenNode} />
                </span>
                <MetaPill style={{ marginLeft: 'auto' }}>conf {edge.confidence}</MetaPill>
              </div>
              <div className="dim" style={{ marginTop: 6, fontSize: 13 }}>
                Pendiente de verificación cruzada (candidata para la entrevista agéntica).
              </div>
            </GlassCard>
          ))}
        </section>

        <section className="tray">
          <h3>Conflictos abiertos ({review.conflicts.length})</h3>
          {review.conflicts.length === 0 && <div className="empty">Ninguno.</div>}
          {review.conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              busy={busy === conflict.id}
              onOpenNode={onOpenNode}
              onResolve={(winner) => resolveConflict(conflict, winner)}
            />
          ))}
        </section>
      </div>
    </div>
  );
}

/** One side of a merge proposal: name + first description line, lazily loaded. */
function MergeSide({ nodeId, label }: { nodeId: string; label: string }) {
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .node(nodeId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  return (
    <div className="merge-side">
      <span className="dim">{label}: </span>
      {detail !== null ? (
        <>
          <b>{detail.node.name}</b>
          <span className="dim mono" style={{ fontSize: 11 }}> · {detail.node.type}</span>
          <div className="dim" style={{ marginTop: 2 }}>
            {detail.node.description.split('\n', 1)[0]}
          </div>
        </>
      ) : missing ? (
        <span className="dim">nodo no indexado todavía</span>
      ) : (
        <span className="dim">cargando…</span>
      )}
    </div>
  );
}

/** A merge proposal with enough context (both nodes) to decide without leaving the tray. */
function MergeCard({
  proposal,
  busy,
  onOpenNode,
  onAct,
}: {
  proposal: MergeProposal;
  busy: boolean;
  onOpenNode: (id: string) => void;
  onAct: (action: 'accept' | 'reject') => void;
}) {
  return (
    <GlassCard pad={CARD_PAD} style={{ marginBottom: 12 }}>
      <div className="row">
        <NodeLink id={proposal.sourceNodeId} onOpenNode={onOpenNode} />
        <span className="dim">→ ¿es el mismo elemento que →</span>
        <NodeLink id={proposal.targetNodeId} onOpenNode={onOpenNode} />
        <MetaPill style={{ marginLeft: 'auto' }}>score {proposal.score}</MetaPill>
      </div>
      <div className="dim" style={{ margin: '8px 0 0', fontSize: 13 }}>
        mención origen: “{proposal.mention}”
      </div>
      <MergeSide nodeId={proposal.sourceNodeId} label="Provisional" />
      <MergeSide nodeId={proposal.targetNodeId} label="Candidato existente" />
      <div className="row" style={{ marginTop: 12 }}>
        <Button size="sm" disabled={busy} onClick={() => onAct('accept')}>
          Aprobar merge
        </Button>
        <Button variant="glass" size="sm" disabled={busy} onClick={() => onAct('reject')}>
          Mantener separados
        </Button>
      </div>
    </GlassCard>
  );
}

/**
 * One conflicted edge with its opposing evidence; the human marks the winning
 * evidence and the edge returns to active (supports) or turns deprecated
 * (contradicts). docs/02 §6: conflicts resolve ONLY from this queue.
 */
function ConflictCard({
  conflict,
  busy,
  onOpenNode,
  onResolve,
}: {
  conflict: Conflict;
  busy: boolean;
  onOpenNode: (id: string) => void;
  onResolve: (winner: ConflictEvidence) => void;
}) {
  return (
    <GlassCard pad={CARD_PAD} style={{ marginBottom: 12 }}>
      <div className="mono" style={{ marginBottom: 12, color: 'var(--amber)' }}>
        <NodeLink id={conflict.nodeId} onOpenNode={onOpenNode} /> -{conflict.edgeType}→{' '}
        {conflict.target}
      </div>
      {[...conflict.supporting, ...conflict.contradicting].map((ev) => (
        <div
          key={ev.key}
          className={`evidence-item ${ev.stance === 'contradicts' ? 'contradicts' : ''}`}
        >
          <span className="excerpt">
            <span className={`stance-mark ${ev.stance}`}>
              {ev.stance === 'contradicts' ? '−' : '+'}
            </span>
            “{ev.excerpt}”
          </span>
          <span className="locator">
            [{ev.source_type}] {locatorText(ev)}
            {ev.validated_by ? ` · validada por ${ev.validated_by}` : ''}
          </span>
          <div className="row" style={{ marginTop: 10 }}>
            <Button
              variant={ev.stance === 'contradicts' ? 'glass' : 'primary'}
              size="sm"
              disabled={busy}
              title={
                ev.stance === 'contradicts'
                  ? 'Esta evidencia gana: la afirmación ya no vale → arista deprecated'
                  : 'Esta evidencia gana: la arista vuelve a active'
              }
              onClick={() => onResolve(ev)}
            >
              Elegir como ganadora
            </Button>
          </div>
        </div>
      ))}
      <div className="dim" style={{ marginTop: 10, fontSize: 13 }}>
        Si gana una evidencia a favor, la arista vuelve a <span className="mono">active</span>; si
        gana una en contra, pasa a <span className="mono">deprecated</span>. Evidencia nueva reabre
        el conflicto.
      </div>
    </GlassCard>
  );
}
