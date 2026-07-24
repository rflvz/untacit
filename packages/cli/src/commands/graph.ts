/** Graph-repo lifecycle commands: init | import | index | embed | stats. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_REVIEW_THRESHOLD,
  GraphIndex,
  buildEmbeddings,
  buildIndex,
  importBatch,
  initGraphRepo,
  listRuns,
} from '@untacit/core';
import type { Command } from 'commander';
import pc from 'picocolors';

import { emitJson } from '../output.js';
import { graphRoot, providerFor, runBranchName } from './helpers.js';

export function registerGraphCommands(program: Command): void {
  program
    .command('init')
    .argument('<dir>', 'directory for the new graph repo')
    .option('--language <lang>', 'content language of the graph', 'es')
    .option('--no-git', 'skip git initialization')
    .option('--no-agents-md', 'skip the AGENTS.md agent guide in the new repo')
    .description('Create an empty graph repo (config, layout, .gitignore, AGENTS.md, git init)')
    .action((dir: string, opts: { language: string; git: boolean; agentsMd: boolean }) => {
      const target = resolve(dir);
      initGraphRepo(target, { language: opts.language, git: opts.git, agentsMd: opts.agentsMd });
      console.log(`${pc.green('initialized')} graph repo at ${target}`);
    });

  program
    .command('import')
    .argument('<batch>', 'extraction batch JSON file')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--no-commit', 'do not commit the run')
    .option('--no-reindex', 'do not rebuild the derived index')
    .option(
      '--branch [name]',
      'commit the run on a new branch of the graph repo (extraction-as-PR; default name run/<run_id>)',
    )
    .option('--json', 'print the import result as JSON to stdout', false)
    .description('Validate, resolve and materialize an extraction batch into the graph repo')
    .action(async (batchFile: string, opts: { graph: string; commit: boolean; reindex: boolean; branch?: string | boolean; json: boolean }) => {
      const repo = graphRoot(opts);
      const json = JSON.parse(readFileSync(resolve(batchFile), 'utf8')) as unknown;
      const branch = runBranchName(opts.branch, json);
      const result = await importBatch(repo, json, {
        commit: opts.commit,
        reindex: opts.reindex,
        ...(branch !== undefined ? { branch } : {}),
      });
      if (opts.json) {
        emitJson(result);
        return;
      }

      for (const issue of result.rejections) {
        console.log(`${pc.yellow('rejected')} ${issue.path}: ${issue.message}`);
      }
      if (result.noop) {
        console.log(pc.dim(`run ${result.runId}: no changes (idempotent re-import)`));
        return;
      }
      const s = result.stats;
      console.log(
        `${pc.green('run ' + result.runId)}: ` +
          `+${s.nodes_created}/~${s.nodes_updated} nodes, ` +
          `+${s.edges_created}/~${s.edges_updated} edges, ` +
          `+${s.evidence_added} evidence`,
      );
      if (result.commit) {
        console.log(
          pc.dim(
            `  commit ${result.commit.slice(0, 10)}${result.branch ? ` on branch ${result.branch} (push it and open a PR to review the change)` : ''}`,
          ),
        );
      }
      for (const proposal of result.proposals) {
        console.log(
          `${pc.cyan('  merge?')} ${proposal.sourceNodeId} -> ${proposal.targetNodeId} (score ${proposal.score})`,
        );
      }
    });

  program
    .command('index')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--full', 'drop and rebuild from scratch', false)
    .option('--embeddings', 'also refresh the node-embedding cache', false)
    .option('--json', 'print the index result as JSON to stdout', false)
    .description('Rebuild the derived SQLite index from the node files')
    .action(async (opts: { graph: string; full: boolean; embeddings: boolean; json: boolean }) => {
      const repo = graphRoot(opts);
      const result = buildIndex(repo, { full: opts.full });
      if (!opts.json) {
        console.log(`indexed ${result.indexed}, removed ${result.removed}, total ${result.total} nodes`);
      }
      let embeddings = null;
      if (opts.embeddings) {
        const provider = await providerFor(repo, {});
        if (provider === null) {
          const note = 'embeddings disabled (config "none", or "auto" without a local model installed)';
          if (opts.json) console.error(note);
          else console.log(pc.yellow(note));
        } else {
          embeddings = await buildEmbeddings(repo, provider);
          if (!opts.json) {
            console.log(
              `embeddings: ${embeddings.computed} computed, ${embeddings.removed} removed, ${embeddings.total} total (${embeddings.provider})`,
            );
          }
        }
      }
      if (opts.json) emitJson({ ...result, embeddings });
    });

  program
    .command('embed')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--provider <p>', 'embedding provider: auto | hash | transformers | none')
    .option('--model <id>', 'model id for the transformers provider')
    .option('--json', 'print the embedding result as JSON to stdout', false)
    .description('Refresh the node-embedding cache of the derived index (incremental by content hash)')
    .action(async (opts: { graph: string; provider?: string; model?: string; json: boolean }) => {
      const repo = graphRoot(opts);
      const provider = await providerFor(repo, opts);
      if (provider === null) {
        const note = 'embeddings disabled (provider "none", or "auto" without a local model installed)';
        if (opts.json) {
          console.error(note);
          emitJson({ disabled: true });
        } else {
          console.log(pc.yellow(note));
        }
        return;
      }
      const result = await buildEmbeddings(repo, provider);
      if (opts.json) {
        emitJson(result);
        return;
      }
      console.log(
        `embeddings: ${result.computed} computed, ${result.removed} removed, ${result.total} total (${result.provider})`,
      );
    });

  program
    .command('stats')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--json', 'print the metrics as JSON to stdout', false)
    .description('Graph metrics: nodes/edges by type, statuses, conflicts, review queue size')
    .action((opts: { graph: string; json: boolean }) => {
      const index = GraphIndex.open(graphRoot(opts));
      try {
        const s = index.stats();
        if (opts.json) {
          const runs = listRuns(graphRoot(opts));
          emitJson({
            ...s,
            runs: { count: runs.length, last: runs.length > 0 ? runs[runs.length - 1]!.id : null },
          });
          return;
        }
        console.log(pc.bold(`${s.nodes_total} nodes, ${s.edges_total} edges, ${s.evidence_total} evidence`));
        console.log('nodes by type:');
        for (const [type, count] of Object.entries(s.nodes_by_type).sort()) {
          console.log(`  ${type.padEnd(10)} ${count}`);
        }
        console.log('edges by type:');
        for (const [type, count] of Object.entries(s.edges_by_type).sort()) {
          console.log(`  ${type.padEnd(16)} ${count}`);
        }
        console.log(
          `status: ${Object.entries(s.by_status)
            .sort()
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
        console.log(`open conflicts: ${s.conflicts_open === 0 ? '0' : pc.red(String(s.conflicts_open))}`);
        console.log(`edges below review threshold (${DEFAULT_REVIEW_THRESHOLD}): ${s.low_confidence_edges}`);
        const runs = listRuns(graphRoot(opts));
        if (runs.length > 0) console.log(pc.dim(`${runs.length} runs, last: ${runs[runs.length - 1]!.id}`));
      } finally {
        index.close();
      }
    });
}
