import { MultiDirectedGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';

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

export function GraphView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  const [typeFilter, setTypeFilter] = useState<Set<NodeType>>(new Set(NODE_TYPES));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(ELEMENT_STATUSES));
  const [minConfidence, setMinConfidence] = useState(0);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);

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
    const renderer = new Sigma(graph, containerRef.current, {
      labelColor: { color: '#E8EDF6' },
      labelFont: 'Archivo, system-ui, sans-serif',
      labelWeight: '500',
      labelSize: 11,
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
    });
    renderer.on('clickNode', ({ node }) => setSelected(node));
    renderer.on('clickStage', () => setSelected(null));
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

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    api
      .search(q, undefined, 8)
      .then((r) => setResults(r.results))
      .catch(() => setResults([]));
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
          <h3>Búsqueda (FTS)</h3>
          <input
            type="search"
            placeholder="prepago, facturación…"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
          />
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
