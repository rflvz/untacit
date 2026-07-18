/**
 * "Locator clicable" (docs/04 Fase 2): resolve an evidence locator to a local
 * file using the graph repo's untacit.config.json sources, and build the
 * command(s) that open it in the user's editor.
 *
 * Command priority:
 *   1. UNTACIT_OPEN_CMD — whitespace-separated template, `{path}` / `{line}`
 *      placeholders (e.g. `code -g {path}:{line}`, `subl {path}:{line}`).
 *   2. VS Code (`code --goto path:line`), jumping straight to the line.
 *   3. The OS opener (xdg-open / open / start), no line support.
 * The executor tries them in order, falling through on spawn errors, so a
 * machine without `code` still opens the file with the OS default app.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import type { UntacitConfig, SourceType } from '@untacit/core';

export interface OpenTarget {
  /** Absolute path of the local file. */
  path: string;
  /** 1-based line to jump to (code locators only). */
  line?: number;
}

/**
 * Resolve an evidence locator to a local file.
 * Throws with a "not found"-style message (mapped to 404 by the API) when the
 * locator cannot be resolved on this machine.
 */
export function resolveOpenTarget(
  repoRoot: string,
  config: UntacitConfig,
  sourceType: SourceType,
  locator: Record<string, unknown>,
): OpenTarget {
  switch (sourceType) {
    case 'code':
      return resolveCodeTarget(repoRoot, config, locator);
    case 'document':
      return resolveDocumentTarget(repoRoot, config, locator);
    default:
      throw new Error(`evidence of type "${sourceType}" has no local file to open`);
  }
}

function resolveCodeTarget(
  repoRoot: string,
  config: UntacitConfig,
  locator: Record<string, unknown>,
): OpenTarget {
  const repo = typeof locator['repo'] === 'string' ? locator['repo'] : undefined;
  const relPath = typeof locator['path'] === 'string' ? locator['path'] : undefined;
  if (repo === undefined || relPath === undefined) {
    throw new Error('code locator must have string "repo" and "path" fields');
  }
  const source = config.sources.code.find((s) => s.name === repo);
  if (source === undefined) {
    throw new Error(
      `source repo "${repo}" not found in untacit.config.json (sources.code); add it with its local path`,
    );
  }
  const base = resolve(repoRoot, source.path);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`locator path "${relPath}" escapes the source root of "${repo}"`);
  }
  if (!existsSync(target)) {
    throw new Error(`file not found: ${target} (source "${repo}"; did the file move?)`);
  }
  const line = typeof locator['line_start'] === 'number' ? locator['line_start'] : undefined;
  return line !== undefined ? { path: target, line } : { path: target };
}

function resolveDocumentTarget(
  repoRoot: string,
  config: UntacitConfig,
  locator: Record<string, unknown>,
): OpenTarget {
  const docId = typeof locator['doc_id'] === 'string' ? locator['doc_id'] : undefined;
  if (docId === undefined) {
    throw new Error('document locator must have a string "doc_id" field');
  }
  if (config.sources.documents.length === 0) {
    throw new Error(
      `document "${docId}" not found: no document sources configured in untacit.config.json`,
    );
  }
  for (const source of config.sources.documents) {
    const base = resolve(repoRoot, source.path);
    if (!existsSync(base)) continue;
    const match = findByBasename(base, docId);
    if (match !== undefined) return { path: match };
  }
  throw new Error(
    `document "${docId}" not found under the configured document sources`,
  );
}

/** Depth-first search for a file whose basename (without extension) is `id`. */
function findByBasename(dir: string, id: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findByBasename(full, id);
      if (found !== undefined) return found;
    } else if (basename(entry.name, extname(entry.name)) === id) {
      return full;
    }
  }
  return undefined;
}

export interface OpenCommandOptions {
  /** UNTACIT_OPEN_CMD template, if set. */
  template?: string;
  platform?: NodeJS.Platform;
}

/** Candidate commands (argv arrays) to open the target, in priority order. */
export function buildOpenCommands(target: OpenTarget, opts: OpenCommandOptions = {}): string[][] {
  const platform = opts.platform ?? process.platform;
  const line = target.line ?? 1;
  const commands: string[][] = [];

  if (opts.template !== undefined && opts.template.trim() !== '') {
    commands.push(
      opts.template
        .trim()
        .split(/\s+/)
        .map((token) => token.replaceAll('{path}', target.path).replaceAll('{line}', String(line))),
    );
  }

  commands.push(['code', '--goto', `${target.path}:${line}`]);

  if (platform === 'darwin') commands.push(['open', target.path]);
  else if (platform === 'win32') commands.push(['cmd', '/c', 'start', '', target.path]);
  else commands.push(['xdg-open', target.path]);

  return commands;
}

export type OpenExecutor = (commands: string[][]) => Promise<string[]>;

/**
 * Default executor: try each command until one spawns successfully; resolve
 * with the command that ran. Only spawn errors (binary missing) fall through.
 */
export const spawnOpenExecutor: OpenExecutor = (commands) =>
  new Promise((resolvePromise, rejectPromise) => {
    const tryNext = (i: number): void => {
      if (i >= commands.length) {
        rejectPromise(new Error('no opener available (set UNTACIT_OPEN_CMD)'));
        return;
      }
      const [bin, ...args] = commands[i];
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => tryNext(i + 1));
      child.once('spawn', () => {
        child.unref();
        resolvePromise(commands[i]);
      });
    };
    tryNext(0);
  });
