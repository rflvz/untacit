import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gitCommitAll,
  gitInit,
  gitLastCommits,
  gitListFilesAtRef,
  gitRevParse,
  gitShowFile,
  gitStatusClean,
  isGitRepo,
} from './git.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
}

function write(root: string, rel: string, content: string): void {
  const filePath = path.join(root, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('isGitRepo / gitInit', () => {
  it('is false for a plain directory and for a missing path', () => {
    const dir = tmpDir();
    expect(isGitRepo(dir)).toBe(false);
    expect(isGitRepo(path.join(dir, 'does-not-exist'))).toBe(false);
  });

  it('is true after gitInit, which also creates missing directories', () => {
    const dir = path.join(tmpDir(), 'nested', 'graph-repo');
    gitInit(dir);
    expect(isGitRepo(dir)).toBe(true);
  });
});

describe('gitCommitAll / gitStatusClean', () => {
  it('returns null when there is nothing to commit (idempotence check)', () => {
    const dir = tmpDir();
    gitInit(dir);
    expect(gitCommitAll(dir, 'empty')).toBeNull();

    write(dir, 'a.txt', 'hello\n');
    const hash = gitCommitAll(dir, 'first');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(gitStatusClean(dir)).toBe(true);

    // Clean tree — a second commit attempt must be a no-op returning null.
    expect(gitCommitAll(dir, 'noop')).toBeNull();
    expect(gitRevParse(dir, 'HEAD')).toBe(hash);
  });

  it('stages modifications, deletions and untracked files in one commit', () => {
    const dir = tmpDir();
    gitInit(dir);
    write(dir, 'keep.txt', 'v1\n');
    write(dir, 'gone.txt', 'bye\n');
    gitCommitAll(dir, 'first');

    write(dir, 'keep.txt', 'v2\n');
    write(dir, 'new.txt', 'hi\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    expect(gitStatusClean(dir)).toBe(false);

    const hash = gitCommitAll(dir, 'second');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(gitStatusClean(dir)).toBe(true);
    expect(gitListFilesAtRef(dir, 'HEAD')).toEqual(['keep.txt', 'new.txt']);
  });

  it('never shell-interprets the commit message', () => {
    const dir = tmpDir();
    gitInit(dir);
    write(dir, 'a.txt', 'x\n');
    const message = `run "B"; $(touch ${path.join(dir, 'pwned')}) 'quotes' & | > redirect`;
    gitCommitAll(dir, message);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
    expect(gitLastCommits(dir, 1)[0]!.subject).toBe(message);
  });
});

describe('gitRevParse', () => {
  it('resolves refs to full hashes and throws on unknown refs', () => {
    const dir = tmpDir();
    gitInit(dir);
    write(dir, 'a.txt', '1\n');
    const first = gitCommitAll(dir, 'first')!;
    write(dir, 'a.txt', '2\n');
    const second = gitCommitAll(dir, 'second')!;

    expect(gitRevParse(dir, 'HEAD')).toBe(second);
    expect(gitRevParse(dir, 'HEAD~1')).toBe(first);
    expect(() => gitRevParse(dir, 'no-such-ref')).toThrow();
  });
});

describe('gitListFilesAtRef / gitShowFile', () => {
  it('lists files at a ref, optionally under a prefix, sorted', () => {
    const dir = tmpDir();
    gitInit(dir);
    write(dir, 'graph/rule/rule-x.md', 'rule\n');
    write(dir, 'graph/entity/entity-y.md', 'entity\n');
    write(dir, 'runs/2026-07-13.json', '{}\n');
    gitCommitAll(dir, 'first');

    expect(gitListFilesAtRef(dir, 'HEAD')).toEqual([
      'graph/entity/entity-y.md',
      'graph/rule/rule-x.md',
      'runs/2026-07-13.json',
    ]);
    expect(gitListFilesAtRef(dir, 'HEAD', 'graph')).toEqual([
      'graph/entity/entity-y.md',
      'graph/rule/rule-x.md',
    ]);
  });

  it('shows file content at a ref and returns null when absent', () => {
    const dir = tmpDir();
    gitInit(dir);
    write(dir, 'a.txt', 'version 1\n');
    const first = gitCommitAll(dir, 'first')!;
    write(dir, 'a.txt', 'version 2\n');
    gitCommitAll(dir, 'second');

    expect(gitShowFile(dir, 'HEAD', 'a.txt')).toBe('version 2\n');
    expect(gitShowFile(dir, first, 'a.txt')).toBe('version 1\n');
    expect(gitShowFile(dir, 'HEAD', 'missing.txt')).toBeNull();
    expect(gitShowFile(dir, first, 'graph/rule/rule-x.md')).toBeNull();
  });
});

describe('gitLastCommits', () => {
  it('returns the last n commits, newest first, with ISO dates', () => {
    const dir = tmpDir();
    gitInit(dir);
    const hashes: string[] = [];
    for (const n of [1, 2, 3]) {
      write(dir, 'a.txt', `${n}\n`);
      hashes.push(gitCommitAll(dir, `commit ${n}`)!);
    }

    const last2 = gitLastCommits(dir, 2);
    expect(last2).toHaveLength(2);
    expect(last2[0]).toMatchObject({ hash: hashes[2], subject: 'commit 3' });
    expect(last2[1]).toMatchObject({ hash: hashes[1], subject: 'commit 2' });
    expect(Number.isNaN(Date.parse(last2[0]!.date))).toBe(false);

    expect(gitLastCommits(dir, 10)).toHaveLength(3);
  });

  it('returns [] for a repo without commits and for n <= 0', () => {
    const dir = tmpDir();
    gitInit(dir);
    expect(gitLastCommits(dir, 5)).toEqual([]);
    write(dir, 'a.txt', 'x\n');
    gitCommitAll(dir, 'first');
    expect(gitLastCommits(dir, 0)).toEqual([]);
  });
});
