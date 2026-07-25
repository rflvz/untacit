/**
 * Extraction routes (desktop Fase 2): run `extract code` / `extract docs` over
 * the sources declared in untacit.config.json without leaving the app.
 *
 * Extraction is slow (one LLM call per chunk of candidates/sections), so it is
 * modelled as an in-memory job: POST returns immediately with a job snapshot
 * and the UI follows the phases (escaneo → llamadas LLM → import) by polling
 * `GET /api/extract/:id` or streaming `GET /api/extract/:id/events` (SSE).
 *
 * The engine is the local `claude` CLI, exactly like the CLI command and
 * sidecar/interview.ts — there is no Anthropic API client and no
 * ANTHROPIC_API_KEY anywhere (docs/03 §4). When the binary is unreachable the
 * routes answer 503 with the install hint instead of failing mid-run.
 *
 * Two deliberate constraints:
 *
 *  - **One running job at a time** (409 otherwise). The import step writes the
 *    canonical files and commits; two concurrent imports would race on the git
 *    index and on .untacit/index.db.
 *  - **Reindexing is left to the sidecar's own index** (`reindex: false`, the
 *    same contract as POST /api/import), so there is never a second SQLite
 *    writer.
 *
 * Cancellation is checked before every LLM call, so it takes effect at the
 * next chunk boundary and discards the partial batch — the same semantics as
 * Ctrl+C on `untacit extract`. An import failure is different: the emitted
 * batch stays retrievable at `GET /api/extract/:id/batch`, so LLM spend is
 * never lost to a problem the user can fix and retry.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  ApiError,
  ExtractCandidate,
  ExtractJob,
  ExtractJobsResponse,
  ExtractKind,
  ExtractPhase,
  ExtractPreviewRequest,
  ExtractPreviewResponse,
  ExtractSection,
  ExtractSkippedFile,
  ExtractSource,
  ExtractSourcesResponse,
  ExtractStartRequest,
  ExtractStartResponse,
  ValidationIssue,
} from '../src/api-types.js';
import { createEngineProbe, modelFromPayload } from './agent-engine.js';
import type { CoreModule } from './core-loader.js';
import { extractorsLoadError, loadExtractors, type ExtractorsModule } from './extractors-loader.js';

// Engine types, erased at compile time (runtime goes through the loader).
import type { Candidate, DocumentSection, LlmClient, LlmRequest } from '@untacit/extractors';
import type { ExtractionBatch, UntacitConfig } from '@untacit/core';

export interface ExtractRouteDeps {
  repoRoot: string;
  /** The core-resolving route wrapper from createApp. */
  route: (
    handler: (c: Context, core: CoreModule) => Promise<Response> | Response,
  ) => (c: Context) => Promise<Response>;
  /**
   * createApp's write queue: the import step must not interleave with another
   * graph write (a merge accepted, an interview finished) — every one of them
   * ends in a git commit.
   */
  serializeWrite: <T>(work: () => Promise<T> | T) => Promise<T>;
  /** Injected LLM client (tests); production builds a ClaudeCodeLlmClient. */
  llm?: LlmClient;
}

/** Formats loadDocumentSections can parse (docs/03 §4.2). */
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);
/** Directories never worth walking for source documents. */
const SKIP_DIRS = /^(node_modules|dist|build|target|\.git|\.untacit|\.venv)$/;
/** Hard cap on files pulled from one document source (a folder can be huge). */
const MAX_DOC_FILES = 200;
/** Hard cap on glob-selected code files handed to scanRepo as `paths`. */
const MAX_CODE_FILES = 5000;
/** Default candidates per LLM call (mirrors the CLI's --chunk-size). */
const DEFAULT_CODE_CHUNK = 8;
/** Default sections per LLM call (mirrors the CLI's --sections-per-call). */
const DEFAULT_DOCS_CHUNK = 4;
/** Default cap on candidates scanned (mirrors the CLI's --max-candidates). */
const DEFAULT_MAX_CANDIDATES = 50;
/** Finished jobs are dropped after an hour; the durable history lives in runs/. */
const JOB_TTL_MS = 60 * 60 * 1000;
/** Hard cap on remembered jobs (oldest finished one evicted first). */
const MAX_JOBS = 20;

const TERMINAL_PHASES: readonly ExtractPhase[] = ['done', 'error', 'cancelled'];
const isTerminal = (phase: ExtractPhase): boolean => TERMINAL_PHASES.includes(phase);

/** Thrown by the progress wrapper when a cancellation was requested. */
class ExtractCancelled extends Error {
  constructor() {
    super('extracción cancelada');
    this.name = 'ExtractCancelled';
  }
}

interface JobRecord {
  /** Everything the API exposes (GET /api/extract/:id and SSE payloads). */
  snapshot: ExtractJob;
  /** The emitted batch, kept so LLM spend survives an import failure. */
  batch?: ExtractionBatch;
  listeners: Set<(job: ExtractJob) => void>;
  lastActivity: number;
}

/** What one extraction pass returns, whatever the source type. */
interface EnginePass {
  batch: ExtractionBatch;
  rejections: ValidationIssue[];
  llmCalls: number;
}

/**
 * LlmClient decorator: counts completions for the progress bar and turns a
 * pending cancellation into an abort *before* spending the next call. An
 * in-flight call is never killed — `claude` owns that process.
 */
class ProgressLlmClient implements LlmClient {
  readonly name: string;
  readonly model: string;
  constructor(
    private readonly inner: LlmClient,
    private readonly onCall: () => void,
    private readonly cancelled: () => boolean,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async complete(req: LlmRequest): Promise<string> {
    if (this.cancelled()) throw new ExtractCancelled();
    const out = await this.inner.complete(req);
    this.onCall();
    return out;
  }
}

/**
 * `include`/`exclude` of a source config are **globs over the source-relative
 * path**, the way the repo's own exemplar writes them
 * (examples/acme-manufactura/untacit.config.json: `src/**` + `*.ts`,
 * `**` + `*.md`). `**` crosses directory separators, `*` and `?` do not.
 *
 * They are matched here rather than handed to the extractors' scanRepo: that
 * takes RegExps, tests `include` against the bare filename and `exclude`
 * against the absolute path, and — decisively — *replaces* its own
 * DEFAULT_EXCLUDE (node_modules, dist, test, vendor…) with whatever it is
 * given. Filtering first and passing the surviving files as scanRepo's `paths`
 * keeps those defaults in force and gives the globs the path semantics they
 * are written for.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` also matches zero directories, so `**/*.md` covers `a.md`.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Compile a source's glob list once; undefined when it declares none. */
function compileGlobs(patterns: string[] | undefined): RegExp[] | undefined {
  if (patterns === undefined || patterns.length === 0) return undefined;
  return patterns.map(globToRegExp);
}

const matchesAny = (globs: RegExp[] | undefined, relPath: string): boolean =>
  globs !== undefined && globs.some((glob) => glob.test(relPath));

/** Source-relative POSIX path, the form the globs and locators are written in. */
function relativeToRoot(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === '' ? basename(file) : rel.split(sep).join('/');
}

/** Selected by the source's globs? No globs at all means "everything". */
function selectedByGlobs(
  relPath: string,
  include: RegExp[] | undefined,
  exclude: RegExp[] | undefined,
): boolean {
  if (include !== undefined && !matchesAny(include, relPath)) return false;
  return !matchesAny(exclude, relPath);
}

/**
 * Reject a request-supplied `paths` entry that would leave the source root.
 *
 * scanRepo resolves each entry with `join(rootDir, rel)` and never checks
 * containment, so `../../etc` would happily be scanned and its contents sent
 * to the agent. POST /api/open guards the same way for evidence locators; this
 * is the extraction-side equivalent.
 */
function assertInsideRoot(root: string, relPath: string): void {
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path "${relPath}" escapes the source root ${root}`);
  }
}

/** Every parseable document under a source folder (or the file itself), sorted. */
function listDocumentFiles(
  root: string,
  include?: RegExp[],
  exclude?: RegExp[],
): string[] {
  const found: string[] = [];
  // A document source may point at a single file rather than a folder.
  if (statSync(root).isFile()) {
    if (DOC_EXTENSIONS.has(extname(root).toLowerCase())) found.push(root);
    return found;
  }
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      if (found.length >= MAX_DOC_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.test(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!DOC_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (!selectedByGlobs(relativeToRoot(root, full), include, exclude)) continue;
      found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * Source-relative POSIX paths a code source's globs select, for scanRepo's
 * `paths`. Returns undefined when the source declares no globs — then scanRepo
 * walks the whole source itself with its own defaults, exactly like the CLI.
 */
function listCodeFiles(
  root: string,
  include: RegExp[] | undefined,
  exclude: RegExp[] | undefined,
): string[] | undefined {
  if (include === undefined && exclude === undefined) return undefined;
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= MAX_CODE_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (found.length >= MAX_CODE_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.test(entry.name)) continue;
        walk(full);
        continue;
      }
      const rel = relativeToRoot(root, full);
      if (selectedByGlobs(rel, include, exclude)) found.push(rel);
    }
  };
  walk(root);
  return found;
}

/** One entry of untacit.config.json's sources, normalized for both kinds. */
interface ResolvedSource {
  /** Repo name recorded in code locators; the folder name for documents. */
  name: string;
  /** Path exactly as declared in untacit.config.json. */
  path: string;
  include?: string[];
  exclude?: string[];
}

/** Declared sources, resolved against this machine (existence + doc counts). */
function listSources(repoRoot: string, config: UntacitConfig): ExtractSource[] {
  const sources: ExtractSource[] = [];
  for (const source of config.sources.code) {
    const resolvedPath = resolve(repoRoot, source.path);
    sources.push({
      kind: 'code',
      key: source.name,
      label: source.name,
      path: source.path,
      resolvedPath,
      exists: existsSync(resolvedPath),
    });
  }
  for (const source of config.sources.documents) {
    const resolvedPath = resolve(repoRoot, source.path);
    const exists = existsSync(resolvedPath);
    const row: ExtractSource = {
      kind: 'docs',
      key: source.path,
      label: basename(resolvedPath) || source.path,
      path: source.path,
      resolvedPath,
      exists,
    };
    if (exists) {
      try {
        row.documentCount = listDocumentFiles(
          resolvedPath,
          compileGlobs(source.include),
          compileGlobs(source.exclude),
        ).length;
      } catch {
        // An unreadable folder is reported as "no documents", not a 500: the
        // UI already shows the resolved path for the user to fix.
        row.documentCount = 0;
      }
    }
    sources.push(row);
  }
  return sources;
}

/** Resolve an ExtractSource.key back to its config entry, or throw a 404 message. */
function findSource(
  repoRoot: string,
  config: UntacitConfig,
  kind: ExtractKind,
  key: string,
): ResolvedSource {
  if (kind === 'code') {
    const source = config.sources.code.find((s) => s.name === key);
    if (source === undefined) {
      throw new Error(
        `code source "${key}" not found in untacit.config.json (sources.code) — add it in Ajustes`,
      );
    }
    return source;
  }
  const source = config.sources.documents.find((s) => s.path === key);
  if (source === undefined) {
    throw new Error(
      `document source "${key}" not found in untacit.config.json (sources.documents) — add it in Ajustes`,
    );
  }
  return { ...source, name: basename(resolve(repoRoot, source.path)) || source.path };
}

/**
 * Chunk size, clamped. A chunk of 0 (or NaN) would make `Math.ceil(units / 0)`
 * Infinity and the extractors' `i += chunkSize` loop spin forever spending real
 * LLM calls, so anything meaningless falls back to the default — which is also
 * what the UI's "0 = por defecto" input sends.
 */
function clampChunk(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(64, Math.floor(raw));
}

/** Same contract for the candidate cap: meaningless → the CLI's default. */
function clampCandidates(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_CANDIDATES;
  return Math.min(500, Math.floor(raw));
}

/** doc_id per file, deduplicated — two "manual.md" must not share provenance. */
function docIdsFor(extractors: ExtractorsModule, files: string[]): string[] {
  const used = new Set<string>();
  return files.map((file) => {
    const base = extractors.slugifyDocId(file);
    let docId = base;
    for (let n = 2; used.has(docId); n++) docId = `${base}-${n}`;
    used.add(docId);
    return docId;
  });
}

export function registerExtractRoutes(app: Hono, deps: ExtractRouteDeps): void {
  const { repoRoot, route, serializeWrite } = deps;
  const jobs = new Map<string, JobRecord>();
  let runningJobId: string | null = null;
  // `claude --version` blocks the event loop: cache it so /sources (polled on
  // every mount, and after every job) cannot stall a running job's progress.
  const probeEngine = createEngineProbe();

  const sweepJobs = (now: number): void => {
    for (const [id, job] of jobs) {
      if (id === runningJobId) continue;
      if (now - job.lastActivity > JOB_TTL_MS) jobs.delete(id);
    }
    while (jobs.size >= MAX_JOBS) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [id, job] of jobs) {
        if (id === runningJobId) continue;
        if (job.lastActivity < oldestAt) {
          oldestAt = job.lastActivity;
          oldest = id;
        }
      }
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
  };

  /** Route wrapper that additionally resolves @untacit/extractors. */
  const extractRoute = (
    handler: (
      c: Context,
      core: CoreModule,
      extractors: ExtractorsModule,
    ) => Promise<Response> | Response,
  ) =>
    route(async (c, core) => {
      const extractors = await loadExtractors();
      if (extractors === undefined) {
        const body: ApiError = {
          error: 'extractors package not available',
          detail: extractorsLoadError(),
        };
        return c.json(body, 503);
      }
      return handler(c, core, extractors);
    });

  /**
   * Resolve the LLM client for a job, or explain exactly what is missing.
   * An injected client (tests) always wins and ignores the model override.
   */
  const resolveLlm = (
    extractors: ExtractorsModule,
    model: string | undefined,
  ): { llm: LlmClient } | { error: string } => {
    if (deps.llm !== undefined) return { llm: deps.llm };
    // Engine = Claude Code: the sidecar drives the local `claude` CLI with
    // whatever authentication it already has. No API key involved.
    const engine = probeEngine(extractors);
    if (!engine.ok) return { error: engine.detail };
    return { llm: new extractors.ClaudeCodeLlmClient(model !== undefined ? { model } : {}) };
  };

  const jobOf = (c: Context): JobRecord => {
    const id = c.req.param('id') ?? '';
    const job = jobs.get(id);
    // "not found" phrasing → HTTP 404 via the shared error mapper.
    if (job === undefined) throw new Error(`extraction job "${id}" not found`);
    return job;
  };

  /** Publish the current snapshot to every SSE listener. */
  const emit = (job: JobRecord): void => {
    job.lastActivity = Date.now();
    const frozen = { ...job.snapshot };
    for (const listener of job.listeners) listener(frozen);
  };

  /**
   * Heuristic candidate scan over a code source (no LLM).
   *
   * `repoName` is the config source *name*, not the directory basename the CLI
   * defaults to: it is the value POST /api/open matches locators against
   * (`sources.code[].name`), so using anything else would make every locator
   * this run emits unopenable from the detail panel.
   */
  const scanCode = (
    extractors: ExtractorsModule,
    root: string,
    source: ResolvedSource,
    opts: { maxCandidates?: number; paths?: string[] },
  ): Candidate[] => {
    const globbed = listCodeFiles(root, compileGlobs(source.include), compileGlobs(source.exclude));
    // A request may narrow the run further (partial re-extraction, docs/03 §5).
    // Every entry is checked for containment: scanRepo does not do it.
    let requested: string[] | undefined;
    if (Array.isArray(opts.paths) && opts.paths.length > 0) {
      for (const rel of opts.paths) {
        if (typeof rel !== 'string' || rel.trim() === '') {
          throw new Error('"paths" must have non-empty string entries');
        }
        assertInsideRoot(root, rel);
      }
      requested = opts.paths;
    }
    // Both present → intersect: a requested dir keeps the glob-selected files
    // under it, a requested file must itself be glob-selected.
    const paths =
      globbed !== undefined && requested !== undefined
        ? globbed.filter((rel) =>
            requested!.some((req) => {
              const prefix = req.split(sep).join('/').replace(/\/$/, '');
              return rel === prefix || rel.startsWith(`${prefix}/`);
            }),
          )
        : (globbed ?? requested);
    return extractors.scanRepo(root, {
      repoName: source.name,
      maxCandidates: clampCandidates(opts.maxCandidates),
      // include/exclude are deliberately NOT forwarded: scanRepo would replace
      // its DEFAULT_EXCLUDE (node_modules, dist, test, vendor…) with them.
      ...(paths !== undefined ? { paths } : {}),
    });
  };

  /** Parse every document under a document source into sections (no LLM). */
  const loadSections = async (
    extractors: ExtractorsModule,
    root: string,
    source: ResolvedSource,
  ): Promise<{
    sections: DocumentSection[];
    files: string[];
    skipped: ExtractSkippedFile[];
  }> => {
    const files = listDocumentFiles(
      root,
      compileGlobs(source.include),
      compileGlobs(source.exclude),
    );
    const docIds = docIdsFor(extractors, files);
    const sections: DocumentSection[] = [];
    const skipped: ExtractSkippedFile[] = [];
    for (const [i, file] of files.entries()) {
      try {
        sections.push(...(await extractors.loadDocumentSections(file, { docId: docIds[i]! })));
      } catch (err) {
        // One corrupt PDF must not sink the whole source — report and continue.
        skipped.push({
          path: relativeToRoot(root, file),
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { sections, files, skipped };
  };

  /** Shared preamble of /preview and /extract: parse, resolve, check the path. */
  const resolveRequest = (
    c: Context,
    core: CoreModule,
    payload: Partial<ExtractPreviewRequest & ExtractStartRequest>,
  ):
    | { kind: ExtractKind; key: string; source: ResolvedSource; root: string }
    | { response: Response } => {
    const kind = payload.kind;
    const key = typeof payload.source === 'string' ? payload.source : '';
    if ((kind !== 'code' && kind !== 'docs') || key === '') {
      return {
        response: c.json(
          { error: 'body must be { kind: "code" | "docs", source }' } satisfies ApiError,
          400,
        ),
      };
    }
    const config = core.loadConfig(repoRoot);
    const source = findSource(repoRoot, config, kind, key);
    const root = resolve(repoRoot, source.path);
    if (!existsSync(root)) {
      return {
        response: c.json(
          {
            error: `source path not found: ${root}`,
            detail: 'la ruta declarada en untacit.config.json no existe en esta máquina',
          } satisfies ApiError,
          404,
        ),
      };
    }
    return { kind, key, source, root };
  };

  // ---------------------------------------------------------------------------
  // GET /api/extract/sources — declared sources + engine availability, so the
  // Runs view can offer the picker (and the install hint) before any LLM call.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/extract/sources',
    extractRoute((c, core, extractors) => {
      const config = core.loadConfig(repoRoot);
      const engine =
        deps.llm !== undefined ? { ok: true, detail: deps.llm.name } : probeEngine(extractors);
      const body: ExtractSourcesResponse = {
        sources: listSources(repoRoot, config),
        llmReady: engine.ok,
        runningJobId,
      };
      if (!engine.ok) body.llmDetail = engine.detail;
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/extract/preview — candidates (code) or sections (docs) with no
  // LLM call at all: the CLI's --candidates-only / --sections-only, so the
  // user sees what an extraction would cost before paying for it.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/extract/preview',
    extractRoute(async (c, core, extractors) => {
      const payload = (await c.req.json().catch(() => ({}))) as Partial<ExtractPreviewRequest>;
      const resolved = resolveRequest(c, core, payload);
      if ('response' in resolved) return resolved.response;
      const { kind, key, source, root } = resolved;

      if (kind === 'code') {
        const candidates = scanCode(extractors, root, source, {
          ...(payload.maxCandidates !== undefined ? { maxCandidates: payload.maxCandidates } : {}),
          ...(payload.paths !== undefined ? { paths: payload.paths } : {}),
        });
        const chunkSize = clampChunk(payload.chunkSize, DEFAULT_CODE_CHUNK);
        const body: ExtractPreviewResponse = {
          kind,
          source: key,
          chunkSize,
          candidates: candidates as ExtractCandidate[],
          files: [...new Set(candidates.map((cand) => cand.path))].sort(),
          plannedCalls: Math.ceil(candidates.length / chunkSize),
        };
        return c.json(body);
      }

      const { sections, files, skipped } = await loadSections(extractors, root, source);
      const chunkSize = clampChunk(payload.chunkSize, DEFAULT_DOCS_CHUNK);
      const body: ExtractPreviewResponse = {
        kind,
        source: key,
        chunkSize,
        sections: sections as ExtractSection[],
        files: files.map((file) => relativeToRoot(root, file)),
        plannedCalls: Math.ceil(sections.length / chunkSize),
      };
      if (skipped.length > 0) body.skipped = skipped;
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/extract — start a job (202 + snapshot). The heavy work runs
  // detached; the client follows it by polling or SSE.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/extract',
    extractRoute(async (c, core, extractors) => {
      const payload = (await c.req.json().catch(() => ({}))) as Partial<ExtractStartRequest>;
      if (runningJobId !== null) {
        return c.json(
          {
            error: 'ya hay una extracción en curso',
            detail: `el job ${runningJobId} sigue activo — espera a que termine o cancélalo (una extracción a la vez: el import escribe ficheros y commitea)`,
          } satisfies ApiError,
          409,
        );
      }
      const resolved = resolveRequest(c, core, payload);
      if ('response' in resolved) return resolved.response;
      const { kind, key, source, root } = resolved;

      const model = modelFromPayload(payload);
      const llm = resolveLlm(extractors, model);
      if ('error' in llm) {
        return c.json(
          { error: 'motor de extracción no disponible', detail: llm.error } satisfies ApiError,
          503,
        );
      }

      const now = Date.now();
      sweepJobs(now);
      const id = `ext-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const chunkSize = clampChunk(
        payload.chunkSize,
        kind === 'code' ? DEFAULT_CODE_CHUNK : DEFAULT_DOCS_CHUNK,
      );
      const record: JobRecord = {
        snapshot: {
          id,
          kind,
          source: key,
          phase: 'scanning',
          message:
            kind === 'code' ? 'buscando candidatos en el código…' : 'segmentando los documentos…',
          startedAt: new Date(now).toISOString(),
          units: 0,
          llmCalls: 0,
          plannedCalls: 0,
          chunkSize,
          rejections: [],
          model: model ?? llm.llm.model,
          cancelRequested: false,
          batchAvailable: false,
        },
        listeners: new Set(),
        lastActivity: now,
      };
      jobs.set(id, record);
      runningJobId = id;

      // Detached on purpose: the candidate scan is synchronous, so running it
      // inline would delay this response until the whole repo had been walked.
      setTimeout(() => {
        void runJob(record, {
          core,
          extractors,
          llm: llm.llm,
          kind,
          source,
          root,
          chunkSize,
          ...(payload.maxCandidates !== undefined ? { maxCandidates: payload.maxCandidates } : {}),
          ...(payload.paths !== undefined ? { paths: payload.paths } : {}),
          ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
        });
      }, 0);

      const body: ExtractStartResponse = { job: { ...record.snapshot } };
      return c.json(body, 202);
    }),
  );

  interface JobPlan {
    core: CoreModule;
    extractors: ExtractorsModule;
    llm: LlmClient;
    kind: ExtractKind;
    source: ResolvedSource;
    root: string;
    chunkSize: number;
    maxCandidates?: number;
    paths?: string[];
    branch?: string | boolean;
  }

  /** Per-job progress/cancellation decorator around the engine client. */
  const progressLlm = (record: JobRecord, llm: LlmClient): LlmClient =>
    new ProgressLlmClient(
      llm,
      () => {
        record.snapshot.llmCalls++;
        record.snapshot.message = `${record.snapshot.llmCalls}/${record.snapshot.plannedCalls} llamadas al agente…`;
        emit(record);
      },
      () => record.snapshot.cancelRequested,
    );

  /** The whole pipeline for one job: scan → LLM chunks → import → commit. */
  async function runJob(record: JobRecord, plan: JobPlan): Promise<void> {
    const { core, extractors, kind, source, root, chunkSize } = plan;
    const snapshot = record.snapshot;
    const finish = (phase: ExtractPhase, message: string): void => {
      snapshot.phase = phase;
      snapshot.message = message;
      snapshot.finishedAt = new Date().toISOString();
      if (runningJobId === snapshot.id) runningJobId = null;
      emit(record);
    };

    try {
      // ---- Phase 1: candidates / sections (no LLM) ----
      let units: number;
      let pass: () => Promise<EnginePass>;
      if (kind === 'code') {
        const candidates = scanCode(extractors, root, source, {
          ...(plan.maxCandidates !== undefined ? { maxCandidates: plan.maxCandidates } : {}),
          ...(plan.paths !== undefined ? { paths: plan.paths } : {}),
        });
        // Locators pin the source commit when the source repo is a git repo,
        // exactly like `untacit extract code`.
        const commit = core.isGitRepo(root)
          ? core.gitRevParse(root, 'HEAD').slice(0, 12)
          : undefined;
        units = candidates.length;
        pass = () =>
          extractors.extractFromCandidates(progressLlm(record, plan.llm), candidates, {
            chunkSize,
            ...(commit !== undefined ? { commit } : {}),
          });
      } else {
        const loaded = await loadSections(extractors, root, source);
        if (loaded.skipped.length > 0) snapshot.skipped = loaded.skipped;
        units = loaded.sections.length;
        pass = () =>
          extractors.extractFromSections(progressLlm(record, plan.llm), loaded.sections, {
            sectionsPerCall: chunkSize,
          });
      }

      snapshot.units = units;
      snapshot.plannedCalls = Math.ceil(units / chunkSize);
      if (units === 0) {
        finish(
          'done',
          kind === 'code'
            ? 'sin candidatos de lógica de negocio: nada que extraer'
            : 'sin secciones legibles en esta fuente: nada que extraer',
        );
        return;
      }

      // ---- Phase 2: LLM calls ----
      snapshot.phase = 'extracting';
      snapshot.message = `0/${snapshot.plannedCalls} llamadas al agente…`;
      emit(record);
      const result = await pass();
      record.batch = result.batch;
      snapshot.batchAvailable = true;
      snapshot.rejections = result.rejections;
      snapshot.llmCalls = result.llmCalls;

      // A cancel that arrived during the LAST (or only) chunk never reaches the
      // wrapper's pre-call check, so honor it here: cancelling must never end
      // in a commit the user asked not to make. The batch stays retrievable —
      // that call was paid for.
      if (snapshot.cancelRequested) {
        finish(
          'cancelled',
          `cancelada tras ${snapshot.llmCalls} llamada(s) al agente — nada se importó; el batch sigue disponible`,
        );
        return;
      }

      if (result.batch.nodes.length === 0 && result.batch.edges.length === 0) {
        finish(
          'done',
          `${result.llmCalls} llamada(s) al agente sin nodos ni aristas válidos: revisa los rechazos`,
        );
        return;
      }

      // ---- Phase 3: import (validator → resolver → files → commit) ----
      snapshot.phase = 'importing';
      snapshot.message = `importando ${result.batch.nodes.length} nodos y ${result.batch.edges.length} aristas…`;
      emit(record);
      const branch =
        plan.branch === undefined || plan.branch === false
          ? undefined
          : typeof plan.branch === 'string' && plan.branch.trim() !== ''
            ? plan.branch.trim()
            : `run/${result.batch.run_id}`;
      // reindex: false — the sidecar's own index reindexes on the next read,
      // so there is never a second SQLite writer (same as POST /api/import).
      // serializeWrite — a job's import lands long after the request that
      // started it, so it queues behind any other graph write in flight.
      const imported = await serializeWrite(() =>
        core.importBatch(repoRoot, result.batch, {
          reindex: false,
          ...(branch !== undefined ? { branch } : {}),
        }),
      );
      snapshot.result = {
        runId: imported.runId,
        stats: imported.stats,
        rejections: imported.rejections,
        proposals: imported.proposals,
        commit: imported.commit,
        branch: imported.branch,
        noop: imported.noop,
        batchNodes: result.batch.nodes.length,
        batchEdges: result.batch.edges.length,
      };
      finish(
        'done',
        imported.noop
          ? `run ${imported.runId}: sin cambios (re-extracción idéntica)`
          : `run ${imported.runId} importado`,
      );
    } catch (err) {
      if (err instanceof ExtractCancelled) {
        finish(
          'cancelled',
          `cancelada tras ${snapshot.llmCalls} llamada(s) al agente — la extracción parcial se descarta`,
        );
        return;
      }
      snapshot.error = err instanceof Error ? err.message : String(err);
      if (record.batch === undefined) {
        finish('error', 'la extracción falló');
        return;
      }
      // The extraction cost real LLM calls — never lose the batch to an import
      // failure the user can fix and retry. The in-memory copy is not enough:
      // it goes with the job TTL, the 20-job cap or a sidecar restart. The CLI
      // writes untacit-batch-<run_id>.json to the cwd; here it goes under
      // .untacit/ (gitignored derived state) so it cannot dirty the graph repo.
      const rescue = rescueBatch(record.batch);
      snapshot.rescuePath = rescue;
      finish(
        'error',
        rescue !== undefined
          ? `el import falló; el batch está guardado en ${rescue} — arregla el problema e impórtalo`
          : 'el import falló; el batch sigue disponible para reintentarlo (GET /api/extract/:id/batch)',
      );
    }
  }

  /** Write a failed run's batch next to the index, returning its path. */
  function rescueBatch(batch: ExtractionBatch): string | undefined {
    try {
      const dir = join(repoRoot, '.untacit', 'rescue');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `untacit-batch-${batch.run_id}.json`);
      writeFileSync(path, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
      return path;
    } catch {
      // /api/extract/:id/batch is still the fallback; never mask the real error.
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/extract — remembered jobs, newest first (the view remounts).
  // ---------------------------------------------------------------------------
  app.get(
    '/api/extract',
    route((c) => {
      const body: ExtractJobsResponse = {
        jobs: [...jobs.values()]
          .map((job) => ({ ...job.snapshot }))
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
        runningJobId,
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /api/extract/:id — one snapshot (polling).
  // ---------------------------------------------------------------------------
  app.get(
    '/api/extract/:id',
    route((c) => c.json({ ...jobOf(c).snapshot } satisfies ExtractJob)),
  );

  // ---------------------------------------------------------------------------
  // GET /api/extract/:id/batch — the emitted batch, verbatim. Survives an
  // import failure so the user can fix the problem and import it by hand.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/extract/:id/batch',
    route((c) => {
      const job = jobOf(c);
      if (job.batch === undefined) {
        return c.json(
          { error: `extraction job "${job.snapshot.id}" has no batch yet` } satisfies ApiError,
          404,
        );
      }
      return c.json(job.batch);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/extract/:id/cancel — request an abort. Takes effect before the
  // next LLM call; an in-flight `claude` invocation is left to finish.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/extract/:id/cancel',
    route((c) => {
      const job = jobOf(c);
      if (!isTerminal(job.snapshot.phase) && !job.snapshot.cancelRequested) {
        job.snapshot.cancelRequested = true;
        job.snapshot.message = 'cancelando: se aborta antes de la siguiente llamada al agente…';
        emit(job);
      }
      return c.json({ ...job.snapshot } satisfies ExtractJob);
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /api/extract/:id/events — the same snapshots as SSE, ending on the
  // terminal phase. Equivalent to polling; cheaper for a long run.
  // ---------------------------------------------------------------------------
  app.get('/api/extract/:id/events', (c) => {
    const id = c.req.param('id') ?? '';
    const job = jobs.get(id);
    if (job === undefined) {
      return c.json({ error: `extraction job "${id}" not found` } satisfies ApiError, 404);
    }
    return streamSSE(c, async (stream) => {
      // Current state first (a late subscriber must not wait for the next
      // tick), then every emit. Registration happens in the same synchronous
      // stretch as the snapshot copy, so no update can slip between them.
      const pending: ExtractJob[] = [{ ...job.snapshot }];
      let wake: (() => void) | undefined;
      let aborted = false;
      const listener = (snapshot: ExtractJob): void => {
        pending.push(snapshot);
        wake?.();
      };
      job.listeners.add(listener);
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      try {
        for (;;) {
          while (pending.length > 0) {
            const snapshot = pending.shift()!;
            await stream.writeSSE({ event: 'job', data: JSON.stringify(snapshot) });
            if (isTerminal(snapshot.phase)) return;
          }
          if (aborted) return;
          await new Promise<void>((resolveWake) => {
            wake = resolveWake;
          });
          wake = undefined;
        }
      } finally {
        job.listeners.delete(listener);
      }
    });
  });
}
