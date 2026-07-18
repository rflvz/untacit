import { useEffect, useState } from 'react';

import { api } from '../api.js';
import type { Evidence, NodeDetailResponse } from '../api-types.js';
import { Chip, NodeDot } from '../ds/index.js';
import { NODE_TYPE_COLORS } from '../ontology.js';

/** Render a locator per source type (docs/03 §7: clickable pointer to the source). */
export function locatorText(ev: Evidence): string {
  const locator = ev.locator as Record<string, unknown>;
  switch (ev.source_type) {
    case 'code':
      return `${locator['repo']}/${locator['path']}:${locator['line_start']}-${locator['line_end']}${locator['commit'] ? ` @${String(locator['commit']).slice(0, 7)}` : ''}`;
    case 'document':
      return `${locator['title'] ?? locator['doc_id']} §${locator['section'] ?? locator['page'] ?? '?'}`;
    case 'interview':
      return `entrevista ${locator['interview_id']} · rol ${locator['speaker_role']} · turno ${locator['turn'] ?? '?'}`;
    default:
      return JSON.stringify(locator);
  }
}

/**
 * The locator is clickable for code/document evidence: POST /api/open resolves
 * it against the config's sources and opens the local file in the editor.
 */
function EvidenceLocator({ ev }: { ev: Evidence }) {
  const [state, setState] = useState<'idle' | 'opening' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const openable = ev.source_type === 'code' || ev.source_type === 'document';

  const open = () => {
    setState('opening');
    api
      .open(ev)
      .then(() => setState('idle'))
      .catch((err: Error) => {
        setState('error');
        setMessage(err.message);
      });
  };

  return (
    <span className="locator">
      [{ev.source_type}]{' '}
      {openable ? (
        <button
          className="locator-link"
          disabled={state === 'opening'}
          title="Abrir el fichero local en el editor"
          onClick={open}
        >
          {locatorText(ev)}
        </button>
      ) : (
        locatorText(ev)
      )}
      {ev.validated_by ? ` · validada por ${ev.validated_by}` : ''}
      {state === 'error' && <span className="locator-error"> no se pudo abrir: {message}</span>}
    </span>
  );
}

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return <div className="empty">Sin evidencia propia.</div>;
  return (
    <>
      {evidence.map((ev, i) => (
        <div key={i} className={`evidence-item ${ev.stance === 'contradicts' ? 'contradicts' : ''}`}>
          <span className="excerpt">
            <span className={`stance-mark ${ev.stance}`}>{ev.stance === 'contradicts' ? '−' : '+'}</span>
            “{ev.excerpt}”
          </span>
          <EvidenceLocator ev={ev} />
        </div>
      ))}
    </>
  );
}

export function DetailPanel({
  nodeId,
  onNavigate,
  onClose,
}: {
  nodeId: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<NodeDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    api
      .node(nodeId)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [nodeId]);

  if (error) return <aside className="detail-panel">{error}</aside>;
  if (!detail) return <aside className="detail-panel dim">Cargando…</aside>;

  const { node, edges } = detail;
  const outgoing = edges.filter((e) => e.direction === 'out');
  const incoming = edges.filter((e) => e.direction === 'in');

  return (
    <aside className="detail-panel">
      <div className="node-meta">
        <Chip tone="neutral" size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <NodeDot color={NODE_TYPE_COLORS[node.type]} size={6} />
          {node.type}
        </Chip>
        <Chip tone={node.status === 'conflicted' ? 'conflict' : 'neutral'} size="sm">
          {node.status}
        </Chip>
        <button className="icon-btn" onClick={onClose} title="Cerrar panel">
          ✕
        </button>
      </div>
      <h2>{node.name}</h2>
      <div className="mono dim">{node.id}</div>
      <p className="description">{node.description}</p>
      {node.aliases.length > 0 && (
        <div className="dim" style={{ fontSize: 12 }}>
          alias: {node.aliases.join(', ')}
        </div>
      )}

      <h3>Evidencia del nodo</h3>
      <EvidenceList evidence={node.evidence} />

      <h3>Aristas salientes ({outgoing.length})</h3>
      {outgoing.map(({ edge }) => (
        <div key={edge.id} className="edge-row">
          <span className="etype">{edge.type}</span>
          <span className="target" onClick={() => onNavigate(edge.targetId)}>
            {edge.targetId}
          </span>
          <ConfidenceBar value={edge.confidence} />
        </div>
      ))}
      {outgoing.length === 0 && <div className="empty">Ninguna.</div>}

      <h3>Aristas entrantes ({incoming.length})</h3>
      {incoming.map(({ edge }) => (
        <div key={edge.id} className="edge-row">
          <span className="etype">{edge.type}</span>
          <span className="target" onClick={() => onNavigate(edge.source)}>
            {edge.source}
          </span>
          <ConfidenceBar value={edge.confidence} />
        </div>
      ))}
      {incoming.length === 0 && <div className="empty">Ninguna.</div>}

      <h3>Evidencia de las aristas salientes</h3>
      <EvidenceList evidence={node.edges.flatMap((e) => e.evidence)} />
    </aside>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div className={`conf-bar ${value < 0.7 ? 'low' : ''}`} title={`confianza ${value}`}>
      <div style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}
