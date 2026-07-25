import { MultiDirectedGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { Settings } from 'sigma/settings';
import type { NodeDisplayData, PartialButFor } from 'sigma/types';

import { api } from '../api.js';
import type { GraphResponse, NodeType, SearchResult } from '../api-types.js';
import { NodeDot } from '../ds/index.js';
import {
  CONFLICT_COLOR,
  EDGE_COLOR,
  ELEMENT_STATUSES,
  NODE_TYPES,
  NODE_TYPE_COLORS,
} from '../ontology.js';
import { DetailPanel } from './DetailPanel.js';

/**
 * Themed replacement for sigma's default hover renderer. The default draws a
 * WHITE pill behind the label and then renders the label with
 * settings.labelColor — #E8EDF6 here — so hovering a node showed a white box
 * with near-white, unreadable text. This draws the untacit glass pill (dark
 * background, subtle border) with the label plus the node-type tag.
 */
function drawNodeHover(
  context: CanvasRenderingContext2D,
  data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>,
  settings: Settings,
): void {
  if (typeof data.label !== 'string' || data.label === '') return;
  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  const nodeType = (data as { nodeType?: string }).nodeType ?? '';

  context.font = `${weight} ${size}px ${font}`;
  const labelWidth = context.measureText(data.label).width;
  const typeFont = `600 ${size - 2.5}px "IBM Plex Mono", monospace`;
  context.font = typeFont;
  const typeWidth = nodeType === '' ? 0 : context.measureText(nodeType.toUpperCase()).width + 8;

  const padX = 8;
  const padY = 5;
  const boxWidth = Math.round(labelWidth + typeWidth + 2 * padX);
  const boxHeight = Math.round(size + 2 * padY);
  const boxX = data.x + data.size + 6;
  const boxY = data.y - boxHeight / 2;
  const radius = 7;

  context.save();
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 6;
  context.shadowBlur = 18;
  context.shadowColor = 'rgba(2, 6, 18, 0.6)';
  context.beginPath();
  context.roundRect(boxX, boxY, boxWidth, boxHeight, radius);
  context.fillStyle = 'rgba(13, 20, 38, 0.94)';
  context.fill();
  context.shadowColor = 'transparent';
  context.lineWidth = 1;
  context.strokeStyle = 'rgba(163, 186, 242, 0.38)';
  context.stroke();

  // Halo ring around the hovered node, in its own color.
  context.beginPath();
  context.arc(data.x, data.y, data.size + 2.5, 0, Math.PI * 2);
  context.strokeStyle = data.color ?? '#E8EDF6';
  context.lineWidth = 1.5;
  context.stroke();

  context.textBaseline = 'middle';
  context.font = `${weight} ${size}px ${font}`;
  context.fillStyle = '#E8EDF6';
  context.fillText(data.label, boxX + padX, data.y + 1);
  if (nodeType !== '') {
    context.font = typeFont;
    context.fillStyle = NODE_TYPE_COLORS[nodeType as NodeType] ?? '#9AA7C7';
    context.fillText(nodeType.toUpperCase(), boxX + padX + labelWidth + 8, data.y + 1);
  }
  context.restore();
}

type SearchMode = 'fts' | 'hybrid' | 'semantic';

export function GraphView({
  focusId,
  onFocusHandled,
}: {
  /** Node another view asked to focus (Revisión → Grafo); consumed once. */
  focusId?: string | null;
  onFocusHandled?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  const [typeFilter, setTypeFilter] = useState<Set<NodeType>>(new Set(NODE_TYPES));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(ELEMENT_STATUSES));
  const [minConfidence, setMinConfidence] = useState(0);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>('fts');
  const [searchError, setSearchError] = useState<string | null>(null);

  // Fetch the (filtered) graph.
  useEffect(() => {
    api
      .graph({
        minConfidence: minConfidence > 0 ? minConfidence : undefined,
        types: typeFilter.size < NODE_TYPES.length ? [...typeFilter] : undefined,
        status: statusFilter.size < ELEMENT_STATUSES.length ? [...statusFilter] : undefined,
      })
      .then(setData)
      .catch(() => setData(null));
  }, [typeFilter, statusFilter, minConfidence]);

  // (Re)build the Sigma renderer whenever the data changes.
  useEffect(() => {
    if (!containerRef.current || !data) return;

    const graph = new MultiDirectedGraph();
    const n = data.nodes.length || 1;
    data.nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / n;
      graph.addNode(node.id, {
        label: node.name,
        x: Math.cos(angle),
        y: Math.sin(angle),
        size: 4,
        color: node.status === 'conflicted' ? CONFLICT_COLOR : NODE_TYPE_COLORS[node.type],
        nodeType: node.type,
      });
    });
    for (const edge of data.edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.targetId)) continue;
      graph.addEdge(edge.source, edge.targetId, {
        size: 0.5 + edge.confidence * 2.5,
        color: edge.status === 'conflicted' ? CONFLICT_COLOR : EDGE_COLOR,
        type: 'arrow',
      });
    }
    // Size by degree, then settle the layout.
    graph.forEachNode((id) => {
      graph.setNodeAttribute(id, 'size', 3 + Math.min(graph.degree(id) * 0.8, 12));
    });
    if (graph.order > 1) {
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: { ...forceAtlas2.inferSettings(graph), scalingRatio: 8 },
      });
    }

    sigmaRef.current?.kill();
    const container = containerRef.current;
    const renderer = new Sigma(graph, container, {
      labelColor: { color: '#E8EDF6' },
      labelFont: 'Archivo, system-ui, sans-serif',
      labelWeight: '500',
      labelSize: 11,
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      defaultDrawNodeHover: drawNodeHover,
    });
    renderer.on('clickNode', ({ node }) => setSelected(node));
    renderer.on('clickStage', () => setSelected(null));
    renderer.on('enterNode', () => {
      container.style.cursor = 'pointer';
    });
    renderer.on('leaveNode', () => {
      container.style.cursor = 'default';
    });
    sigmaRef.current = renderer;

    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
  }, [data]);

  const focusNode = (id: string) => {
    setSelected(id);
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const display = renderer.getNodeDisplayData(id);
    if (display) {
      renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.25 }, { duration: 400 });
    }
  };

  // Focus requested by another view (Revisión): wait for the renderer, then
  // consume the request so a later manual click is not overridden.
  useEffect(() => {
    if (focusId === undefined || focusId === null || data === null) return;
    focusNode(focusId);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, data]);

  const runSearch = (q: string, mode: SearchMode = searchMode) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    api
      .search(q, undefined, 8, mode)
      .then((r) => {
        setResults(r.results);
        setSearchError(null);
      })
      .catch((err: Error) => {
        setResults([]);
        setSearchError(err.message);
      });
  };

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="graph-layout">
      <aside className="graph-sidebar">
        <div className="filter-group">
          <h3>Búsqueda</h3>
          <input
            type="search"
            placeholder="prepago, facturación…"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
          />
          <div className="search-modes">
            {(
              [
                ['fts', 'exacta', 'FTS5 (bm25): coincidencia por palabras'],
                ['hybrid', 'híbrida', 'Fusión RRF de léxico + embeddings'],
                ['semantic', 'semántica', 'Solo k-NN de embeddings (cruza idiomas y sinónimos)'],
              ] as const
            ).map(([mode, label, hint]) => (
              <label key={mode} title={hint}>
                <input
                  type="radio"
                  name="search-mode"
                  checked={searchMode === mode}
                  onChange={() => {
                    setSearchMode(mode);
                    runSearch(query, mode);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {searchError !== null && (
            <div className="dim" style={{ fontSize: 11.5, color: 'var(--amber)' }}>
              {searchError}
            </div>
          )}
          <div className="search-results">
            {results.map((r) => (
              <button key={r.id} onClick={() => focusNode(r.id)}>
                <NodeDot color={NODE_TYPE_COLORS[r.type]} />
                {r.name} <span className="dim mono" style={{ fontSize: 10.5 }}>{r.type}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-group">
          <h3>Tipos de nodo</h3>
          {NODE_TYPES.map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={typeFilter.has(type)}
                onChange={() => setTypeFilter(toggle(typeFilter, type))}
              />
              <NodeDot color={NODE_TYPE_COLORS[type]} />
              {type}
            </label>
          ))}
        </div>
        <div className="filter-group">
          <h3>Confianza mínima: {minConfidence.toFixed(2)}</h3>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
        </div>
        <div className="filter-group">
          <h3>Estado</h3>
          {ELEMENT_STATUSES.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={statusFilter.has(status)}
                onChange={() => setStatusFilter(toggle(statusFilter, status))}
              />
              {status}
            </label>
          ))}
        </div>
      </aside>
      <div className="graph-canvas">
        <div ref={containerRef} className="sigma-container" />
        {data?.truncated && (
          <div className="graph-truncated">Vista truncada: afina los filtros.</div>
        )}
      </div>
      {selected && (
        <DetailPanel nodeId={selected} onNavigate={focusNode} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
