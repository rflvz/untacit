import { useState } from 'react';

import { api } from '../api.js';
import type { DiffResponse } from '../api-types.js';
import { Button, SectionHeader, Terminal } from '../ds/index.js';

/** Drift between two git refs of the graph repo, in ontology terms (docs/03 §5). */
export function DriftView() {
  const [refA, setRefA] = useState('HEAD~1');
  const [refB, setRefB] = useState('HEAD');
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const compare = () => {
    setLoading(true);
    api
      .diff(refA, refB)
      .then((d) => {
        setDiff(d);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err.message);
        setDiff(null);
      })
      .finally(() => setLoading(false));
  };

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="03"
          kicker="drift"
          title="Drift entre dos estados del grafo"
          lead="El código hace X, el manual dice Y: compara dos refs de git del repo del grafo en términos de la ontología."
        />
        <div className="drift-controls">
          <input
            type="text"
            value={refA}
            onChange={(e) => setRefA(e.target.value)}
            placeholder="ref antigua"
          />
          <span className="dim mono">→</span>
          <input
            type="text"
            value={refB}
            onChange={(e) => setRefB(e.target.value)}
            placeholder="ref nueva"
          />
          <Button size="sm" onClick={compare} disabled={loading}>
            {loading ? 'Comparando…' : 'Comparar'}
          </Button>
        </div>
        {error && <div className="error-banner" style={{ margin: '0 0 16px' }}>{error}</div>}
        {diff && (
          <>
            <div className="dim" style={{ marginBottom: 14, fontSize: 13 }}>
              {diff.diff.nodes.length} nodos y {diff.diff.edges.length} aristas con cambios entre{' '}
              <span className="mono">{diff.diff.ref_a.slice(0, 10)}</span> y{' '}
              <span className="mono">{diff.diff.ref_b.slice(0, 10)}</span>
            </div>
            <Terminal
              title="untacit diff"
              rightMeta={`${diff.diff.ref_a.slice(0, 10)} → ${diff.diff.ref_b.slice(0, 10)}`}
              dense
            >
              <pre className="diff-text">
                {diff.text.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith('+')
                        ? 'diff-added'
                        : line.startsWith('-')
                          ? 'diff-removed'
                          : line.startsWith('~')
                            ? 'diff-changed'
                            : undefined
                    }
                  >
                    {line}
                  </div>
                ))}
              </pre>
            </Terminal>
          </>
        )}
      </div>
    </div>
  );
}
