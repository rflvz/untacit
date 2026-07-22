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

/** Mirror of UpdateInfo (src-tauri/src/updater.rs). */
export interface UpdateInfo {
  /** Version of the running app. */
  current: string;
  /** Latest published release (no leading `v`). */
  latest: string;
  updateAvailable: boolean;
  /** Release page (fallback install path). */
  pageUrl: string;
  /** Direct download of the Windows installer, when the release has one. */
  installerUrl: string | null;
}

/** Ask GitHub Releases whether a newer version exists (null in the browser). */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop) return null;
  return invoke<UpdateInfo>('check_update');
}

/**
 * Apply the available update: on Windows this downloads and launches the
 * installer (the app quits); elsewhere the release page opens in the browser.
 */
export async function installUpdate(): Promise<void> {
  if (!isDesktop) return;
  await invoke('install_update');
}

/**
 * Subscribe to the silent startup update check (src-tauri/src/updater.rs).
 * Returns an unsubscribe function.
 */
export function onUpdateAvailable(handler: (info: UpdateInfo) => void): () => void {
  if (!isDesktop) return () => {};
  const unlisten = listen<UpdateInfo>('untacit://update-available', (event) =>
    handler(event.payload),
  );
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
