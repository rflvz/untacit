/** Extraction commands: extract code | extract docs (docs/03 §4.1–4.2). */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { importBatch } from '@untacit/core';
import type { Command } from 'commander';
import pc from 'picocolors';

import { graphRoot, positiveInt, runBranchName } from './helpers.js';

export function registerExtractCommands(program: Command): void {
  const extract = program
    .command('extract')
    .description('Run an extraction agent over source material and emit a batch');

  extract
    .command('code')
    .argument('<repoDir>', 'source code repository to scan')
    .option('--graph <dir>', 'graph repo directory (required with --import)')
    .option('--repo-name <name>', 'repo name recorded in code locators (default: directory name)')
    .option(
      '--paths <paths...>',
      'repo-relative files/dirs to scan instead of the whole repo (partial re-extraction over changed paths)',
    )
    .option('--candidates-only', 'print the heuristic candidates as JSON and exit (no LLM call)', false)
    .option('--max-candidates <n>', 'cap on candidates scanned', '50')
    .option('--out <file>', 'write the extraction batch JSON to a file (default: stdout)')
    .option('--import', 'import the batch into the graph repo after extraction', false)
    .option(
      '--branch [name]',
      'with --import: commit the run on a new branch (extraction-as-PR; default name run/<run_id>)',
    )
    .option('--model <id>', 'LLM model for the extraction agent')
    .option('--chunk-size <n>', 'candidates grouped per LLM call', '8')
    .description('Extract business logic from a source repo (candidates → agent → batch, docs/03 §4.1)')
    .action(
      async (
        repoDir: string,
        opts: {
          graph?: string;
          repoName?: string;
          paths?: string[];
          candidatesOnly: boolean;
          maxCandidates: string;
          out?: string;
          import: boolean;
          branch?: string | boolean;
          model?: string;
          chunkSize: string;
        },
      ) => {
        const { ClaudeCodeLlmClient, claudeCodeAvailable, extractFromCandidates, scanRepo } =
          await import('@untacit/extractors');
        const { gitRevParse, isGitRepo } = await import('@untacit/core');

        const root = resolve(repoDir);
        const repoName = opts.repoName ?? root.split('/').filter(Boolean).pop() ?? root;
        const candidates = scanRepo(root, {
          repoName,
          maxCandidates: positiveInt(opts.maxCandidates, '--max-candidates'),
          ...(opts.paths !== undefined ? { paths: opts.paths } : {}),
        });
        if (opts.candidatesOnly) {
          console.log(JSON.stringify(candidates, null, 2));
          return;
        }
        if (opts.import && opts.graph === undefined) {
          throw new Error('--import requires --graph <dir>');
        }
        if (candidates.length === 0) {
          console.error(pc.dim('no business-logic candidates found — nothing to extract'));
          return;
        }

        const engine = claudeCodeAvailable();
        if (!engine.ok) {
          throw new Error(`el motor de extracción es Claude Code y no está disponible: ${engine.detail}`);
        }
        const llm = new ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
        const commit = isGitRepo(root) ? gitRevParse(root, 'HEAD').slice(0, 12) : undefined;
        const result = await extractFromCandidates(llm, candidates, {
          chunkSize: positiveInt(opts.chunkSize, '--chunk-size'),
          ...(commit !== undefined ? { commit } : {}),
        });
        for (const issue of result.rejections) {
          console.error(`${pc.yellow('rejected')} ${issue.path}: ${issue.message}`);
        }
        console.error(
          pc.dim(
            `${candidates.length} candidates, ${result.llmCalls} LLM calls → ${result.batch.nodes.length} nodes, ${result.batch.edges.length} edges`,
          ),
        );
        const json = JSON.stringify(result.batch, null, 2);
        if (opts.out !== undefined) {
          writeFileSync(resolve(opts.out), `${json}\n`, 'utf8');
          console.error(pc.green(`batch written to ${resolve(opts.out)}`));
        } else if (!opts.import) {
          console.log(json);
        }
        if (opts.import) {
          const branch = runBranchName(opts.branch, result.batch);
          try {
            const imported = await importBatch(graphRoot({ graph: opts.graph }), result.batch, {
              ...(branch !== undefined ? { branch } : {}),
            });
            const s = imported.stats;
            console.log(
              `${pc.green('run ' + imported.runId)}: +${s.nodes_created}/~${s.nodes_updated} nodes, +${s.edges_created}/~${s.edges_updated} edges, +${s.evidence_added} evidence`,
            );
            if (imported.commit) {
              console.log(
                pc.dim(
                  `  commit ${imported.commit.slice(0, 10)}${imported.branch ? ` on branch ${imported.branch} (push it and open a PR to review the change)` : ''}`,
                ),
              );
            }
          } catch (err) {
            // The extraction cost real LLM calls — never lose the batch to an
            // import failure the user can fix and retry.
            if (opts.out === undefined) {
              const rescue = resolve(`untacit-batch-${result.batch.run_id}.json`);
              writeFileSync(rescue, `${json}\n`, 'utf8');
              console.error(pc.yellow(`import failed; batch saved to ${rescue} — fix the problem and re-run: untacit import ${rescue} --graph ...`));
            }
            throw err;
          }
        }
      },
    );

  extract
    .command('docs')
    .argument('<files...>', 'source documents (.md, .markdown, .txt, .pdf, .docx)')
    .option('--graph <dir>', 'graph repo directory (required with --import)')
    .option('--sections-only', 'print the segmented sections as JSON and exit (no LLM call)', false)
    .option('--out <file>', 'write the extraction batch JSON to a file (default: stdout)')
    .option('--import', 'import the batch into the graph repo after extraction', false)
    .option('--model <id>', 'LLM model for the extraction agent')
    .option('--sections-per-call <n>', 'sections grouped per LLM call', '4')
    .description('Extract business logic from documents (locator per section/page, docs/03 §4.2)')
    .action(
      async (
        files: string[],
        opts: {
          graph?: string;
          sectionsOnly: boolean;
          out?: string;
          import: boolean;
          model?: string;
          sectionsPerCall: string;
        },
      ) => {
        const { ClaudeCodeLlmClient, claudeCodeAvailable, extractFromSections, loadDocumentSections, slugifyDocId } =
          await import('@untacit/extractors');
        const sections = [];
        // doc_id per file, deduplicated: two "manual.md" in different folders
        // must not share provenance.
        const usedDocIds = new Set<string>();
        for (const file of files) {
          const base = slugifyDocId(file);
          let docId = base;
          for (let n = 2; usedDocIds.has(docId); n++) docId = `${base}-${n}`;
          usedDocIds.add(docId);
          sections.push(...(await loadDocumentSections(resolve(file), { docId })));
        }
        if (opts.sectionsOnly) {
          console.log(JSON.stringify(sections, null, 2));
          return;
        }
        if (opts.import && opts.graph === undefined) {
          throw new Error('--import requires --graph <dir>');
        }

        const engine = claudeCodeAvailable();
        if (!engine.ok) {
          throw new Error(`el motor de extracción es Claude Code y no está disponible: ${engine.detail}`);
        }
        const llm = new ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
        const result = await extractFromSections(llm, sections, {
          sectionsPerCall: positiveInt(opts.sectionsPerCall, '--sections-per-call'),
        });
        for (const issue of result.rejections) {
          console.error(`${pc.yellow('rejected')} ${issue.path}: ${issue.message}`);
        }
        console.error(
          pc.dim(
            `${sections.length} sections, ${result.llmCalls} LLM calls → ${result.batch.nodes.length} nodes, ${result.batch.edges.length} edges`,
          ),
        );
        const json = JSON.stringify(result.batch, null, 2);
        if (opts.out !== undefined) {
          writeFileSync(resolve(opts.out), `${json}\n`, 'utf8');
          console.error(pc.green(`batch written to ${resolve(opts.out)}`));
        } else if (!opts.import) {
          console.log(json);
        }
        if (opts.import) {
          try {
            const imported = await importBatch(graphRoot({ graph: opts.graph }), result.batch);
            const s = imported.stats;
            console.log(
              `${pc.green('run ' + imported.runId)}: +${s.nodes_created}/~${s.nodes_updated} nodes, +${s.edges_created}/~${s.edges_updated} edges, +${s.evidence_added} evidence`,
            );
          } catch (err) {
            // The extraction cost real LLM calls — never lose the batch to an
            // import failure the user can fix and retry.
            if (opts.out === undefined) {
              const rescue = resolve(`untacit-batch-${result.batch.run_id}.json`);
              writeFileSync(rescue, `${json}\n`, 'utf8');
              console.error(pc.yellow(`import failed; batch saved to ${rescue} — fix the problem and re-run: untacit import ${rescue} --graph ...`));
            }
            throw err;
          }
        }
      },
    );
}
