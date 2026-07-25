/**
 * Serializer for everything that writes the graph repo.
 *
 * Every write ends in a git commit (docs/03 §7 point 3) and starts from a
 * `GraphStore.load` snapshot of the canonical files. Two of them overlapping
 * would race: the second load can happen before the first has written, so the
 * second write silently drops the first one's changes, and both then commit.
 *
 * That used to be near-impossible — each write was one short click-driven
 * request. Extraction jobs changed it: an import can land minutes after the
 * request that started it, while the user accepts a merge or finishes an
 * interview. The sidecar is a single process, so a promise chain is enough;
 * it is a separate module so the ordering property can be tested directly.
 */

export interface WriteQueue {
  /**
   * Run `work` after every previously queued unit has settled. Callers get
   * their own result (or their own rejection) back; a failed unit never blocks
   * or fails the next one.
   */
  <T>(work: () => Promise<T> | T): Promise<T>;
}

export function createWriteQueue(): WriteQueue {
  // The tail always resolves: each link swallows its own outcome so one failed
  // write cannot poison the queue for whatever comes after it.
  let tail: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
