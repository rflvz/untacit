import { useEffect, useMemo, useState } from 'react';

import { api } from '../api.js';
import type {
  EmbeddingsConfig,
  RetrievalConfig,
  RetrievalTestResponse,
  SettingsResponse,
} from '../api-types.js';
import { Button, Chip, GlassCard, NodeDot, SectionHeader } from '../ds/index.js';
import { NODE_TYPE_COLORS } from '../ontology.js';

// ---------------------------------------------------------------------------
// Editable draft shape: every knob materialized with its default, so the
// form is fully controlled; collapsed back into RetrievalConfig on save.
// ---------------------------------------------------------------------------

type ChannelKey = 'lexical' | 'lexical_prf' | 'semantic' | 'semantic_multivec';

interface ChannelDraft {
  enabled: boolean;
  weight: number;
}

interface Draft {
  provider: EmbeddingsConfig['provider'];
  model: string;
  mode: 'auto' | 'manual';
  channels: Record<ChannelKey, ChannelDraft>;
  feedbackDocs: number;
  expansionTerms: number;
  depth: number;
  decay: number;
  fanoutPenalty: number;
  restart: number;
  activationBlend: number;
  mmrLambda: number;
}

const CHANNEL_META: {
  key: ChannelKey;
  label: string;
  desc: string;
  defaultWeight: number;
  semantic: boolean;
}[] = [
  {
    key: 'lexical',
    label: 'Léxico — BM25F',
    desc: 'FTS5 con pesos por campo (nombre > alias > descripción). La base exacta.',
    defaultWeight: 1.0,
    semantic: false,
  },
  {
    key: 'lexical_prf',
    label: 'Expansión PRF — RM3',
    desc: 'Reformula la consulta con términos minados de los primeros resultados. Recall: encuentra "pago anticipado" preguntando por "prepago".',
    defaultWeight: 0.5,
    semantic: false,
  },
  {
    key: 'semantic',
    label: 'Semántico — k-NN de embeddings',
    desc: 'Vecinos por coseno sobre el vector del nodo (modelo multilingüe local). Cruza idiomas y sinónimos.',
    defaultWeight: 0.9,
    semantic: true,
  },
  {
    key: 'semantic_multivec',
    label: 'Semántico multivector — MaxSim',
    desc: 'Late interaction por facetas (estilo ColBERT): un vector por frase de la descripción. Precisión.',
    defaultWeight: 1.0,
    semantic: true,
  },
];

const PROVIDER_META: { key: EmbeddingsConfig['provider']; label: string; desc: string }[] = [
  {
    key: 'auto',
    label: 'Auto (recomendado)',
    desc: 'Usa el modelo multilingüe local si transformers.js está disponible; si no, desactiva el canal semántico.',
  },
  {
    key: 'transformers',
    label: 'Modelo local (transformers.js)',
    desc: 'Fuerza el modelo multilingüe. Falla con un error claro si el paquete no está instalado.',
  },
  {
    key: 'hash',
    label: 'Hash (offline, determinista)',
    desc: 'Trigramas de caracteres — sin modelo. Solo para demos y tests; no entiende significado.',
  },
  { key: 'none', label: 'Ninguno', desc: 'Desactiva los embeddings y los dos canales semánticos.' },
];

function toDraft(s: SettingsResponse): Draft {
  const r = s.config.retrieval;
  const ch = (key: ChannelKey, defaultWeight: number): ChannelDraft => ({
    enabled: r?.channels?.[key]?.enabled !== false,
    weight: r?.channels?.[key]?.weight ?? defaultWeight,
  });
  return {
    provider: s.config.embeddings?.provider ?? 'auto',
    model: s.config.embeddings?.model ?? '',
    mode: r?.mode ?? 'manual',
    channels: {
      lexical: ch('lexical', 1.0),
      lexical_prf: ch('lexical_prf', 0.5),
      semantic: ch('semantic', 0.9),
      semantic_multivec: ch('semantic_multivec', 1.0),
    },
    feedbackDocs: r?.channels?.lexical_prf?.feedback_docs ?? 8,
    expansionTerms: r?.channels?.lexical_prf?.expansion_terms ?? 5,
    depth: r?.expansion?.depth ?? 2,
    decay: r?.expansion?.decay ?? 0.6,
    fanoutPenalty: r?.expansion?.fanout_penalty ?? 0.3,
    restart: r?.expansion?.restart ?? 0.15,
    activationBlend: r?.expansion?.activation_blend ?? 0.65,
    mmrLambda: r?.mmr_lambda ?? 0.7,
  };
}

function draftToRetrieval(d: Draft): RetrievalConfig {
  return {
    mode: d.mode,
    channels: {
      lexical: { enabled: d.channels.lexical.enabled, weight: d.channels.lexical.weight },
      lexical_prf: {
        enabled: d.channels.lexical_prf.enabled,
        weight: d.channels.lexical_prf.weight,
        feedback_docs: d.feedbackDocs,
        expansion_terms: d.expansionTerms,
      },
      semantic: { enabled: d.channels.semantic.enabled, weight: d.channels.semantic.weight },
      semantic_multivec: {
        enabled: d.channels.semantic_multivec.enabled,
        weight: d.channels.semantic_multivec.weight,
      },
    },
    expansion: {
      depth: d.depth,
      decay: d.decay,
      fanout_penalty: d.fanoutPenalty,
      restart: d.restart,
      activation_blend: d.activationBlend,
    },
    mmr_lambda: d.mmrLambda,
  };
}

function draftToEmbeddings(d: Draft): EmbeddingsConfig {
  const out: EmbeddingsConfig = { provider: d.provider };
  if (d.model.trim() !== '') out.model = d.model.trim();
  return out;
}

/** Slider + numeric readout for a bounded parameter. */
function ParamSlider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="param-slider" title={hint}>
      <span className="param-label">
        {label}
        <span className="mono param-value">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="param-hint">{hint}</span>
    </label>
  );
}

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCommit, setSavedCommit] = useState<string | null>(null);

  const [testQuery, setTestQuery] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RetrievalTestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        const d = toDraft(s);
        setDraft(d);
        setSaved(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  if (error !== null && draft === null) {
    return (
      <div className="page">
        <div className="page-inner">
          <div className="error-banner">{error}</div>
        </div>
      </div>
    );
  }
  if (draft === null || settings === null) {
    return (
      <div className="page">
        <div className="page-inner dim">Cargando ajustes…</div>
      </div>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setChannel = (key: ChannelKey, patch: Partial<ChannelDraft>) =>
    setDraft({
      ...draft,
      channels: { ...draft.channels, [key]: { ...draft.channels[key], ...patch } },
    });

  const providerOff = draft.provider === 'none';
  const auto = draft.mode === 'auto';

  const save = () => {
    setSaving(true);
    api
      .saveSettings({ embeddings: draftToEmbeddings(draft), retrieval: draftToRetrieval(draft) })
      .then((res) => {
        setSaved(draft);
        setSavedCommit(res.commit);
        setError(null);
        // El provider del sidecar se recarga en la próxima consulta.
        api.settings().then(setSettings).catch(() => {});
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  const runTest = () => {
    if (testQuery.trim().length < 2) return;
    setTesting(true);
    setTestError(null);
    api
      .retrievalTest(testQuery, draftToRetrieval(draft))
      .then((r) => setTest(r))
      .catch((err: Error) => {
        setTest(null);
        setTestError(err.message);
      })
      .finally(() => setTesting(false));
  };

  const emb = settings.embeddings;

  return (
    <div className="page">
      <div className="page-inner">
        <SectionHeader
          number="05"
          kicker="ajustes"
          title="Retrieval y modelo semántico"
          lead="Configura cómo se busca en el grafo: qué canales de recuperación se usan y con qué peso, cómo se expande por la estructura, y qué modelo de embeddings da soporte multilingüe. O deja que el agente lo decida por consulta."
        />

        {error !== null && <div className="error-banner" style={{ margin: '0 0 16px' }}>{error}</div>}

        {/* ------------------------------------------------ Embeddings */}
        <GlassCard style={{ marginBottom: 18 }} pad="26px 28px">
          <h3 className="settings-title">Modelo de embeddings</h3>
          <div className="settings-status">
            <Chip size="sm" tone={emb.transformersInstalled ? 'ok' : 'conflict'}>
              {emb.transformersInstalled
                ? 'transformers.js instalado'
                : 'transformers.js no instalado'}
            </Chip>
            <Chip size="sm" tone={emb.activeProvider !== null ? 'accent' : 'neutral'}>
              {emb.activeProvider !== null
                ? `activo: ${emb.activeProvider}`
                : 'modelo aún no cargado (se carga en la primera consulta)'}
            </Chip>
          </div>
          <div className="radio-cards">
            {PROVIDER_META.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`radio-card${draft.provider === p.key ? ' selected' : ''}`}
                onClick={() => set({ provider: p.key })}
              >
                <span className="radio-card-label">{p.label}</span>
                <span className="radio-card-desc">{p.desc}</span>
              </button>
            ))}
          </div>
          {(draft.provider === 'auto' || draft.provider === 'transformers') && (
            <label className="settings-field">
              <span className="param-label">Modelo</span>
              <input
                type="text"
                value={draft.model}
                placeholder={emb.defaultModel}
                onChange={(e) => set({ model: e.target.value })}
              />
              <span className="param-hint">
                Cualquier modelo ONNX de feature-extraction del Hub (familia e5/bge). Vacío = {emb.defaultModel}, multilingüe (~100 idiomas). Se descarga y cachea localmente en el primer uso.
              </span>
            </label>
          )}
        </GlassCard>

        {/* ------------------------------------------------ Método */}
        <GlassCard style={{ marginBottom: 18 }} pad="26px 28px">
          <h3 className="settings-title">Método de retrieval</h3>
          <div className="radio-cards two">
            <button
              type="button"
              className={`radio-card${!auto ? ' selected' : ''}`}
              onClick={() => set({ mode: 'manual' })}
            >
              <span className="radio-card-label">Manual</span>
              <span className="radio-card-desc">
                Se ejecutan exactamente los canales que actives abajo, con tus pesos.
              </span>
            </button>
            <button
              type="button"
              className={`radio-card${auto ? ' selected' : ''}`}
              onClick={() => set({ mode: 'auto' })}
            >
              <span className="radio-card-label">Auto — el agente decide</span>
              <span className="radio-card-desc">
                El motor elige canales y pesos por consulta: ids exactos → solo léxico; 1–2 palabras → léxico + semántico; preguntas → todos; alfabetos no latinos → más peso semántico.
              </span>
            </button>
          </div>

          <div className="channel-list">
            {CHANNEL_META.map((c) => {
              const ch = draft.channels[c.key];
              const unavailable = c.semantic && providerOff;
              return (
                <div key={c.key} className={`channel-row${ch.enabled && !unavailable ? '' : ' off'}`}>
                  <label className="channel-toggle" title={auto ? 'En modo auto, desactivar un canal es un veto duro: el agente nunca lo usará.' : undefined}>
                    <input
                      type="checkbox"
                      checked={ch.enabled}
                      onChange={() => setChannel(c.key, { enabled: !ch.enabled })}
                    />
                    <span>
                      <span className="channel-label">{c.label}</span>
                      <span className="channel-desc">{c.desc}</span>
                      {unavailable && (
                        <span className="channel-desc" style={{ color: 'var(--amber)' }}>
                          Sin proveedor de embeddings: este canal no se ejecutará.
                        </span>
                      )}
                    </span>
                  </label>
                  {!auto && (
                    <label className="channel-weight" title="Peso en la fusión RRF: cuánto confía la mezcla en este canal.">
                      <span className="mono param-value">{ch.weight.toFixed(2)}</span>
                      <input
                        type="range"
                        min={0.05}
                        max={1.5}
                        step={0.05}
                        value={ch.weight}
                        disabled={!ch.enabled}
                        onChange={(e) => setChannel(c.key, { weight: Number(e.target.value) })}
                      />
                    </label>
                  )}
                  {c.key === 'lexical_prf' && ch.enabled && (
                    <div className="prf-params">
                      <label>
                        <span className="param-label">Docs de feedback</span>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={draft.feedbackDocs}
                          onChange={(e) => set({ feedbackDocs: Number(e.target.value) || 8 })}
                        />
                      </label>
                      <label>
                        <span className="param-label">Términos de expansión</span>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={draft.expansionTerms}
                          onChange={(e) => set({ expansionTerms: Number(e.target.value) || 5 })}
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </GlassCard>

        {/* ------------------------------------------------ Expansión */}
        <GlassCard style={{ marginBottom: 18 }} pad="26px 28px">
          <h3 className="settings-title">Expansión por grafo y diversificación</h3>
          <p className="settings-lead">
            Tras sembrar con los canales, el contexto se expande por las aristas (activación
            propagada + PageRank personalizado) y las semillas se diversifican con MMR.
          </p>
          <div className="param-grid">
            <ParamSlider
              label="Profundidad"
              hint="Saltos desde las semillas (1–3). Más = más contexto, más ruido."
              value={draft.depth}
              min={1}
              max={3}
              step={1}
              onChange={(v) => set({ depth: v })}
            />
            <ParamSlider
              label="Decaimiento por salto"
              hint="Cuánta activación sobrevive cada salto (0.6 por defecto)."
              value={draft.decay}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(v) => set({ decay: v })}
            />
            <ParamSlider
              label="Penalización de hubs"
              hint="Amortigua nodos muy conectados (el ERP de todos los IMPLEMENTED_IN)."
              value={draft.fanoutPenalty}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ fanoutPenalty: v })}
            />
            <ParamSlider
              label="Reinicio del random walk"
              hint="α del PageRank personalizado: más alto = masa más cerca de las semillas."
              value={draft.restart}
              min={0.05}
              max={0.9}
              step={0.05}
              onChange={(v) => set({ restart: v })}
            />
            <ParamSlider
              label="Mezcla activación / PPR"
              hint="1 = solo cadenas cortas fuertes; 0 = solo conectividad global."
              value={draft.activationBlend}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ activationBlend: v })}
            />
            <ParamSlider
              label="MMR λ (diversidad)"
              hint="1 = solo relevancia; 0 = máxima diversidad entre semillas."
              value={draft.mmrLambda}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set({ mmrLambda: v })}
            />
          </div>
        </GlassCard>

        {/* ------------------------------------------------ Guardar */}
        <div className="settings-savebar">
          {dirty ? (
            <span className="dim">Hay cambios sin guardar.</span>
          ) : (
            <span className="dim">
              {savedCommit !== null ? `Guardado (commit ${savedCommit.slice(0, 8)}).` : 'Sin cambios.'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <Button
            size="sm"
            variant="glass"
            disabled={!dirty || saving}
            onClick={() => setDraft(saved)}
          >
            Descartar
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Guardando…' : 'Guardar en untacit.config.json'}
          </Button>
        </div>

        {/* ------------------------------------------------ Probar */}
        <GlassCard pad="26px 28px">
          <h3 className="settings-title">Probar retrieval</h3>
          <p className="settings-lead">
            Ejecuta el pipeline completo con la configuración de arriba (aunque no esté guardada)
            y muestra qué decidió el plan y qué canales encontraron cada nodo.
          </p>
          <div className="drift-controls" style={{ marginBottom: 14 }}>
            <input
              type="text"
              value={testQuery}
              placeholder="p. ej. ¿qué pasa si un cliente nuevo no paga por adelantado?"
              onChange={(e) => setTestQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runTest();
              }}
            />
            <Button size="sm" onClick={runTest} disabled={testing || testQuery.trim().length < 2}>
              {testing ? 'Consultando…' : 'Probar'}
            </Button>
          </div>
          {testing && emb.activeProvider === null && draft.provider !== 'none' && (
            <p className="dim" style={{ fontSize: 12.5 }}>
              Primera consulta: puede tardar mientras se carga (o descarga) el modelo…
            </p>
          )}
          {testError !== null && <div className="error-banner" style={{ margin: '0 0 14px' }}>{testError}</div>}
          {test !== null && (
            <div className="test-result">
              <div className="test-plan">
                <div className="settings-status" style={{ marginBottom: 10 }}>
                  <Chip size="sm" tone="accent">
                    modo {test.plan.mode === 'auto' ? 'auto' : 'manual'}
                  </Chip>
                  <Chip size="sm" tone="neutral">
                    consulta:{' '}
                    {test.plan.queryKind === 'id-lookup'
                      ? 'id'
                      : test.plan.queryKind === 'keywords'
                        ? 'palabras clave'
                        : 'pregunta'}
                  </Chip>
                  <Chip size="sm" tone={test.provider !== null ? 'ok' : 'neutral'}>
                    {test.provider !== null ? test.provider : 'sin embeddings'}
                  </Chip>
                  <Chip size="sm" tone="neutral">{test.tookMs} ms</Chip>
                </div>
                <ul className="plan-list">
                  {test.plan.channels.map((c) => (
                    <li key={c.channel}>
                      <span className="mono plan-channel">{c.channel}</span>
                      <span className="mono dim">×{c.weight.toFixed(2)}</span>
                      <span className="plan-reason">{c.reason}</span>
                    </li>
                  ))}
                  {test.plan.skipped.map((c) => (
                    <li key={c.channel} className="off">
                      <span className="mono plan-channel">{c.channel}</span>
                      <span className="plan-reason">omitido: {c.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {test.nodes.length === 0 ? (
                <p className="dim">Sin resultados para esta consulta.</p>
              ) : (
                <ul className="test-nodes">
                  {test.nodes.slice(0, 20).map((n) => (
                    <li key={n.id}>
                      <NodeDot color={NODE_TYPE_COLORS[n.type]} />
                      <span className="test-node-name">{n.name}</span>
                      <span className="mono dim" style={{ fontSize: 10.5 }}>{n.type}</span>
                      <span style={{ flex: 1 }} />
                      {n.seed ? (
                        n.channels.map((ch) => (
                          <Chip key={ch} size="sm" tone="accent" style={{ padding: '1px 8px', fontSize: 10 }}>
                            {ch}
                          </Chip>
                        ))
                      ) : (
                        <Chip size="sm" tone="neutral" style={{ padding: '1px 8px', fontSize: 10 }}>
                          grafo · {n.distance} salto{n.distance === 1 ? '' : 's'}
                        </Chip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {test.nodes.length > 20 && (
                <p className="dim" style={{ fontSize: 12 }}>
                  … y {test.nodes.length - 20} nodos más ({test.edges.length} aristas en el subgrafo).
                </p>
              )}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
