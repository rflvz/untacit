/**
 * Candidate location for extractor-code (docs/03 §4.1): find code fragments
 * likely to contain business logic before spending LLM calls on them.
 *
 * v1 uses line-level heuristics (conditionals, business constants, domain
 * error messages) — deliberately simple and dependency-free. tree-sitter (or
 * a CodeGraph index when present) is the planned upgrade for symbol-accurate
 * candidate spans; the Candidate shape already carries everything it needs.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Candidate {
  repo: string;
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  /** Heuristic signals that fired, for debugging prompt/candidate quality. */
  signals: string[];
}

export interface ScanOptions {
  repoName: string;
  include?: RegExp;
  exclude?: RegExp;
  /** Lines of context around a signal hit. */
  context?: number;
  maxCandidates?: number;
  /**
   * Repo-relative files or directories to scan instead of the whole repo —
   * partial re-extraction over the paths a merge changed (docs/03 §5).
   * Paths that no longer exist are skipped silently: a deleted file after a
   * merge is normal input, not an error.
   */
  paths?: string[];
}

const SIGNAL_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'conditional-validation', pattern: /\b(if|switch|when)\b.*(cliente|pedido|factura|precio|importe|descuento|aprobaci|prepag|recargo|customer|order|invoice|price|discount|approv|payment)/i },
  { name: 'business-constant', pattern: /\b(const|final|static)\b.*=\s*[0-9][0-9_.]*\s*[;,]?\s*(\/\/|\/\*|#)?.*(€|eur|umbral|limite|threshold|max|min|pct|porcentaje|percent)?/i },
  { name: 'reject-throw', pattern: /\b(throw|reject|abort|deny|block)\w*\s*\(/i },
  { name: 'domain-error-message', pattern: /["'`][^"'`]*(no se puede|no permitido|requiere|debe |bloqueado|rechazado|not allowed|requires|must )[^"'`]*["'`]/i },
  { name: 'calculation', pattern: /\b(calcular?|calc|compute|aplicar|apply)\w*\s*\(/i },
];

const DEFAULT_INCLUDE = /\.(ts|tsx|js|jsx|py|java|cs|go|rb|php)$/;
const DEFAULT_EXCLUDE = /(node_modules|dist|build|\.git|test|spec|__tests__|migrations|vendor)/;

export function scanRepo(rootDir: string, opts: ScanOptions): Candidate[] {
  const include = opts.include ?? DEFAULT_INCLUDE;
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const context = opts.context ?? 8;
  const max = opts.maxCandidates ?? 200;

  const candidates: Candidate[] = [];
  const files = listFiles(rootDir, include, exclude, opts.paths);

  for (const file of files) {
    if (candidates.length >= max) break;
    const lines = readFileSync(file, 'utf8').split('\n');
    let blockedUntil = -1;
    for (let i = 0; i < lines.length; i++) {
      if (i <= blockedUntil) continue;
      const signals = SIGNAL_PATTERNS.filter((s) => s.pattern.test(lines[i]!)).map((s) => s.name);
      if (signals.length === 0) continue;
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + context);
      candidates.push({
        repo: opts.repoName,
        path: relative(rootDir, file),
        line_start: start + 1,
        line_end: end + 1,
        snippet: lines.slice(start, end + 1).join('\n'),
        signals,
      });
      blockedUntil = end;
      if (candidates.length >= max) break;
    }
  }
  return candidates;
}

/** Absolute file list to scan: the whole repo, or only `paths` when given. */
function listFiles(
  rootDir: string,
  include: RegExp,
  exclude: RegExp,
  paths?: string[],
): string[] {
  if (paths === undefined) return walk(rootDir, include, exclude);
  const out = new Set<string>();
  for (const rel of paths) {
    const full = join(rootDir, rel);
    if (exclude.test(full)) continue;
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // deleted or renamed away by the merge — nothing to scan
    }
    if (stats.isDirectory()) {
      for (const file of walk(full, include, exclude)) out.add(file);
    } else if (include.test(full)) {
      out.add(full);
    }
  }
  return [...out].sort();
}

function walk(dir: string, include: RegExp, exclude: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (exclude.test(full)) continue;
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full, include, exclude));
    } else if (include.test(entry)) {
      out.push(full);
    }
  }
  return out;
}
