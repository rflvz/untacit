/**
 * Bridge to the Tauri shell (src-tauri/src/commands.rs). Every entry point
 * is gated on `isDesktop`, so the same bundle serves the plain-browser dev
 * flow (`pnpm dev`), where these helpers just return null / no-op.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Mirror of ShellStateDto (src-tauri/src/commands.rs). */
export interface ShellState {
  /** Absolute path of the active graph repo (null → welcome screen). */
  repo: string | null;
  /** Most-recently-used graph repos, newest first. */
  recent: string[];
  /** A Node.js ≥ 20 runtime was found for the sidecar. */
  nodeOk: boolean;
  /** Debug shell (`tauri dev`): `pnpm dev` owns the sidecar. */
  devMode: boolean;
  sidecarRunning: boolean;
}

export async function shellState(): Promise<ShellState | null> {
  if (!isDesktop) return null;
  return invoke<ShellState>('shell_state');
}

/** Native folder picker; resolves null when the user cancels. */
export async function pickRepo(): Promise<ShellState | null> {
  if (!isDesktop) return null;
  return invoke<ShellState | null>('pick_repo');
}

/** Switch to a known repo path (the recents list). */
export async function setRepo(path: string): Promise<ShellState | null> {
  if (!isDesktop) return null;
  return invoke<ShellState>('set_repo', { path });
}

/** Reveal the active graph repo in the OS file manager. */
export async function openRepoFolder(): Promise<void> {
  if (!isDesktop) return;
  await invoke('open_repo_folder');
}

/**
 * Subscribe to repo switches coming from outside the webview (tray menu).
 * Returns an unsubscribe function.
 */
export function onRepoChanged(handler: (state: ShellState) => void): () => void {
  if (!isDesktop) return () => {};
  const unlisten = listen<ShellState>('untacit://repo-changed', (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** Last path segment, handling both separators (the shell may run on Windows). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
