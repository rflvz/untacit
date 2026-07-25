import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.js';
import type {
  GitStatusResponse,
  ImportResponse,
  RunMeta,
  RunsResponse,
} from '../api-types.js';
import { Button, Chip, GlassCard, MetaPill, SectionHeader } from '../ds/index.js';

const SOURCE_LABEL: Record<string, string> = {
  code: 'código',
  document: 'documentos',
  interview: 'entrevista',
};

function runDate(run: RunMeta): string {
  const iso = run.finished_at ?? run.started_at;
  if (iso === undefined) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function statsLine(run: RunMeta): string {
  const s = run.stats;
  return `+${s.nodes_created}/~${s.nodes_updated} nodos · +${s.edges_created}/~${s.edges_updated} aristas · +${s.evidence_added} evidencias`;
}

/**
 * Run history + batch import + remote sync: the graph-repo lifecycle that
 * previously required the terminal (`untacit import`, `git pull/push`).
 */
export function RunsView({
  onChanged,
  onGoToReview,
}: {
  onChanged: () => void;
  /** Jump to the review queue (after an import that produced proposals). */
  onGoToReview: () => void;
}) {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  const loadRuns = useCallback(() => {
    api
      .runs()
      .then((r: RunsResponse) => {
        setRuns(r.runs);
        setRunsError(null);
      })
      .catch((err: Error) => setRunsError(err.message));
  }, []);
  useEffect(loadRuns, [loadRuns]);

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="06"
          kicker="runs"
          title="Historial y datos del grafo"
          lead="Cada import es un run y un commit: aquí está el historial, la importación de batches de extracción y la sincronización con el remoto del equipo."
        />
        <SyncCard />
        <ImportCard
          onImported={() => {
            loadRuns();
            onChanged();
          }}
          onGoToReview={onGoToReview}
        />
        <section className="tray">
          <h3>Runs ({runs?.length ?? '…'})</h3>
          {runsError !== null && <div className="error-banner">{runsError}</div>}
          {runs !== null && runs.length === 0 && (
            <div className="empty">
              Sin runs todavía: importa un batch aquí o ejecuta una extracción con el CLI.
            </div>
          )}
          {runs?.map((run) => (
            <GlassCard key={run.id} pad="14px 20px" style={{ marginBottom: 10 }}>
              <div className="row">
                <span className="mono">{run.id}</span>
                <Chip size="sm" tone="neutral">
                  {SOURCE_LABEL[run.source_type] ?? run.source_type}
                </Chip>
                <MetaPill style={{ marginLeft: 'auto' }}>{runDate(run)}</MetaPill>
              </div>
              <div className="dim" style={{ marginTop: 6, fontSize: 12.5 }}>
                {statsLine(run)}
                {run.stats.merge_proposals > 0 && ` · ${run.stats.merge_proposals} propuestas de merge`}
                {(run.rejections?.length ?? 0) > 0 && ` · ${run.rejections!.length} rechazos`}
                {run.commit !== undefined && (
                  <span className="mono"> · commit {run.commit.slice(0, 10)}</span>
                )}
              </div>
            </GlassCard>
          ))}
        </section>
      </div>
    </div>
  );
}

/** Remote-sync card: branch/upstream, ahead/behind counters, pull & push. */
function SyncCard() {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'refresh' | 'pull' | 'push' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Local state first (instant), then refresh against the remote.
  useEffect(() => {
    api
      .gitStatus(false)
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const refresh = () => {
    setBusy('refresh');
    setMessage(null);
    api
      .gitStatus(true)
      .then((s) => {
        setStatus(s);
        setError(null);
        if (s.fetchError !== undefined) setMessage(`No se pudo consultar el remoto: ${s.fetchError}`);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const run = (op: 'pull' | 'push') => {
    setBusy(op);
    setMessage(null);
    (op === 'pull' ? api.gitPull() : api.gitPush())
      .then((r) => {
        setStatus(r.status);
        setError(null);
        setMessage(
          op === 'pull'
            ? `Al día con el remoto (HEAD ${r.head.slice(0, 10)}).`
            : `Cambios publicados (HEAD ${r.head.slice(0, 10)}).`,
        );
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  if (error !== null && status === null) {
    // Not a git repo (or sidecar down): the card explains instead of acting.
    return (
      <GlassCard pad="18px 22px" style={{ marginBottom: 18 }}>
        <h3 className="settings-title">Repositorio</h3>
        <p className="dim" style={{ fontSize: 13 }}>
          Sin estado git: {error}
        </p>
      </GlassCard>
    );
  }
  if (status === null) {
    return (
      <GlassCard pad="18px 22px" style={{ marginBottom: 18 }}>
        <h3 className="settings-title">Repositorio</h3>
        <p className="dim">Cargando estado…</p>
      </GlassCard>
    );
  }

  const noUpstream = status.upstream === null;
  return (
    <GlassCard pad="18px 22px" style={{ marginBottom: 18 }}>
      <h3 className="settings-title">Repositorio</h3>
      <div className="settings-status">
        <Chip size="sm" tone="neutral">
          rama {status.branch ?? '(detached)'}
        </Chip>
        {noUpstream ? (
          <Chip size="sm" tone="neutral">sin remoto configurado</Chip>
        ) : (
          <>
            <Chip size="sm" tone="neutral">{status.upstream}</Chip>
            <Chip size="sm" tone={status.ahead > 0 ? 'accent' : 'ok'}>
              ↑ {status.ahead} por publicar
            </Chip>
            <Chip size="sm" tone={status.behind > 0 ? 'conflict' : 'ok'}>
              ↓ {status.behind} por traer
            </Chip>
          </>
        )}
        {status.dirty && (
          <Chip size="sm" tone="conflict">cambios sin commit</Chip>
        )}
      </div>
      {!noUpstream && (
        <div className="row" style={{ marginTop: 12 }}>
          <Button size="sm" variant="glass" disabled={busy !== null} onClick={refresh}>
            {busy === 'refresh' ? 'Consultando…' : 'Consultar remoto'}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || status.behind === 0}
            title="git pull --ff-only: trae los commits del equipo sin crear merges"
            onClick={() => run('pull')}
          >
            {busy === 'pull' ? 'Trayendo…' : 'Traer cambios'}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || status.ahead === 0}
            title="git push: publica tus commits de revisión/entrevista"
            onClick={() => run('push')}
          >
            {busy === 'push' ? 'Publicando…' : 'Publicar cambios'}
          </Button>
        </div>
      )}
      {noUpstream && (
        <p className="dim" style={{ marginTop: 10, fontSize: 12.5 }}>
          El grafo vive solo en esta máquina. Para compartirlo, añade un remoto con{' '}
          <code className="mono">git remote add origin …</code> y vuelve aquí.
        </p>
      )}
      {message !== null && (
        <div className="dim mono" style={{ marginTop: 10, fontSize: 12 }}>✓ {message}</div>
      )}
      {error !== null && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
    </GlassCard>
  );
}

/** Batch import card: paste or pick a batch JSON, import, review the result. */
function ImportCard({
  onImported,
  onGoToReview,
}: {
  onImported: () => void;
  onGoToReview: () => void;
}) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = (file: File | undefined) => {
    if (file === undefined) return;
    file
      .text()
      .then((content) => {
        setText(content);
        setFileName(file.name);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  const doImport = () => {
    let batch: unknown;
    try {
      batch = JSON.parse(text);
    } catch {
      setError('El contenido no es JSON válido.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    api
      .importBatch(batch)
      .then((r) => {
        setResult(r);
        if (!r.noop) onImported();
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <GlassCard pad="18px 22px" style={{ marginBottom: 18 }}>
      <h3 className="settings-title">Importar batch de extracción</h3>
      <p className="dim" style={{ fontSize: 13, marginBottom: 10 }}>
        El JSON que produce <code className="mono">untacit extract code|docs --out batch.json</code>.
        Se valida (toda arista con evidencia), se resuelven entidades y se materializa como un run
        con su commit.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
      <div className="row" style={{ marginBottom: 8 }}>
        <Button size="sm" variant="glass" disabled={busy} onClick={() => fileRef.current?.click()}>
          Elegir fichero…
        </Button>
        {fileName !== null && <span className="dim mono" style={{ fontSize: 12 }}>{fileName}</span>}
      </div>
      <textarea
        className="import-textarea"
        rows={6}
        placeholder='{"run_id": "…", "source_type": "code", "nodes": […], "edges": […]}'
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setFileName(null);
        }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <Button size="sm" disabled={busy || text.trim() === ''} onClick={doImport}>
          {busy ? 'Importando…' : 'Importar'}
        </Button>
      </div>
      {error !== null && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
      {result !== null && (
        <div style={{ marginTop: 12 }}>
          {result.noop ? (
            <div className="dim mono" style={{ fontSize: 12 }}>
              ✓ run {result.runId}: sin cambios (re-import idéntico, idempotencia).
            </div>
          ) : (
            <div className="dim mono" style={{ fontSize: 12 }}>
              ✓ run {result.runId}: +{result.stats.nodes_created}/~{result.stats.nodes_updated} nodos,
              +{result.stats.edges_created}/~{result.stats.edges_updated} aristas,
              +{result.stats.evidence_added} evidencias
              {result.commit !== null && ` · commit ${result.commit.slice(0, 10)}`}
            </div>
          )}
          {result.rejections.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span className="dim" style={{ fontSize: 12.5 }}>
                {result.rejections.length} elementos rechazados por el validador:
              </span>
              <ul className="rejection-list">
                {result.rejections.slice(0, 10).map((issue, i) => (
                  <li key={i} className="mono">
                    {issue.path}: {issue.message}
                  </li>
                ))}
                {result.rejections.length > 10 && (
                  <li className="dim">… y {result.rejections.length - 10} más</li>
                )}
              </ul>
            </div>
          )}
          {result.proposals.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="dim" style={{ fontSize: 12.5 }}>
                {result.proposals.length} propuestas de merge pendientes.
              </span>
              <Button size="sm" variant="glass" onClick={onGoToReview}>
                Ir a Revisión
              </Button>
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}
