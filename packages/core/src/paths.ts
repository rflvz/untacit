/**
 * Graph-repo layout (docs/03 §3).
 *
 * <graph-repo>/
 *   untacit.config.json
 *   graph/<type>/<id>.md          one markdown file per node
 *   runs/<run-id>.json            run metadata
 *   merges.json                   merge proposals + reversible merge records
 *   .untacit/index.db             derived SQLite index (gitignored)
 */

import { join } from 'node:path';
import type { NodeType } from './types.js';

export const CONFIG_FILE = 'untacit.config.json';
export const GRAPH_DIR = 'graph';
export const RUNS_DIR = 'runs';
export const MERGES_FILE = 'merges.json';
export const INDEX_DIR = '.untacit';
export const INDEX_DB = 'index.db';

export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_FILE);
}

export function graphDir(repoRoot: string): string {
  return join(repoRoot, GRAPH_DIR);
}

export function nodeTypeDir(repoRoot: string, type: NodeType): string {
  return join(repoRoot, GRAPH_DIR, type);
}

export function nodeFilePath(repoRoot: string, type: NodeType, id: string): string {
  return join(repoRoot, GRAPH_DIR, type, `${id}.md`);
}

export function runsDir(repoRoot: string): string {
  return join(repoRoot, RUNS_DIR);
}

export function runFilePath(repoRoot: string, runId: string): string {
  return join(repoRoot, RUNS_DIR, `${runId}.json`);
}

export function mergesFilePath(repoRoot: string): string {
  return join(repoRoot, MERGES_FILE);
}

export function indexDbPath(repoRoot: string): string {
  return join(repoRoot, INDEX_DIR, INDEX_DB);
}
