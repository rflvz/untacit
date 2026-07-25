import { useCallback, useEffect, useRef, useState } from 'react';

import { api, SidecarError } from '../api.js';
import type {
  ExtractJob,
  ExtractKind,
  ExtractPhase,
  ExtractPreviewResponse,
  ExtractSource,
  ExtractSourcesResponse,
  GitStatusResponse,
  ImportResponse,
  RunMeta,
  RunsResponse,
  ValidationIssue,
} from '../api-types.js';
import { Button, Chip, GlassCard, MetaPill, SectionHeader } from '../ds/index.js';
import { ModelPicker } from './ModelPicker.js';

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

  // Stable identity: ExtractCard polls its job from an effect keyed on this
  // callback, and a fresh arrow per render would restart the interval.
  const handleImported = useCallback(() => {
    loadRuns();
    onChanged();
  }, [loadRuns, onChanged]);

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="06"
          kicker="runs"
          title="Historial y datos del grafo"
          lead="Cada import es un run y un commit: aquí están el historial, la extracción desde las fuentes declaradas, la importación de batches y la sincronización con el remoto del equipo."
        />
        <SyncCard />
        <ExtractCard onImported={handleImported} onGoToReview={onGoToReview} />
        <ImportCard onImported={handleImported} onGoToReview={onGoToReview} />
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

// ---------------------------------------------------------------------------
// Extraction card: run `extract code` / `extract docs` over the declared
// sources without leaving the app (sidecar/extract.ts).
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<ExtractPhase, string> = {
  scanning: 'escaneando la fuente',
  extracting: 'llamadas al agente',
  importing: 'importando al grafo',
  done: 'terminado',
  error: 'error',
  cancelled: 'cancelado',
};

const ACTIVE_PHASES: readonly ExtractPhase[] = ['scanning', 'extracting', 'importing'];
const isActive = (phase: ExtractPhase): boolean => ACTIVE_PHASES.includes(phase);

/** Unique key for the source picker: kind and key are only unique together. */
const sourceKey = (source: Pick<ExtractSource, 'kind' | 'key'>): string =>
  `${source.kind}:${source.key}`;

function rejectionList(rejections: ValidationIssue[]) {
  return (
    <div style={{ marginTop: 8 }}>
      <span className="dim" style={{ fontSize: 12.5 }}>
        {rejections.length} elementos rechazados por el validador (falta evidencia, tipo fuera de
        la ontología…):
      </span>
      <ul className="rejection-list">
        {rejections.slice(0, 8).map((issue, i) => (
          <li key={i} className="mono">
            {issue.path}: {issue.message}
          </li>
        ))}
        {rejections.length > 8 && <li className="dim">… y {rejections.length - 8} más</li>}
      </ul>
    </div>
  );
}

/**
 * Extraction card: pick a declared source, preview what would be sent (no LLM
 * call), launch the agent and follow the job's phases. The engine is the local
 * `claude` CLI — when it is missing the card explains how to get it instead of
 * letting the launch fail raw.
 */
function ExtractCard({
  onImported,
  onGoToReview,
}: {
  onImported: () => void;
  onGoToReview: () => void;
}) {
  const [sources, setSources] = useState<ExtractSourcesResponse | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [maxCandidates, setMaxCandidates] = useState(50);
  const [chunkSize, setChunkSize] = useState(0); // 0 = the sidecar's default
  const [model, setModel] = useState('');
  const [onBranch, setOnBranch] = useState(false);
  const [preview, setPreview] = useState<ExtractPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'start' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ExtractJob | null>(null);

  const loadSources = useCallback(() => {
    api
      .extractSources()
      .then((s) => {
        setSources(s);
        setError(null);
        setSelected((current) => {
          if (current !== '' && s.sources.some((row) => sourceKey(row) === current)) return current;
          const first = s.sources.find((row) => row.exists) ?? s.sources[0];
          return first !== undefined ? sourceKey(first) : '';
        });
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  // Sources on mount, plus the sidecar's newest job: switching tabs unmounts
  // this card and must neither orphan a live extraction nor lose the result of
  // one that finished while we were away (jobs list is newest first).
  useEffect(() => {
    loadSources();
    api
      .extractJobs()
      .then((r) => {
        const running =
          r.jobs.find((j) => j.id === r.runningJobId) ?? r.jobs.find((j) => isActive(j.phase));
        setJob(running ?? r.jobs[0] ?? null);
      })
      .catch(() => {
        /* the sources error above already covers a sidecar that is not up */
      });
  }, [loadSources]);

  // Poll while the job runs. The sidecar also streams the same snapshots over
  // SSE (GET /api/extract/:id/events); polling keeps the client trivial and
  // survives a dropped connection.
  const jobId = job?.id;
  const jobPhase = job?.phase;
  useEffect(() => {
    if (jobId === undefined || jobPhase === undefined || !isActive(jobPhase)) return;
    // One request at a time, and the terminal transition handled once: the
    // interval does not wait for its own response, so without these two guards
    // a slow sidecar would stack requests and fire onImported repeatedly.
    let inFlight = false;
    let settled = false;
    const timer = setInterval(() => {
      if (inFlight || settled) return;
      inFlight = true;
      api
        .extractJob(jobId)
        .then((next) => {
          setJob(next);
          if (!isActive(next.phase)) {
            settled = true;
            // A run landed: refresh the history/stats and unlock the launcher.
            if (next.result !== undefined && !next.result.noop) onImported();
            loadSources();
          }
        })
        .catch((err: SidecarError | Error) => {
          setError(err.message);
          // The sidecar no longer knows this job (swept, or restarted): stop
          // following it, or the launcher stays disabled forever behind a job
          // that can never reach a terminal phase.
          if (err instanceof SidecarError && err.status === 404) {
            settled = true;
            setJob(null);
            loadSources();
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, 900);
    return () => clearInterval(timer);
  }, [jobId, jobPhase, onImported, loadSources]);

  const current = sources?.sources.find((row) => sourceKey(row) === selected);
  const kind: ExtractKind = current?.kind ?? 'code';
  const running = job !== null && isActive(job.phase);
  const disabled = busy !== null || running;

  const requestBase = () => ({
    kind,
    source: current!.key,
    ...(chunkSize > 0 ? { chunkSize } : {}),
    ...(kind === 'code' ? { maxCandidates } : {}),
  });

  const runPreview = () => {
    if (current === undefined) return;
    setBusy('preview');
    setError(null);
    setPreview(null);
    api
      .extractPreview(requestBase())
      .then(setPreview)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const start = () => {
    if (current === undefined) return;
    setBusy('start');
    setError(null);
    api
      .extractStart({
        ...requestBase(),
        ...(model.trim() !== '' ? { model: model.trim() } : {}),
        ...(onBranch ? { branch: true } : {}),
      })
      .then((r) => setJob(r.job))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  const cancel = () => {
    if (job === null) return;
    setBusy('cancel');
    api
      .extractCancel(job.id)
      .then(setJob)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  return (
    <GlassCard pad="18px 22px" style={{ marginBottom: 18 }}>
      <h3 className="settings-title">Extraer del código y los documentos</h3>
      <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
        Lo que hace <code className="mono">untacit extract code|docs --import</code>: se localizan
        los candidatos (o se segmentan los documentos), el agente emite nodos y aristas{' '}
        <b>con evidencia obligatoria</b>, y el batch se importa como un run con su commit. El motor
        es el <b>Claude Code</b> local, con la sesión que ya tengas — sin claves de API.
      </p>

      {sources !== null && sources.sources.length === 0 && (
        <div className="empty">
          No hay fuentes declaradas. Añádelas en <b>Ajustes → Fuentes</b> (repos de código y
          carpetas de documentos) y vuelve aquí.
        </div>
      )}

      {sources !== null && sources.sources.length > 0 && (
        <>
          <div className="extract-form">
            <label htmlFor="extract-source">
              fuente
              <select
                id="extract-source"
                value={selected}
                disabled={disabled}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPreview(null);
                }}
              >
                <optgroup label="código">
                  {sources.sources
                    .filter((row) => row.kind === 'code')
                    .map((row) => (
                      <option key={sourceKey(row)} value={sourceKey(row)}>
                        {row.label}
                        {row.exists ? '' : ' (ruta no encontrada)'}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="documentos">
                  {sources.sources
                    .filter((row) => row.kind === 'docs')
                    .map((row) => (
                      <option key={sourceKey(row)} value={sourceKey(row)}>
                        {row.label}
                        {row.exists
                          ? row.documentCount !== undefined
                            ? ` (${row.documentCount} documentos)`
                            : ''
                          : ' (ruta no encontrada)'}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>

            {kind === 'code' && (
              <label htmlFor="extract-max">
                máx. candidatos
                <input
                  id="extract-max"
                  type="number"
                  min={1}
                  max={500}
                  value={maxCandidates}
                  disabled={disabled}
                  onChange={(e) => setMaxCandidates(Number(e.target.value) || 1)}
                />
              </label>
            )}

            <label htmlFor="extract-chunk">
              {kind === 'code' ? 'candidatos/llamada' : 'secciones/llamada'}
              <input
                id="extract-chunk"
                type="number"
                min={0}
                max={64}
                value={chunkSize}
                disabled={disabled}
                title="0 = el valor por defecto (8 candidatos / 4 secciones por llamada)"
                onChange={(e) => setChunkSize(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>

            <ModelPicker
              id="extract-model"
              value={model}
              disabled={disabled}
              onChange={setModel}
            />

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={onBranch}
                disabled={disabled}
                onChange={(e) => setOnBranch(e.target.checked)}
              />
              commit en una rama (<code className="mono">run/&lt;run_id&gt;</code>)
            </label>
          </div>

          {current !== undefined && (
            <p className="dim mono" style={{ fontSize: 11.5, marginTop: -4, marginBottom: 10 }}>
              {current.resolvedPath}
            </p>
          )}

          {!sources.llmReady && (
            <div className="error-banner" style={{ marginBottom: 10 }}>
              El motor de extracción es el <b>Claude Code</b> local y no está disponible:{' '}
              {sources.llmDetail}
              <br />
              Instálalo desde{' '}
              <code className="mono">https://claude.com/claude-code</code>, o apunta{' '}
              <code className="mono">UNTACIT_CLAUDE_BIN</code> al binario si está fuera del PATH.
              Mientras tanto puedes usar la vista previa (no gasta LLM), importar un batch generado
              en otra máquina, o extraer desde Claude Code/Claude Desktop vía el servidor MCP.
            </div>
          )}

          <div className="row">
            <Button
              size="sm"
              variant="glass"
              disabled={disabled || current === undefined || !current.exists}
              title="Candidatos o secciones que se enviarían, sin gastar ninguna llamada al agente"
              onClick={runPreview}
            >
              {busy === 'preview' ? 'Analizando…' : 'Vista previa (sin LLM)'}
            </Button>
            <Button
              size="sm"
              disabled={
                disabled || current === undefined || !current.exists || !sources.llmReady
              }
              onClick={start}
            >
              {busy === 'start' ? 'Lanzando…' : 'Extraer e importar'}
            </Button>
            {running && (
              <Button
                size="sm"
                variant="glass"
                disabled={busy === 'cancel' || job.cancelRequested}
                title="Se aborta antes de la siguiente llamada al agente; la extracción parcial se descarta"
                onClick={cancel}
              >
                {job.cancelRequested ? 'Cancelando…' : 'Cancelar'}
              </Button>
            )}
          </div>

          {error !== null && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
          {preview !== null && <PreviewPanel preview={preview} />}
          {job !== null && <JobPanel job={job} onGoToReview={onGoToReview} />}
        </>
      )}
    </GlassCard>
  );
}

/** What an extraction would send to the agent: candidates or sections. */
function PreviewPanel({ preview }: { preview: ExtractPreviewResponse }) {
  const units = preview.candidates?.length ?? preview.sections?.length ?? 0;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="dim" style={{ fontSize: 12.5 }}>
        {preview.kind === 'code'
          ? `${units} candidatos en ${preview.files.length} ficheros`
          : `${units} secciones en ${preview.files.length} documentos`}{' '}
        → <b>{preview.plannedCalls}</b> llamada{preview.plannedCalls === 1 ? '' : 's'} al agente (de{' '}
        {preview.chunkSize} en {preview.chunkSize}).
      </div>
      {preview.skipped !== undefined && (
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          {preview.skipped.length} fichero(s) sin poder leer:{' '}
          <span className="mono">{preview.skipped.map((s) => s.path).join(', ')}</span>
        </div>
      )}
      {units > 0 && (
        <div className="extract-preview">
          {preview.candidates?.map((candidate, i) => (
            <div key={i} className="extract-preview-item">
              <span className="mono">
                {candidate.path}:{candidate.line_start}-{candidate.line_end}
              </span>{' '}
              <span className="dim" style={{ fontSize: 11 }}>
                {candidate.signals.join(' · ')}
              </span>
              <span className="snippet">{candidate.snippet.slice(0, 240)}</span>
            </div>
          ))}
          {preview.sections?.map((section, i) => (
            <div key={i} className="extract-preview-item">
              <span className="mono">
                {section.doc_id} § {section.section}
                {section.page !== undefined && ` (p. ${section.page})`}
              </span>{' '}
              <span className="dim" style={{ fontSize: 11 }}>
                {section.title}
              </span>
              <span className="snippet">{section.text.slice(0, 200)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Live phases + progress bar, then the run the job produced. */
function JobPanel({ job, onGoToReview }: { job: ExtractJob; onGoToReview: () => void }) {
  const pct =
    job.plannedCalls > 0 ? Math.min(100, Math.round((job.llmCalls / job.plannedCalls) * 100)) : 0;
  const indeterminate = isActive(job.phase) && job.plannedCalls === 0;
  const result = job.result;

  return (
    <div className="extract-progress">
      <div className="extract-phases">
        <Chip size="sm" tone={job.phase === 'error' ? 'conflict' : isActive(job.phase) ? 'accent' : 'ok'}>
          {PHASE_LABEL[job.phase]}
        </Chip>
        {job.units > 0 && (
          <Chip size="sm" tone="neutral">
            {job.units} {job.kind === 'code' ? 'candidatos' : 'secciones'}
          </Chip>
        )}
        {job.plannedCalls > 0 && (
          <Chip size="sm" tone="neutral">
            {job.llmCalls}/{job.plannedCalls} llamadas
          </Chip>
        )}
        <Chip size="sm" tone="neutral">
          modelo {job.model}
        </Chip>
      </div>
      {isActive(job.phase) && (
        <div className={`extract-bar${indeterminate ? ' indeterminate' : ''}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="dim" style={{ marginTop: 8, fontSize: 12.5 }}>
        {job.message}
      </div>
      {job.error !== undefined && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {job.error}
          {job.batchAvailable && (
            <>
              {' '}
              El batch extraído no se ha perdido:{' '}
              <a className="mono" href={api.extractBatchUrl(job.id)} target="_blank" rel="noreferrer">
                descargarlo
              </a>{' '}
              e importarlo abajo cuando arregles el problema
              {job.rescuePath !== undefined && (
                <>
                  {' '}
                  (también está guardado en <code className="mono">{job.rescuePath}</code>)
                </>
              )}
              .
            </>
          )}
        </div>
      )}
      {job.skipped !== undefined && (
        <div className="dim" style={{ marginTop: 6, fontSize: 12 }}>
          {job.skipped.length} documento(s) ilegibles:{' '}
          <span className="mono">{job.skipped.map((s) => s.path).join(', ')}</span>
        </div>
      )}
      {job.rejections.length > 0 && rejectionList(job.rejections)}
      {result !== undefined && (
        <div style={{ marginTop: 10 }}>
          {result.noop ? (
            <div className="dim mono" style={{ fontSize: 12 }}>
              ✓ run {result.runId}: sin cambios (la extracción no aportó nada nuevo).
            </div>
          ) : (
            <div className="dim mono" style={{ fontSize: 12 }}>
              ✓ run {result.runId}: +{result.stats.nodes_created}/~{result.stats.nodes_updated}{' '}
              nodos, +{result.stats.edges_created}/~{result.stats.edges_updated} aristas, +
              {result.stats.evidence_added} evidencias
              {result.commit !== null && ` · commit ${result.commit.slice(0, 10)}`}
              {result.branch !== null && ` · rama ${result.branch}`}
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
    </div>
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
