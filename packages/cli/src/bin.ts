#!/usr/bin/env node
import { buildProgram } from './index.js';
import { EXIT_ERROR } from './output.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_ERROR);
  });
