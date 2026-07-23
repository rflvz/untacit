/**
 * Typed fetch helpers for the sidecar API. In dev, Vite proxies /api to the
 * sidecar (vite.config.ts). Inside the Tauri shell the page is served from
 * the tauri:// protocol (http://tauri.localhost on Windows), so relative
 * fetches would miss the sidecar — use its absolute origin there (the shell
 * spawns it on the default port, src-tauri/src/main.rs).
 */

import type {
  ApiError,
  ConflictResolveRequest,
  ConflictResolveResponse,
  DiffResponse,
  Evidence,
  GraphResponse,
  HealthResponse,
  InterviewAcceptAllResponse,
  InterviewAnswerResponse,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposalRequest,
  InterviewProposalResponse,
  InterviewStartResponse,
  MergeActionResponse,
  NodeDetailResponse,
  NodeType,
  OpenResponse,
  RetrievalConfig,
  RetrievalTestRequest,
  RetrievalTestResponse,
  ReviewResponse,
  RunsResponse,
  SearchResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  SettingsUpdateResponse,
  StatsResponse,
} from './api-types.js';

const API_BASE =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? 'http://127.0.0.1:4823'
    : '';

export class SidecarError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = (await res.json().catch(() => undefined)) as T | ApiError | undefined;
  if (!res.ok) {
    const message =
      body !== undefined && typeof body === 'object' && body !== null && 'error' in body
        ? String((body as ApiError).error)
        : `HTTP ${res.status}`;
    throw new SidecarError(res.status, message);
  }
  if (body === undefined) throw new SidecarError(res.status, 'invalid JSON response');
  return body as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s.length > 0 ? `?${s}` : '';
}

export interface GraphFilters {
  minConfidence?: number;
  types?: NodeType[];
  status?: string[];
}

export const api = {
  health: (): Promise<HealthResponse> => request('/api/health'),
  stats: (): Promise<StatsResponse> => request('/api/stats'),
  graph: (filters: GraphFilters = {}): Promise<GraphResponse> =>
    request(
      `/api/graph${qs({
        minConfidence: filters.minConfidence,
        types: filters.types?.join(','),
        status: filters.status?.join(','),
      })}`,
    ),
  node: (id: string): Promise<NodeDetailResponse> =>
    request(`/api/node/${encodeURIComponent(id)}`),
  search: (q: string, types?: NodeType[], limit?: number): Promise<SearchResponse> =>
    request(`/api/search${qs({ q, types: types?.join(','), limit })}`),
  conflicts: (): Promise<{ conflicts: ReviewResponse['conflicts'] }> => request('/api/conflicts'),
  review: (): Promise<ReviewResponse> => request('/api/review'),
  runs: (): Promise<RunsResponse> => request('/api/runs'),
  diff: (a: string, b: string): Promise<DiffResponse> => request(`/api/diff${qs({ a, b })}`),
  acceptMerge: (proposalId: string, by?: string): Promise<MergeActionResponse> =>
    post(`/api/review/merge/${encodeURIComponent(proposalId)}/accept`, by !== undefined ? { by } : {}),
  rejectMerge: (proposalId: string, by?: string): Promise<MergeActionResponse> =>
    post(`/api/review/merge/${encodeURIComponent(proposalId)}/reject`, by !== undefined ? { by } : {}),
  resolveConflict: (req: ConflictResolveRequest): Promise<ConflictResolveResponse> =>
    post('/api/review/conflict/resolve', req),
  /** Open an evidence's source file locally (docs/04 Fase 2: locator clicable). */
  open: (evidence: Pick<Evidence, 'source_type' | 'locator'>): Promise<OpenResponse> =>
    post('/api/open', { source_type: evidence.source_type, locator: evidence.locator }),

  // ---- Settings & retrieval (Ajustes) ----
  settings: (): Promise<SettingsResponse> => request('/api/settings'),
  saveSettings: (update: SettingsUpdateRequest): Promise<SettingsUpdateResponse> =>
    request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    }),
  retrievalTest: (
    query: string,
    retrieval?: RetrievalConfig,
    limit?: number,
  ): Promise<RetrievalTestResponse> =>
    post('/api/retrieval/test', { query, retrieval, limit } satisfies RetrievalTestRequest),

  // ---- Agentic interviews (Fase 4) ----
  interviewGaps: (): Promise<InterviewGapsResponse> => request('/api/interview/gaps'),
  interviewStart: (role: string): Promise<InterviewStartResponse> =>
    post('/api/interview/start', { role }),
  interviewGet: (id: string): Promise<InterviewStartResponse> =>
    request(`/api/interview/${encodeURIComponent(id)}`),
  interviewAnswer: (id: string, text: string): Promise<InterviewAnswerResponse> =>
    post(`/api/interview/${encodeURIComponent(id)}/answer`, { text }),
  interviewProposal: (
    id: string,
    proposalId: string,
    action: InterviewProposalRequest['action'],
    patch?: InterviewProposalRequest['patch'],
  ): Promise<InterviewProposalResponse> =>
    post(
      `/api/interview/${encodeURIComponent(id)}/proposal/${encodeURIComponent(proposalId)}`,
      patch !== undefined ? { action, patch } : { action },
    ),
  interviewAcceptAll: (id: string, except: string[] = []): Promise<InterviewAcceptAllResponse> =>
    post(`/api/interview/${encodeURIComponent(id)}/accept-all`, { except }),
  interviewFinish: (id: string): Promise<InterviewFinishResponse> =>
    post(`/api/interview/${encodeURIComponent(id)}/finish`),
};

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
