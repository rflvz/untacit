import { useEffect, useState } from 'react';

import { api } from './api.js';
import type { HealthResponse, StatsResponse } from './api-types.js';
import { Button, Chip, GlassCard, LogoMark } from './ds/index.js';
import {
  baseName,
  installUpdate,
  isDesktop,
  onRepoChanged,
  onUpdateAvailable,
  openRepoFolder,
  pickRepo,
  shellState,
  type ShellState,
  type UpdateInfo,
} from './shell.js';
import { DriftView } from './views/DriftView.js';
import { GraphView } from './views/GraphView.js';
import { InterviewView } from './views/InterviewView.js';
import { ReviewView } from './views/ReviewView.js';
import { RunsView } from './views/RunsView.js';
import { SettingsView } from './views/SettingsView.js';
import { WelcomeView } from './views/WelcomeView.js';

type Tab = 'graph' | 'review' | 'runs' | 'drift' | 'interview' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'graph', label: 'Grafo' },
  { id: 'review', label: 'Revisión' },
  { id: 'runs', label: 'Runs' },
  { id: 'drift', label: 'Drift' },
  { id: 'interview', label: 'Entrevista' },
  { id: 'settings', label: 'Ajustes' },
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
  // Newer release announced by the shell's silent startup check.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  // Last health report: drives the "initialize a graph repo here" screen.
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  // Node another view asked the graph tab to focus (Revisión → Grafo).
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

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

  useEffect(() => onUpdateAvailable(setUpdate), []);

  // Retry while the sidecar comes up (the shell spawns/restarts it alongside
  // the window, so the first fetches can race its startup). Re-runs on every
  // repo switch.
  const activeRepo = shell?.repo ?? null;
  const welcomeVisible = isDesktop && shellReady && shell !== null && activeRepo === null;
  useEffect(() => {
    if (!shellReady || welcomeVisible) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Health first: a folder that is not a graph repo gets the init screen
    // instead of stats queries (which would create .untacit/ in it).
    const tryConnect = () => {
      api
        .health()
        .then((h) => {
          setHealth(h);
          setSidecarRepo(h.repo);
          if (!h.isGraphRepo) {
            setStats(null);
            setError(null);
            return;
          }
          api
            .stats()
            .then((s) => {
              setStats(s);
              setError(null);
            })
            .catch((err: Error) => {
              setError(err.message);
              if (attempts++ < 30) timer = setTimeout(tryConnect, 1000);
            });
        })
        .catch((err: Error) => {
          setHealth(null);
          setError(err.message);
          if (attempts++ < 30) timer = setTimeout(tryConnect, 1000);
        });
    };
    tryConnect();
    return () => clearTimeout(timer);
  }, [shellReady, welcomeVisible, activeRepo, retryTick]);

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

  // The picked folder exists but has no untacit.config.json: offer to create
  // the graph-repo skeleton right here (the CLI's `untacit init`, one click).
  const initNeeded =
    health !== null && health.repoExists && health.core === 'loaded' && !health.isGraphRepo;
  if (initNeeded) {
    const handleInit = () => {
      setInitBusy(true);
      api
        .init()
        .then(() => {
          setHealth(null);
          setRetryTick((t) => t + 1);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setInitBusy(false));
    };
    return (
      <main className="welcome">
        <GlassCard size="lg" pad="42px 46px" style={{ maxWidth: 580, width: '100%' }}>
          <div className="welcome-logo">
            <LogoMark size={42} />
          </div>
          <h1 className="welcome-title">Esta carpeta aún no es un repo de grafo</h1>
          <p className="welcome-lead">
            <code className="mono">{repoPath}</code> no contiene un{' '}
            <code className="mono">untacit.config.json</code>. Puedes inicializarla ahora: se crea
            la estructura (<code className="mono">graph/</code>, <code className="mono">runs/</code>,
            configuración y git) y el grafo empieza vacío, listo para importar extracciones o
            entrevistar.
          </p>
          <div className="init-actions">
            <Button onClick={handleInit} disabled={initBusy}>
              {initBusy ? 'Inicializando…' : 'Inicializar repo del grafo aquí'}
            </Button>
            {isDesktop && (
              <Button variant="glass" onClick={handlePickRepo} disabled={initBusy}>
                Elegir otra carpeta…
              </Button>
            )}
          </div>
          {error !== null && <p className="welcome-error">{error}</p>}
        </GlassCard>
      </main>
    );
  }

  const openNode = (id: string) => {
    setFocusNodeId(id);
    setTab('graph');
  };
  // On Windows the shell downloads and launches the installer (the app
  // quits); elsewhere it opens the release page. Errors land in setError.
  const handleUpdate = () => {
    setUpdating(true);
    installUpdate()
      .then(() => setUpdating(false))
      .catch((err: Error) => {
        setUpdating(false);
        setError(err.message);
      });
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
        {update !== null && (
          <button
            type="button"
            className="repo-chip update-chip"
            disabled={updating}
            title={`untacit ${update.latest} está disponible (tienes ${update.current}). Un clic descarga y ejecuta el instalador.`}
            onClick={handleUpdate}
          >
            {updating ? 'Descargando…' : `Actualizar a ${update.latest}`}
          </button>
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
        {tab === 'graph' && (
          <GraphView focusId={focusNodeId} onFocusHandled={() => setFocusNodeId(null)} />
        )}
        {tab === 'review' && (
          <ReviewView
            onChanged={refreshStats}
            onOpenNode={openNode}
            onGoToInterview={() => setTab('interview')}
          />
        )}
        {tab === 'runs' && (
          <RunsView onChanged={refreshStats} onGoToReview={() => setTab('review')} />
        )}
        {tab === 'drift' && <DriftView />}
        {tab === 'interview' && <InterviewView onChanged={refreshStats} />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </>
  );
}
