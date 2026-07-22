import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { installRoot } from './update.js';

describe('untacit update', () => {
  it('locates the monorepo checkout from the module path', () => {
    const expected = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    expect(installRoot()).toBe(expected);
  });

  it('returns null when the layout is not an install checkout', () => {
    const foreign = pathToFileURL('/definitely/not/here/packages/cli/src/update.ts').href;
    expect(installRoot(foreign)).toBeNull();
  });
});
