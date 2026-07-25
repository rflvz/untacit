/**
 * Unit tests for the graph-write serializer (sidecar/write-queue.ts).
 *
 * These assert the property directly, because the HTTP-level version cannot:
 * whether two concurrent /api/import requests actually interleave depends on
 * where importBatch happens to yield, so a route test can pass with the queue
 * removed. What matters is the guarantee itself — no unit starts before the
 * previous one has settled — so it is tested where it lives.
 */

import { describe, expect, it } from 'vitest';
import { createWriteQueue } from './write-queue.js';

/** A unit of work that records when it entered and left. */
function tracked(log: string[], name: string, ticks = 3) {
  return async (): Promise<string> => {
    log.push(`${name}:start`);
    // Several await points: an unqueued competitor would slot in here.
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    log.push(`${name}:end`);
    return name;
  };
}

describe('write queue', () => {
  it('never lets one unit start before the previous has finished', async () => {
    const queue = createWriteQueue();
    const log: string[] = [];

    const results = await Promise.all([
      queue(tracked(log, 'a')),
      queue(tracked(log, 'b')),
      queue(tracked(log, 'c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    // Strictly non-overlapping, in submission order.
    expect(log).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
    ]);
  });

  it('interleaves without the queue — the failure the queue prevents', async () => {
    // The control case: the same units run unserialized, and they overlap.
    const log: string[] = [];
    await Promise.all([tracked(log, 'a')(), tracked(log, 'b')()]);
    expect(log).toEqual(['a:start', 'b:start', 'a:end', 'b:end']);
  });

  it('does not start a queued unit until an in-flight one resolves', async () => {
    const queue = createWriteQueue();
    let releaseFirst = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = false;

    const first = queue(async () => {
      await gate;
      return 'first';
    });
    const second = queue(() => {
      secondRan = true;
      return 'second';
    });

    // Give the microtask queue plenty of turns: the second unit must still be
    // waiting, because the first has not settled.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(secondRan).toBe(false);

    releaseFirst();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(secondRan).toBe(true);
  });

  it('isolates failures: the caller sees its own rejection, the queue survives', async () => {
    const queue = createWriteQueue();
    const log: string[] = [];

    const failing = queue(async () => {
      log.push('failing');
      await Promise.resolve();
      throw new Error('import falló');
    });
    const after = queue(tracked(log, 'after'));

    await expect(failing).rejects.toThrow('import falló');
    expect(await after).toBe('after');
    expect(log).toEqual(['failing', 'after:start', 'after:end']);

    // A synchronous throw is contained the same way.
    const sync = queue(() => {
      throw new Error('boom');
    });
    await expect(sync).rejects.toThrow('boom');
    expect(await queue(() => 'still working')).toBe('still working');
  });

  it('accepts synchronous work and keeps it in order with async work', async () => {
    const queue = createWriteQueue();
    const log: string[] = [];

    const results = await Promise.all([
      queue(tracked(log, 'slow', 5)),
      queue(() => {
        log.push('sync');
        return 'sync';
      }),
    ]);

    expect(results).toEqual(['slow', 'sync']);
    expect(log).toEqual(['slow:start', 'slow:end', 'sync']);
  });
});
