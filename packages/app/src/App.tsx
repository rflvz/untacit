import { useEffect, useState } from 'react';

import { api } from './api.js';
import type { StatsResponse } from './api-types.js';
import { Chip, LogoMark } from './ds/index.js';
import { DriftView } from './views/DriftView.js';
import { GraphView } from './views/GraphView.js';
import { InterviewView } from './views/InterviewView.js';
import { ReviewView } from './views/ReviewView.js';

type Tab = 'graph' | 'review' | 'drift' | 'interview';

const TABS: { id: Tab; label: string }[] = [
  { id: 'graph', label: 'Grafo' },
  { id: 'review', label: 'Revisión' },
  { id: 'drift', label: 'Drift' },
  { id: 'interview', label: 'Entrevista' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('graph');
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStats = () => {
    api
      .stats()
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  // Retry while the sidecar comes up (the Tauri shell spawns it alongside the
  // window, so the very first fetch can race its startup).
  useEffect(() => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryStats = () => {
      api
        .stats()
        .then((s) => {
          setStats(s);
          setError(null);
        })
        .catch((err: Error) => {
          setError(err.message);
          if (attempts++ < 10) timer = setTimeout(tryStats, 1000);
        });
    };
    tryStats();
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <header className="topbar">
        <LogoMark size={26} />
        {stats && (
          <div className="stats">
            <span className="stats-nums">
              <b>{stats.nodes_total}</b> nodos · <b>{stats.edges_total}</b> aristas ·{' '}
              <b>{stats.evidence_total}</b> evidencias
            </span>
            {stats.conflicts_open > 0 && (
              <Chip tone="conflict" size="sm" style={{ flexShrink: 0 }}>
                {stats.conflicts_open} conflictos
              </Chip>
            )}
          </div>
        )}
        <nav className="tabs">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {error && (
        <div className="error-banner">
          Sin conexión con el sidecar ({error}). Arranca <code className="mono">pnpm dev</code> con{' '}
          <code className="mono">UNTACIT_REPO</code> apuntando a un repo de grafo.
        </div>
      )}
      <main>
        {tab === 'graph' && <GraphView />}
        {tab === 'review' && <ReviewView onChanged={refreshStats} />}
        {tab === 'drift' && <DriftView />}
        {tab === 'interview' && <InterviewView onChanged={refreshStats} />}
      </main>
    </>
  );
}
