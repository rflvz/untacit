import { useState } from 'react';

import { Button, GlassCard, LogoMark } from '../ds/index.js';
import { baseName, pickRepo, setRepo, type ShellState } from '../shell.js';

/**
 * First-run screen of the desktop shell: no graph repo is configured yet, so
 * nothing else can render. Offers the native folder picker and the
 * most-recently-used repos persisted by the shell (src-tauri/src/config.rs).
 */
export function WelcomeView({
  shell,
  onShellChanged,
}: {
  shell: ShellState;
  onShellChanged: (state: ShellState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<ShellState | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next !== null) onShellChanged(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome">
      <GlassCard size="lg" pad="42px 46px" style={{ maxWidth: 580, width: '100%' }}>
        <div className="welcome-logo">
          <LogoMark size={42} />
        </div>
        <h1 className="welcome-title">Bienvenido a untacit</h1>
        <p className="welcome-lead">
          Selecciona la carpeta del <b>repo del grafo</b>: el repositorio git donde untacit
          guarda el conocimiento de tu organización (creado con{' '}
          <code className="mono">untacit init</code> o clonado de tu equipo). Podrás cambiarla
          cuando quieras desde la barra superior o desde el icono de la bandeja del sistema.
        </p>
        <Button onClick={() => void run(pickRepo)} disabled={busy}>
          Seleccionar carpeta…
        </Button>
        {shell.recent.length > 0 && (
          <div className="welcome-recent">
            <p className="welcome-recent-title">Recientes</p>
            {shell.recent.map((path) => (
              <button
                key={path}
                type="button"
                className="welcome-recent-item"
                title={path}
                disabled={busy}
                onClick={() => void run(() => setRepo(path))}
              >
                <span className="welcome-recent-name">{baseName(path)}</span>
                <span className="welcome-recent-path">{path}</span>
              </button>
            ))}
          </div>
        )}
        {!shell.nodeOk && !shell.devMode && (
          <p className="welcome-warn">
            Falta <b>Node.js 20+</b>: el motor local no podrá arrancar. Instala la versión LTS
            desde nodejs.org y vuelve a abrir untacit.
          </p>
        )}
        {error !== null && <p className="welcome-error">{error}</p>}
      </GlassCard>
    </main>
  );
}
