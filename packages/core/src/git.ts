/**
 * Git plumbing for the graph repo (docs/03 §5).
 *
 * With repo-first storage the history machinery is delegated to git: one run
 * == one commit, drift == git diff between refs (presented in ontology terms
 * by ../diff), and idempotence is verified with `git status`.
 *
 * Every call shells out to `git` via execFileSync with an argument vector —
 * never through a shell, never with string interpolation. Refs supplied by
 * callers are terminated with `--end-of-options` where git accepts it, so a
 * ref can never be parsed as an option.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

/** Run git in `dir`, returning stdout; throws (with stderr captured) on failure. */
function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    // Capture stderr instead of inheriting it: failures are expected control
    // flow in places (gitShowFile on an absent path) and must stay silent.
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** True when `dir` exists and is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** Initialize a git repository at `dir` (creating the directory if needed). */
export function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
}

/**
 * Stage everything and commit. Uses a fallback identity
 * (-c user.name=untacit -c user.email=untacit@localhost) so it works in
 * bare environments without global git config. Returns the new commit hash,
 * or null when there is nothing to commit — the pipeline uses that null as
 * its idempotence check (docs/03 §3: re-extracting with unchanged sources
 * leaves the working tree clean).
 */
export function gitCommitAll(dir: string, message: string): string | null {
  git(dir, ['add', '-A']);
  if (git(dir, ['status', '--porcelain']).trim() === '') return null;
  git(dir, [
    '-c',
    'user.name=untacit',
    '-c',
    'user.email=untacit@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Current branch name, or null on a detached HEAD / unborn repository.
 */
export function gitCurrentBranch(dir: string): string | null {
  try {
    const out = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** True when a local branch with this exact name exists. */
export function gitBranchExists(dir: string, branch: string): boolean {
  try {
    git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Create `branch` at the current HEAD and switch to it. Throws if it already exists. */
export function gitCreateBranch(dir: string, branch: string): void {
  git(dir, ['checkout', '--quiet', '-b', branch]);
}

/** Switch the working tree to an existing branch or ref. */
export function gitCheckout(dir: string, ref: string): void {
  // checkout has no --end-of-options; the trailing `--` keeps the ref from
  // being read as a pathspec.
  git(dir, ['checkout', '--quiet', ref, '--']);
}

/** True when `git status --porcelain` reports no changes (staged, unstaged or untracked). */
export function gitStatusClean(dir: string): boolean {
  return git(dir, ['status', '--porcelain']).trim() === '';
}

/** Resolve a ref (branch, tag, HEAD~n, commit…) to its full hash. Throws on unknown refs. */
export function gitRevParse(dir: string, ref: string): string {
  return git(dir, ['rev-parse', '--verify', '--end-of-options', ref]).trim();
}

/**
 * Paths of all files present at `ref`, optionally restricted to `prefix`
 * (e.g. "graph"). Sorted, repo-relative, NUL-safe.
 */
export function gitListFilesAtRef(dir: string, ref: string, prefix?: string): string[] {
  const args = ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', ref];
  if (prefix !== undefined) args.push('--', prefix);
  return git(dir, args)
    .split('\0')
    .filter((p) => p.length > 0)
    .sort();
}

/** Content of `path` as stored at `ref`, or null when the file is absent at that ref. */
export function gitShowFile(dir: string, ref: string, path: string): string | null {
  try {
    return git(dir, ['show', '--end-of-options', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The last `n` commits, newest first: hash, subject and strict-ISO committer
 * date. Returns [] for a repository without commits.
 */
export function gitLastCommits(
  dir: string,
  n: number,
): { hash: string; subject: string; date: string }[] {
  const count = Math.floor(n);
  if (count <= 0) return [];
  let out: string;
  try {
    // %x1f (unit separator) cannot appear in a commit subject line.
    out = git(dir, ['log', `--max-count=${count}`, '--pretty=format:%H%x1f%s%x1f%cI']);
  } catch {
    return []; // no commits yet (unborn HEAD)
  }
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = '', subject = '', date = ''] = line.split('\u001f');
      return { hash, subject, date };
    });
}
