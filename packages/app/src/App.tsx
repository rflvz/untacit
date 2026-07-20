import { useEffect, useState } from 'react';

import { api } from './api.js';
import type { StatsResponse } from './api-types.js';
import { Chip, LogoMark } from './ds/index.js';
import {
  baseName,
  isDesktop,
  onRepoChanged,
  openRepoFolder,
  pickRepo,
  shellState,
  type ShellState,
} from './shell.js';
import { DriftView } from './views/DriftView.js';
import { GraphView } from './views/GraphView.js';
import { InterviewView } from './views/InterviewView.js';
import { ReviewView } from './views/ReviewView.js';
import { WelcomeView } from './views/WelcomeView.js';

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
  const [shell, setShell] = useState<ShellState | null>(null);
  // In the browser the shell doesn't exist, so it is "ready" from the start.
  const [shellReady, setShellReady] = useState(!isDesktop);
  // Repo reported by the sidecar (health) — the browser flow has no shell.
  const [sidecarRepo, setSidecarRepo] = useState<string | null>(null);

  const refreshStats = () => {
    api
      .stats()
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  // Desktop: load the shell state and follow repo switches (tray menu).
  useEffect(() => {
    if (!isDesktop) return;
    shellState()
      .then(setShell)
      .catch(() => setShell(null))
      .finally(() => setShellReady(true));
    return onRepoChanged(setShell);
  }, []);

  // Retry while the sidecar comes up (the shell spawns/restarts it alongside
  // the window, so the first fetches can race its startup). Re-runs on every
  // repo switch.
  const activeRepo = shell?.repo ?? null;
  const welcomeVisible = isDesktop && shellReady && shell !== null && activeRepo === null;
  useEffect(() => {
    if (!shellReady || welcomeVisible) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryStats = () => {
      api
        .stats()
        .then((s) => {
          setStats(s);
          setError(null);
          api
            .health()
            .then((h) => setSidecarRepo(h.repo))
            .catch(() => {});
        })
        .catch((err: Error) => {
          setError(err.message);
          if (attempts++ < 30) timer = setTimeout(tryStats, 1000);
        });
    };
    tryStats();
    return () => clearTimeout(timer);
  }, [shellReady, welcomeVisible, activeRepo]);

  if (welcomeVisible && shell !== null) {
    return <WelcomeView shell={shell} onShellChanged={setShell} />;
  }

  const repoPath = activeRepo ?? sidecarRepo;
  const handlePickRepo = () => {
    pickRepo()
      .then((next) => {
        if (next !== null) setShell(next);
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <>
      <header className="topbar">
        <LogoMark size={26} />
        {repoPath !== null && (
          <span className="repo-controls">
            <button
              type="button"
              className="repo-chip"
              title={
                isDesktop ? `${repoPath}\nAbrir la carpeta en el explorador` : repoPath
              }
              onClick={isDesktop ? () => void openRepoFolder() : undefined}
            >
              {baseName(repoPath)}
            </button>
            {isDesktop && (
              <button
                type="button"
                className="repo-chip repo-chip--switch"
                title="Cambiar la carpeta del repo del grafo"
                onClick={handlePickRepo}
              >
                Cambiar…
              </button>
            )}
          </span>
        )}
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
          {isDesktop ? (
            shell !== null && !shell.nodeOk && !shell.devMode ? (
              <>
                Falta <b>Node.js 20+</b>: el motor local no puede arrancar. Instala la
                versión LTS desde nodejs.org y vuelve a abrir untacit.
              </>
            ) : (
              <>
                Arrancando el motor local… ({error}). Si no conecta, comprueba que la
                carpeta seleccionada es un repo de grafo de untacit.
              </>
            )
          ) : (
            <>
              Sin conexión con el sidecar ({error}). Arranca{' '}
              <code className="mono">pnpm dev</code> con{' '}
              <code className="mono">UNTACIT_REPO</code> apuntando a un repo de grafo.
            </>
          )}
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
