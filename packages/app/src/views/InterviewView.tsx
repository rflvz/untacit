/**
 * Interview view (Fase 4, docs/03 §4.3 + §7 point 4): chat with the
 * interviewer agent + side panel of live proposals. Every statement the
 * interviewee makes shows up as a triple to accept / edit / reject (bulk
 * accept with exceptions supported); existing low-confidence edges appear as
 * claims to confirm or refute. Finish imports the batch: accepted triples
 * enter with confidence 0.95 and validated_by = role — never a name.
 */

import { useEffect, useRef, useState } from 'react';

import { api, SidecarError } from '../api.js';
import type {
  EdgeType,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposal,
  InterviewStateResponse,
  NodeType,
} from '../api-types.js';
import { Button, Chip, GlassCard, SectionHeader, type ChipTone } from '../ds/index.js';
import { EDGE_TYPES, NODE_TYPES } from '../ontology.js';

/**
 * Sessions live in the sidecar's memory; the view keeps only the id — in
 * sessionStorage, so switching tabs (which unmounts this component) or
 * reloading resumes the live interview instead of orphaning it.
 */
const SESSION_STORAGE_KEY = 'untacit-interview-id';

export function InterviewView({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<InterviewStateResponse | null>(null);
  const [summary, setSummary] = useState<InterviewFinishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True while an answer is in flight — blocks finish/actions mid-turn. */
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const storedId = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (storedId === null) return;
    api
      .interviewGet(storedId)
      .then((result) => setState(result.state))
      .catch(() => sessionStorage.removeItem(SESSION_STORAGE_KEY));
  }, []);

  if (summary !== null) {
    return (
      <FinishSummary
        summary={summary}
        onRestart={() => {
          setSummary(null);
          setState(null);
        }}
      />
    );
  }
  if (state === null) {
    return (
      <StartScreen
        onStarted={(s) => {
          sessionStorage.setItem(SESSION_STORAGE_KEY, s.interviewId);
          setState(s);
        }}
      />
    );
  }
  return (
    <div className="interview-layout">
      {error && <div className="error-banner">{error}</div>}
      <Chat state={state} onState={setState} onError={setError} waiting={waiting} setWaiting={setWaiting} />
      <ProposalPanel
        state={state}
        onState={setState}
        onError={setError}
        waiting={waiting}
        onFinished={(result) => {
          sessionStorage.removeItem(SESSION_STORAGE_KEY);
          setSummary(result);
          onChanged();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start screen: role + gap preview
// ---------------------------------------------------------------------------

function StartScreen({ onStarted }: { onStarted: (s: InterviewStateResponse) => void }) {
  const [gaps, setGaps] = useState<InterviewGapsResponse | null>(null);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.interviewGaps().then(setGaps).catch((err: Error) => setError(err.message));
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.interviewStart(role.trim());
      onStarted(result.state);
    } catch (err) {
      setError(err instanceof SidecarError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="04"
          kicker="entrevista"
          title="Entrevista agéntica"
          lead="El agente consulta el grafo, detecta zonas de baja cobertura y pregunta a quien de verdad sabe cómo funciona la empresa."
        />
        <GlassCard pad="26px 28px" style={{ maxWidth: 680, marginBottom: 20 }}>
          <p style={{ margin: '0 0 14px', color: 'var(--text-body-card)', fontSize: 14, lineHeight: 'var(--leading-card)' }}>
            El agente consulta el grafo, detecta zonas de baja cobertura o confianza y genera un
            guion de preguntas concretas. Cada afirmación tuya aparece como un triple que puedes{' '}
            <b style={{ color: 'var(--text-heading-card)' }}>aceptar, corregir o rechazar</b> en
            vivo; lo aceptado entra con confianza 0.95 y tu{' '}
            <b style={{ color: 'var(--text-heading-card)' }}>rol</b> como{' '}
            <code className="mono" style={{ color: 'var(--cyan-bright)' }}>validated_by</code> —
            nunca tu nombre, y la transcripción no se guarda.
          </p>
          <label className="dim" htmlFor="interview-role" style={{ fontSize: 13 }}>
            Rol de la persona entrevistada (p. ej. «administración», «producción»)
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              id="interview-role"
              type="text"
              placeholder="rol, nunca un nombre"
              value={role}
              style={{ flex: 1, minWidth: 220 }}
              onChange={(e) => setRole(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && role.trim() !== '' && !busy && gaps?.llmReady !== false) {
                  void start();
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || role.trim() === '' || gaps?.llmReady === false}
              onClick={() => void start()}
            >
              {busy ? 'Preparando guion…' : 'Comenzar'}
            </Button>
          </div>
          {gaps?.llmReady === false && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger-light)' }}>
              LLM no disponible: {gaps.llmDetail}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger-light)' }}>{error}</div>
          )}
        </GlassCard>

        {gaps && gaps.gaps.length > 0 && (
          <GlassCard pad="22px 28px" style={{ maxWidth: 680 }}>
            <h3
              style={{
                margin: '0 0 12px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: 'var(--tracking-label)',
                color: 'var(--text-muted)',
              }}
            >
              Huecos del grafo que motivarán las preguntas ({gaps.gaps.length})
            </h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: 'var(--text-body-card)' }}>
              {gaps.gaps.map((g, i) => (
                <li key={i} style={{ padding: '3px 0' }}>
                  <Chip size="sm" style={{ marginRight: 6 }}>{g.kind}</Chip> {g.detail}
                </li>
              ))}
            </ul>
            {gaps.verifications.length > 0 && (
              <div className="dim" style={{ marginTop: 10, fontSize: 13 }}>
                Además, {gaps.verifications.length} afirmación
                {gaps.verifications.length === 1 ? '' : 'es'} de baja confianza para confirmar o
                refutar durante la sesión.
              </div>
            )}
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function Chat({
  state,
  onState,
  onError,
  waiting,
  setWaiting,
}: {
  state: InterviewStateResponse;
  onState: (s: InterviewStateResponse) => void;
  onError: (message: string | null) => void;
  waiting: boolean;
  setWaiting: (w: boolean) => void;
}) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.transcript.length, waiting]);

  const send = async () => {
    const text = input.trim();
    if (text === '' || waiting) return;
    setInput('');
    setWaiting(true);
    onError(null);
    // Optimistic render of the interviewee turn while the agent thinks.
    onState({
      ...state,
      transcript: [...state.transcript, { speaker: 'interviewee', text }],
    });
    try {
      const result = await api.interviewAnswer(state.interviewId, text);
      onState(result.state);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      const refreshed = await api.interviewGet(state.interviewId).catch(() => null);
      if (refreshed) onState(refreshed.state);
    } finally {
      setWaiting(false);
    }
  };

  return (
    <div className="interview-chat">
      <div className="chat-messages" ref={scrollRef}>
        {state.transcript.map((turn, i) => (
          <div key={i} className={`chat-bubble ${turn.speaker}`}>
            <div className="chat-speaker">
              {turn.speaker === 'agent' ? 'entrevistador' : state.speakerRole}
            </div>
            {turn.text}
          </div>
        ))}
        {waiting && <div className="chat-bubble agent dim">…</div>}
      </div>
      <div className="chat-input">
        <input
          type="text"
          placeholder={waiting ? 'El agente está pensando…' : 'Tu respuesta'}
          value={input}
          disabled={waiting}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <button disabled={waiting || input.trim() === ''} onClick={() => void send()}>
          Enviar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposal panel: verifications + triples with accept / edit / reject
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<InterviewProposal['status'], string> = {
  proposed: 'pendiente',
  accepted: 'aceptado',
  rejected: 'rechazado',
  confirmed: 'confirmado',
  refuted: 'refutado',
  skipped: 'saltado',
};

/** Teal = validado, ámbar solo para lo refutado (acaba en conflicto). */
const STATUS_TONES: Record<InterviewProposal['status'], ChipTone> = {
  proposed: 'neutral',
  accepted: 'ok',
  rejected: 'neutral',
  confirmed: 'ok',
  refuted: 'conflict',
  skipped: 'neutral',
};

function StatusChip({ status }: { status: InterviewProposal['status'] }) {
  return (
    <Chip size="sm" tone={STATUS_TONES[status]}>
      {STATUS_LABELS[status]}
    </Chip>
  );
}

function ProposalPanel({
  state,
  onState,
  onError,
  waiting,
  onFinished,
}: {
  state: InterviewStateResponse;
  onState: (s: InterviewStateResponse) => void;
  onError: (message: string | null) => void;
  /** An answer is in flight: block finish/actions until its proposals land. */
  waiting: boolean;
  onFinished: (result: InterviewFinishResponse) => void;
}) {
  const [acting, setActing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const busy = acting || waiting;

  const verifications = state.proposals.filter((p) => p.kind === 'verification');
  const triples = state.proposals.filter((p) => p.kind !== 'verification');
  const pending = triples.filter((p) => p.status === 'proposed').length;
  const accepted = triples.filter((p) => p.status === 'accepted').length;
  const resolved = verifications.filter(
    (p) => p.status === 'confirmed' || p.status === 'refuted',
  ).length;

  /** Swap one proposal in place — the POST response already carries it. */
  const patchProposal = (proposal: InterviewProposal) => {
    onState({
      ...state,
      proposals: state.proposals.map((p) => (p.id === proposal.id ? proposal : p)),
    });
  };

  const act = async (
    proposalId: string,
    action: 'accept' | 'reject' | 'confirm' | 'refute' | 'skip',
  ) => {
    setActing(true);
    onError(null);
    try {
      const result = await api.interviewProposal(state.interviewId, proposalId, action);
      patchProposal(result.proposal);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const acceptAllPending = async () => {
    setActing(true);
    onError(null);
    try {
      const result = await api.interviewAcceptAll(state.interviewId);
      onState(result.state);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const finish = async () => {
    setActing(true);
    onError(null);
    try {
      const result = await api.interviewFinish(state.interviewId);
      onFinished(result);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="interview-panel">
      {verifications.length > 0 && (
        <>
          <h3>Verificación cruzada ({resolved}/{verifications.length})</h3>
          {verifications.map((p) => (
            <div key={p.id} className={`proposal-card ${p.status}`}>
              <div className="statement">{p.statement}</div>
              <div className="dim" style={{ margin: '6px 0' }}>
                confianza actual {p.verification?.confidence} · <StatusChip status={p.status} />
              </div>
              {p.status === 'proposed' && (
                <div className="row">
                  <button className="accept" disabled={busy} onClick={() => void act(p.id, 'confirm')}>
                    Confirmar
                  </button>
                  <button className="reject" disabled={busy} onClick={() => void act(p.id, 'refute')}>
                    Refutar
                  </button>
                  <button disabled={busy} onClick={() => void act(p.id, 'skip')}>
                    No lo sé
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <h3>
        Triples propuestos ({accepted} aceptados · {pending} pendientes)
      </h3>
      {triples.length === 0 && (
        <div className="empty">Aún nada: responde en el chat y las afirmaciones aparecerán aquí.</div>
      )}
      {triples.map((p) => (
        <div key={p.id} className={`proposal-card ${p.status}`}>
          <div className="statement">{p.statement}</div>
          <div className="dim" style={{ margin: '6px 0' }}>
            {p.kind === 'node' ? 'nodo' : 'arista'} · turno {p.turn} ·{' '}
            <StatusChip status={p.status} />
          </div>
          {editing === p.id ? (
            <EditForm
              proposal={p}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={async (patch) => {
                setActing(true);
                onError(null);
                try {
                  const result = await api.interviewProposal(state.interviewId, p.id, 'edit', patch);
                  setEditing(null);
                  // A rename can retouch edge statements too — refetch once.
                  if (patch.name !== undefined && p.kind === 'node') {
                    const refreshed = await api.interviewGet(state.interviewId).catch(() => null);
                    if (refreshed) onState(refreshed.state);
                    else patchProposal(result.proposal);
                  } else {
                    patchProposal(result.proposal);
                  }
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err));
                } finally {
                  setActing(false);
                }
              }}
            />
          ) : (
            p.status !== 'accepted' && (
              <div className="row">
                <button className="accept" disabled={busy} onClick={() => void act(p.id, 'accept')}>
                  Aceptar
                </button>
                <button disabled={busy} onClick={() => setEditing(p.id)}>
                  Corregir
                </button>
                {p.status !== 'rejected' && (
                  <button className="reject" disabled={busy} onClick={() => void act(p.id, 'reject')}>
                    Rechazar
                  </button>
                )}
              </div>
            )
          )}
        </div>
      ))}

      <div className="interview-actions">
        <button disabled={busy || pending === 0} onClick={() => void acceptAllPending()}>
          Aceptar los {pending} pendientes
        </button>
        <button className="accept" disabled={busy} onClick={() => void finish()}>
          Terminar y guardar
        </button>
      </div>
      <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
        Al terminar, lo aceptado se importa como run de entrevista (un commit) con confianza 0.95 y
        rol «{state.speakerRole}».
      </div>
    </div>
  );
}

function EditForm({
  proposal,
  busy,
  onSave,
  onCancel,
}: {
  proposal: InterviewProposal;
  busy: boolean;
  onSave: (patch: { name?: string; description?: string; type?: NodeType; edgeType?: EdgeType }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(proposal.node?.name ?? '');
  const [description, setDescription] = useState(proposal.node?.description ?? '');
  const [type, setType] = useState<NodeType>(proposal.node?.type ?? 'entity');
  const [edgeType, setEdgeType] = useState<EdgeType>(proposal.edge?.type ?? 'DEPENDS_ON');

  return (
    <div className="edit-form">
      {proposal.kind === 'node' ? (
        <>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="nombre" />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="descripción"
          />
          <select value={type} onChange={(e) => setType(e.target.value as NodeType)}>
            {NODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </>
      ) : (
        <select value={edgeType} onChange={(e) => setEdgeType(e.target.value as EdgeType)}>
          {EDGE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      <div className="row">
        <button
          className="accept"
          disabled={busy}
          onClick={() =>
            void onSave(proposal.kind === 'node' ? { name, description, type } : { edgeType })
          }
        >
          Guardar corrección
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finish summary
// ---------------------------------------------------------------------------

function FinishSummary({
  summary,
  onRestart,
}: {
  summary: InterviewFinishResponse;
  onRestart: () => void;
}) {
  const s = summary.stats;
  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader number="04" kicker="entrevista" title="Entrevista guardada" />
        <GlassCard pad="26px 28px" style={{ maxWidth: 640 }}>
          {summary.noop ? (
            <p style={{ margin: 0, color: 'var(--text-body-card)' }}>
              La sesión no produjo cambios en el grafo (nada aceptado).
            </p>
          ) : (
            <>
              <p style={{ margin: '0 0 10px', color: 'var(--text-body-card)' }}>
                ✓ Run <code className="mono" style={{ color: 'var(--cyan-bright)' }}>{summary.runId}</code>
                {summary.commit ? (
                  <>
                    {' '}
                    · commit{' '}
                    <code className="mono" style={{ color: 'var(--cyan-bright)' }}>
                      {summary.commit.slice(0, 10)}
                    </code>
                  </>
                ) : null}
              </p>
              <p style={{ margin: '0 0 10px', color: 'var(--text-body-card)' }}>
                <b style={{ color: 'var(--text-heading-card)' }}>{s.nodes_created}</b> nodos nuevos ·{' '}
                <b style={{ color: 'var(--text-heading-card)' }}>{s.nodes_updated}</b> actualizados ·{' '}
                <b style={{ color: 'var(--text-heading-card)' }}>{s.edges_created}</b> aristas nuevas ·{' '}
                <b style={{ color: 'var(--text-heading-card)' }}>{s.edges_updated}</b> actualizadas ·{' '}
                <b style={{ color: 'var(--text-heading-card)' }}>{s.evidence_added}</b> evidencias
              </p>
              <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                {summary.acceptedProposals} triples validados en vivo · {summary.verificationsResolved}{' '}
                verificaciones cruzadas resueltas
                {s.merge_proposals > 0 ? ` · ${s.merge_proposals} propuestas de merge en la cola` : ''}
              </p>
            </>
          )}
          {summary.rejections.length > 0 && (
            <div className="dim" style={{ marginTop: 10, fontSize: 13 }}>
              {summary.rejections.length} elementos rechazados por el validador (ver run para
              detalles).
            </div>
          )}
          <div className="row" style={{ marginTop: 16 }}>
            <Button size="sm" onClick={onRestart}>
              Nueva entrevista
            </Button>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
