/**
 * `untacit update` — self-update for installs made by install.sh /
 * install.ps1. Those installers leave the CLI running from inside a git
 * checkout of the monorepo (<root>/packages/cli/dist/bin.js), so updating
 * in place is: git fetch + checkout the ref + reinstall + rebuild — the
 * same steps the installer runs, without re-downloading the installer.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pc from 'picocolors';

export interface UpdateOptions {
  /** Branch or tag to update to (default: main, like the installers). */
  ref: string;
  /** Only report whether a newer version exists; change nothing. */
  check: boolean;
  /** Proceed even if the install checkout has local changes. */
  force: boolean;
}

/**
 * Root of the monorepo checkout this CLI is running from, or null when the
 * layout doesn't match (e.g. a hypothetical npm-registry install). Works
 * both built (<root>/packages/cli/dist/update.js) and under tsx in tests
 * (<root>/packages/cli/src/update.ts): three levels up either way.
 */
export function installRoot(moduleUrl: string = import.meta.url): string | null {
  const here = dirname(fileURLToPath(moduleUrl));
  const root = resolve(here, '..', '..', '..');
  const marker = join(root, 'package.json');
  if (!existsSync(join(root, 'pnpm-workspace.yaml')) || !existsSync(marker)) return null;
  try {
    const pkg = JSON.parse(readFileSync(marker, 'utf8')) as { name?: string };
    return pkg.name === 'untacit-monorepo' ? root : null;
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

/** CLI version recorded at a git ref of the checkout ('?' if unreadable). */
function versionAt(root: string, ref: string): string {
  try {
    const pkg = JSON.parse(git(root, ['show', `${ref}:packages/cli/package.json`])) as {
      version?: string;
    };
    return pkg.version ?? '?';
  } catch {
    return '?';
  }
}

/**
 * Run a build step quietly, installer-style: one line per step, and the
 * command's output only shows up when the step fails.
 */
function runStep(title: string, root: string, cmd: string, args: string[]): void {
  process.stdout.write(pc.dim(`  … ${title}\n`));
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    // pnpm is pnpm.cmd on Windows; a shell is required to spawn it there.
    shell: process.platform === 'win32',
  });
  if (result.error) throw new Error(`${title}: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-25)
      .join('\n');
    throw new Error(`${title} failed (exit ${result.status}):\n${tail}`);
  }
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const root = installRoot();
  if (root === null) {
    throw new Error(
      'this untacit is not running from an install checkout — reinstall it with install.sh / install.ps1 (see the README) and `untacit update` will work from then on',
    );
  }
  if (!existsSync(join(root, '.git'))) {
    throw new Error(
      `the install checkout at ${root} is not a git repo — reinstall with install.sh / install.ps1 to make it updatable`,
    );
  }

  const current = git(root, ['rev-parse', 'HEAD']);
  const currentVersion = versionAt(root, 'HEAD');

  console.log(pc.dim(`install checkout: ${root}`));
  try {
    git(root, ['fetch', '--depth', '1', 'origin', opts.ref]);
  } catch (err) {
    throw new Error(
      `could not fetch origin/${opts.ref} — check your network (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    );
  }
  const remote = git(root, ['rev-parse', 'FETCH_HEAD']);
  const remoteVersion = versionAt(root, 'FETCH_HEAD');

  if (remote === current) {
    console.log(
      `${pc.green('already up to date')} — untacit ${currentVersion} (${current.slice(0, 10)}, ${opts.ref})`,
    );
    return;
  }

  if (opts.check) {
    console.log(
      `${pc.cyan('update available')}: ${currentVersion} (${current.slice(0, 10)}) → ${remoteVersion} (${remote.slice(0, 10)}, ${opts.ref})`,
    );
    console.log(pc.dim('run `untacit update` to apply it'));
    return;
  }

  const dirty = git(root, ['status', '--porcelain']);
  if (dirty !== '' && !opts.force) {
    throw new Error(
      `the install checkout at ${root} has local changes — commit/stash them, or re-run with --force to update anyway (your changes are kept, only HEAD moves)`,
    );
  }
  const branch = (() => {
    try {
      return git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
    } catch {
      return null; // detached HEAD: the normal installer state
    }
  })();
  if (branch !== null) {
    console.log(
      pc.yellow(`note: the checkout is on branch "${branch}"; update detaches HEAD at origin/${opts.ref} (the branch itself is left untouched)`),
    );
  }

  console.log(
    `updating untacit ${currentVersion} (${current.slice(0, 10)}) → ${remoteVersion} (${remote.slice(0, 10)}, ${opts.ref})`,
  );
  git(root, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
  try {
    try {
      runStep('installing workspace dependencies', root, 'pnpm', ['install', '--frozen-lockfile']);
    } catch {
      runStep('installing workspace dependencies (lockfile mismatch, retrying)', root, 'pnpm', ['install']);
    }
    runStep('building packages', root, 'pnpm', ['build']);
  } catch (err) {
    console.error(
      pc.yellow(
        `the update did not complete; to roll back:\n  git -C "${root}" checkout --detach ${current} && pnpm -C "${root}" install && pnpm -C "${root}" build`,
      ),
    );
    throw err;
  }

  const finalVersion = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as {
        version?: string;
      };
      return pkg.version ?? remoteVersion;
    } catch {
      return remoteVersion;
    }
  })();
  console.log(`${pc.green('updated')} — untacit ${finalVersion} (${remote.slice(0, 10)}, ${opts.ref})`);
}
