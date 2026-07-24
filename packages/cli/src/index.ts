/**
 * untacit CLI (docs/03 §2): init | import | index | embed | stats | search |
 * diff | conflicts | doctor | extract | interview | serve-mcp | update.
 * Thin composition over @untacit/core and @untacit/extractors.
 *
 * Command groups live under commands/ (graph lifecycle, queries, extraction,
 * interview); doctor and update keep their own modules; this file only
 * assembles the program.
 */

import { resolve } from 'node:path';

import { Command } from 'commander';
import pc from 'picocolors';

import { registerExtractCommands } from './commands/extract.js';
import { registerGraphCommands } from './commands/graph.js';
import { cliVersion, graphRoot, positiveInt } from './commands/helpers.js';
import { registerInterviewCommand } from './commands/interview.js';
import { registerQueryCommands } from './commands/query.js';
import { EXIT_FINDINGS, emitJson, unicodeOk } from './output.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('untacit')
    .description('Grafo ontológico de la lógica de negocio: extracción con evidencia, índice local y consulta.')
    .version(cliVersion());

  registerGraphCommands(program);
  registerQueryCommands(program);

  program
    .command('doctor')
    .option('--graph <dir>', 'graph repo to inspect (adds config/git/index/embeddings checks)')
    .option('--json', 'print the checks as JSON to stdout', false)
    .option('--offline', 'skip all network access (no update check)', false)
    .description('Diagnose the environment: git, claude engine, install freshness and, with --graph, the graph repo (exit code 2 on failures)')
    .action(async (opts: { graph?: string; json: boolean; offline: boolean }) => {
      const { defaultDoctorDeps, doctorChecks, formatDoctorText } = await import('./doctor.js');
      const checks = await doctorChecks(
        {
          ...(opts.graph !== undefined ? { graph: resolve(opts.graph) } : {}),
          offline: opts.offline,
        },
        await defaultDoctorDeps(),
      );
      if (checks.some((c) => c.status === 'fail')) process.exitCode = EXIT_FINDINGS;
      if (opts.json) {
        emitJson({ ok: !checks.some((c) => c.status === 'fail'), checks });
        return;
      }
      console.log(formatDoctorText(checks, unicodeOk()));
    });

  registerExtractCommands(program);
  registerInterviewCommand(program);

  program
    .command('update')
    .option('--ref <branch|tag>', 'version to update to', 'main')
    .option('--check', 'only report whether a newer version exists, change nothing', false)
    .option('--force', 'update even if the install checkout has local changes', false)
    .description('Update this untacit install in place (git fetch + rebuild of the install checkout)')
    .action(async (opts: { ref: string; check: boolean; force: boolean }) => {
      const { runUpdate } = await import('./update.js');
      await runUpdate(opts);
    });

  program
    .command('serve-mcp')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--write', 'enable the write surface: untacit_import_batch + review actions (merges, conflicts) over MCP', false)
    .option('--http', 'serve streamable HTTP on /mcp instead of stdio', false)
    .option('--port <n>', 'HTTP port (with --http)', '8765')
    .option('--host <host>', 'HTTP bind address (with --http)', '127.0.0.1')
    .description('Start the untacit MCP server (stdio, or streamable HTTP con --http) over this graph repo')
    .action(async (opts: { graph: string; write: boolean; http: boolean; port: string; host: string }) => {
      const mcp = await import('@untacit/mcp');
      const repo = graphRoot(opts);
      if (opts.http) {
        const port = positiveInt(opts.port, '--port');
        await mcp.serveMcpHttp(repo, { write: opts.write, port, host: opts.host });
        console.error(pc.dim(`untacit MCP (streamable HTTP) en http://${opts.host}:${port}/mcp${opts.write ? ' [write]' : ''}`));
        // Keep the process alive: the HTTP server holds the event loop open.
        return;
      }
      await mcp.serveMcp(repo, { write: opts.write });
    });

  return program;
}
