/** Read/query commands: search | conflicts | diff. */

import { GraphIndex, diffRefs, diffWorkingTree, formatDiffText } from '@untacit/core';
import type { Command } from 'commander';
import pc from 'picocolors';

import { EXIT_FINDINGS, emitJson } from '../output.js';
import { graphRoot, positiveInt, providerFor } from './helpers.js';

export function registerQueryCommands(program: Command): void {
  program
    .command('search')
    .argument('<query>', 'search query')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--types <types>', 'comma-separated node types filter')
    .option('--limit <n>', 'max results', '20')
    .option('--mode <mode>', 'fts | semantic | hybrid', 'fts')
    .option('--provider <p>', 'embedding provider override: auto | hash | transformers | none')
    .option('--model <id>', 'model id for the transformers provider')
    .option('--json', 'print the results as JSON to stdout', false)
    .description('Search nodes: full-text (FTS5), semantic (embeddings) or hybrid (RRF fusion)')
    .action(
      async (
        query: string,
        opts: {
          graph: string;
          types?: string;
          limit: string;
          mode: string;
          provider?: string;
          model?: string;
          json: boolean;
        },
      ) => {
        if (!['fts', 'semantic', 'hybrid'].includes(opts.mode)) {
          throw new Error(`unknown --mode "${opts.mode}" — expected fts | semantic | hybrid`);
        }
        const repo = graphRoot(opts);
        const index = GraphIndex.open(repo);
        try {
          const searchOpts = {
            types: opts.types?.split(',') as never,
            limit: positiveInt(opts.limit, '--limit'),
          };
          let results;
          if (opts.mode === 'fts') {
            results = index.search(query, searchOpts);
          } else {
            const provider = await providerFor(repo, opts);
            if (provider === null && opts.mode === 'semantic') {
              const note =
                'semantic search needs an embedding provider — pass --provider hash|transformers or set `embeddings` in untacit.config.json';
              if (opts.json) {
                console.error(note);
                emitJson([]);
              } else {
                console.log(pc.yellow(note));
              }
              return;
            }
            if (provider !== null) await index.updateEmbeddings(provider);
            results =
              opts.mode === 'semantic'
                ? await index.semanticSearch(query, provider!, searchOpts)
                : await index.hybridSearch(query, provider, searchOpts);
          }
          if (opts.json) {
            emitJson(results);
            return;
          }
          if (results.length === 0) {
            console.log(pc.dim('no results'));
            return;
          }
          for (const r of results) {
            console.log(`${pc.cyan(r.type.padEnd(8))} ${pc.bold(r.id)}  ${r.summary}`);
          }
        } finally {
          index.close();
        }
      },
    );

  program
    .command('conflicts')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--json', 'print the conflicts as JSON to stdout', false)
    .description('Open contradictions with their opposing evidence (exit code 2 when any are open)')
    .action((opts: { graph: string; json: boolean }) => {
      const index = GraphIndex.open(graphRoot(opts));
      try {
        const conflicts = index.conflicts();
        // Findings, not an error: scripts/CI can branch on `untacit conflicts`
        // without parsing output. exitCode (not process.exit) lets stdout flush.
        if (conflicts.length > 0) process.exitCode = EXIT_FINDINGS;
        if (opts.json) {
          emitJson(conflicts);
          return;
        }
        if (conflicts.length === 0) {
          console.log(pc.green('no open conflicts'));
          return;
        }
        for (const c of conflicts) {
          console.log(pc.red(pc.bold(`${c.nodeId} -${c.edgeType}-> ${c.target}`)));
          for (const ev of c.supporting) {
            console.log(`  ${pc.green('+')} [${ev.source_type}] "${ev.excerpt}"`);
          }
          for (const ev of c.contradicting) {
            console.log(`  ${pc.red('-')} [${ev.source_type}] "${ev.excerpt}"`);
          }
        }
      } finally {
        index.close();
      }
    });

  program
    .command('diff')
    .argument('[refA]', 'older git ref of the graph repo')
    .argument('[refB]', 'newer git ref (default: working tree vs refA/HEAD)')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--json', 'print the diff as JSON to stdout', false)
    .description('Drift between two refs of the graph repo, in ontology terms')
    .action((refA: string | undefined, refB: string | undefined, opts: { graph: string; json: boolean }) => {
      const repo = graphRoot(opts);
      const diff = refA && refB ? diffRefs(repo, refA, refB) : diffWorkingTree(repo, refA ?? 'HEAD');
      if (opts.json) {
        emitJson(diff);
        return;
      }
      console.log(formatDiffText(diff));
    });
}
