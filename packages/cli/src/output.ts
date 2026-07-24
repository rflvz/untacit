/**
 * CLI output conventions (Claude Code-style agent friendliness):
 * - exit codes: 0 ok, 1 execution error, 2 = the command worked and FOUND
 *   something (open conflicts, doctor failures, update available);
 * - `--json` puts machine-readable JSON on stdout and every human log on
 *   stderr, so `untacit … --json | jq` never sees ANSI or prose;
 * - color itself needs no handling here: picocolors already honours
 *   NO_COLOR/FORCE_COLOR and TTY detection.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

/** stdout is a live terminal (spinners/banners allowed). */
export function stdoutIsInteractive(): boolean {
  return process.stdout.isTTY === true && process.env['TERM'] !== 'dumb';
}

/** stdin is a live terminal (interactive prompts allowed). */
export function stdinIsInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * The locale advertises UTF-8, so box-drawing/spinner glyphs are safe.
 * Same criterion as install.sh; WT_SESSION covers Windows Terminal, where
 * the POSIX locale variables are normally absent.
 */
export function unicodeOk(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /utf-?8/i.test(locale) || env['WT_SESSION'] !== undefined;
}

/** The one place JSON hits stdout: pretty-printed, newline-terminated. */
export function emitJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
