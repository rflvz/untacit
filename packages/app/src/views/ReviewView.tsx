import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import type { Conflict, ConflictEvidence, ReviewResponse } from '../api-types.js';
import { Button, GlassCard, MetaPill, SectionHeader } from '../ds/index.js';
import { locatorText } from './DetailPanel.js';

const CARD_PAD = '18px 22px';

/** The three review trays (docs/03 §7 point 3): merges, low confidence, conflicts. */
export function ReviewView({ onChanged }: { onChanged: () => void }) {
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    api.review().then(setReview).catch(() => setReview(null));
  }, []);

  useEffect(load, [load]);

  const act = async (proposalId: string, action: 'accept' | 'reject') => {
    setBusy(proposalId);
    try {
      const result =
        action === 'accept' ? await api.acceptMerge(proposalId) : await api.rejectMerge(proposalId);
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
            <GlassCard key={p.id} pad={CARD_PAD} style={{ marginBottom: 12 }}>
              <div className="row">
                <span className="mono">{p.sourceNodeId}</span>
                <span className="dim">→ ¿es el mismo elemento que →</span>
                <span className="mono">{p.targetNodeId}</span>
                <MetaPill style={{ marginLeft: 'auto' }}>score {p.score}</MetaPill>
              </div>
              <div className="dim" style={{ margin: '8px 0 12px', fontSize: 13 }}>
                mención origen: “{p.mention}”
              </div>
              <div className="row">
                <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, 'accept')}>
                  Aprobar merge
                </Button>
                <Button
                  variant="glass"
                  size="sm"
                  disabled={busy === p.id}
                  onClick={() => act(p.id, 'reject')}
                >
                  Mantener separados
                </Button>
              </div>
            </GlassCard>
          ))}
        </section>

        <section className="tray">
          <h3>
            Aristas bajo el umbral de confianza ({review.lowConfidence.length}, umbral{' '}
            {review.threshold})
          </h3>
          {review.lowConfidence.length === 0 && <div className="empty">Ninguna.</div>}
          {review.lowConfidence.map((edge) => (
            <GlassCard key={edge.id} pad={CARD_PAD} style={{ marginBottom: 12 }}>
              <div className="row">
                <span className="mono">
                  {edge.source} -{edge.type}→ {edge.target}
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
              onResolve={(winner) => resolveConflict(conflict, winner)}
            />
          ))}
        </section>
      </div>
    </div>
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
  onResolve,
}: {
  conflict: Conflict;
  busy: boolean;
  onResolve: (winner: ConflictEvidence) => void;
}) {
  return (
    <GlassCard pad={CARD_PAD} style={{ marginBottom: 12 }}>
      <div className="mono" style={{ marginBottom: 12, color: 'var(--amber)' }}>
        {conflict.nodeId} -{conflict.edgeType}→ {conflict.target}
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
