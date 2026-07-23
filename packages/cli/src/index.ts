/**
 * untacit CLI (docs/03 §2): init | import | index | embed | stats | search |
 * diff | conflicts | extract | interview | serve-mcp | update. Thin
 * composition over @untacit/core and @untacit/extractors.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REVIEW_THRESHOLD,
  GraphIndex,
  buildEmbeddings,
  buildIndex,
  createEmbeddingProvider,
  diffRefs,
  diffWorkingTree,
  formatDiffText,
  importBatch,
  initGraphRepo,
  interviewSessionPath,
  listRuns,
  loadConfig,
} from '@untacit/core';
import type { EmbeddingProvider, EmbeddingsConfig } from '@untacit/core';
import { Command } from 'commander';
import pc from 'picocolors';

import { EXIT_FINDINGS, emitJson, stdoutIsInteractive, unicodeOk } from './output.js';
import { createInterviewUi } from './ui.js';

function graphRoot(opts: { graph?: string }): string {
  return resolve(opts.graph ?? process.cwd());
}

/**
 * Branch for an extraction-as-PR import: `--branch name` uses the name,
 * bare `--branch` derives `run/<run_id>` from the batch, absent → undefined.
 */
function runBranchName(flag: string | boolean | undefined, batchJson: unknown): string | undefined {
  if (flag === undefined || flag === false) return undefined;
  if (typeof flag === 'string') return flag;
  const runId =
    typeof batchJson === 'object' && batchJson !== null && 'run_id' in batchJson
      ? String((batchJson as { run_id: unknown }).run_id)
      : 'batch';
  return `run/${runId}`;
}

/** Parse a numeric CLI option strictly: a positive integer or a loud error. */
function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Provider for CLI commands: --provider/--model override the repo config;
 * without either, untacit.config.json decides (docs/03 §3).
 */
async function providerFor(
  repo: string,
  opts: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const config = loadConfig(repo)?.embeddings;
  const merged: EmbeddingsConfig = {
    provider: (opts.provider ?? config?.provider ?? 'auto') as EmbeddingsConfig['provider'],
    ...(opts.model ?? config?.model ? { model: opts.model ?? config?.model } : {}),
  };
  return createEmbeddingProvider(merged);
}

/** Version from the package manifest (works from dist/ and from src/ under tsx). */
function cliVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('untacit')
    .description('Grafo ontológico de la lógica de negocio: extracción con evidencia, índice local y consulta.')
    .version(cliVersion());

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

  program
    .command('interview')
    .requiredOption('--graph <dir>', 'graph repo directory')
    .option('--role <rol>', 'rol de la persona entrevistada (nunca su nombre)')
    .option('--model <id>', 'LLM model for the interviewer agent')
    .option(
      '--gaps-only',
      'print coverage gaps and verification targets as JSON and exit (no LLM call)',
      false,
    )
    .option('--resume', 'retomar una entrevista interrumpida de este graph repo (sin transcripción: solo rol, guion y propuestas)', false)
    .description(
      'Entrevista agéntica en terminal: guion desde huecos del grafo, triples en vivo con aceptar/rechazar, verificación cruzada (docs/03 §4.3)',
    )
    .action(async (opts: { graph: string; role?: string; model?: string; gapsOnly: boolean; resume: boolean }) => {
      const extractors = await import('@untacit/extractors');
      const repo = graphRoot(opts);
      const sessionPath = interviewSessionPath(repo);

      // Validate the cheap preconditions before opening/reindexing the index.
      const role = opts.role?.trim() ?? '';
      if (!opts.gapsOnly) {
        if (opts.resume && !existsSync(sessionPath)) {
          throw new Error(
            `no hay ninguna sesión de entrevista interrumpida en ${sessionPath} — arranca una nueva sin --resume`,
          );
        }
        if (role === '' && !opts.resume) {
          throw new Error('--role es obligatorio (rol de la persona entrevistada, nunca su nombre)');
        }
        const engine = extractors.claudeCodeAvailable();
        if (!engine.ok) {
          throw new Error(`el agente entrevistador corre sobre Claude Code y no está disponible: ${engine.detail}`);
        }
      }

      const index = GraphIndex.open(repo);
      let gaps: ReturnType<typeof extractors.findCoverageGaps>;
      let verifications: ReturnType<typeof extractors.verificationTargets>;
      try {
        gaps = extractors.findCoverageGaps(index, 12);
        verifications = extractors.verificationTargets(index, 5);
      } finally {
        index.close();
      }
      if (opts.gapsOnly) {
        console.log(JSON.stringify({ gaps, verifications }, null, 2));
        return;
      }

      const llm = new extractors.ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
      const ui = createInterviewUi({ tty: stdoutIsInteractive(), unicode: unicodeOk() });

      let state: ReturnType<typeof extractors.startInterview>;
      if (opts.resume) {
        const persisted = JSON.parse(readFileSync(sessionPath, 'utf8')) as { version?: unknown };
        if (persisted.version !== 1) {
          throw new Error(
            `versión de sesión desconocida en ${sessionPath} — bórrala o actualiza untacit (untacit update)`,
          );
        }
        const snapshot = persisted as unknown as Parameters<typeof extractors.resumeInterview>[0];
        if (role !== '' && role !== snapshot.state.speakerRole) {
          throw new Error(
            `la sesión guardada es del rol "${snapshot.state.speakerRole}" — retómala sin --role, o con ese mismo rol`,
          );
        }
        state = extractors.resumeInterview(snapshot);
        console.log(pc.dim(`sesión retomada (guardada ${snapshot.savedAt})`));
      } else {
        if (existsSync(sessionPath)) {
          const confirm = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (
              await confirm.question(
                pc.yellow(
                  'hay una sesión de entrevista interrumpida en este grafo (retómala con --resume). ¿Empezar una nueva y descartarla? [s/N] ',
                ),
              )
            )
              .trim()
              .toLowerCase();
            if (!(answer === 's' || answer === 'si' || answer === 'sí')) {
              console.log(pc.dim('sesión conservada — retómala con: untacit interview --resume --graph …'));
              return;
            }
          } finally {
            confirm.close();
          }
          rmSync(sessionPath, { force: true });
        }
        console.log(pc.dim(`${gaps.length} huecos detectados en el grafo`));
        const spin = ui.spinner('generando guion');
        let script: string[];
        try {
          script = await extractors.generateScript(llm, gaps);
          spin.stop();
        } catch (err) {
          spin.stop();
          throw err;
        }
        const interviewId = `int-${Date.now().toString(36)}`;
        state = extractors.startInterview(interviewId, role, { script, verifications });
      }

      ui.banner(cliVersion(), repo, state.speakerRole);

      // Save after every turn (atomic tmp+rename): a crash or Ctrl+C loses at
      // most the answer in flight, and the generated script — an LLM spend —
      // survives from the very first write. Transcript is never persisted.
      const saveSession = (): void => {
        mkdirSync(dirname(sessionPath), { recursive: true });
        const tmp = `${sessionPath}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(extractors.serializeInterview(state), null, 2)}\n`, 'utf8');
        renameSync(tmp, sessionPath);
      };
      saveSession();

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        // Cross-verification pass (docs/03 §4.3.5) before the open conversation.
        // Only still-pending ones: a resumed session skips what was resolved.
        for (const proposal of state.proposals.filter(
          (p) => p.kind === 'verification' && p.status === 'proposed',
        )) {
          const v = proposal.verification!;
          const answer = (
            await rl.question(
              `${pc.yellow(`${ui.mood('verifying')} verificar`)} ${proposal.statement} (confianza ${v.confidence}) — [c]onfirmar / [r]efutar / ENTER salta: `,
            )
          )
            .trim()
            .toLowerCase();
          const verdict = answer.startsWith('c') ? 'confirm' : answer.startsWith('r') ? 'refute' : 'skip';
          extractors.resolveVerification(state, proposal.id, verdict);
          saveSession();
        }

        console.log('');
        ui.agentSays(state.transcript[0]!.text);
        console.log(pc.dim('Responde al agente. ":fin" termina la sesión y guarda lo aceptado.\n'));

        for (;;) {
          const answer = (await rl.question(pc.bold('tú > '))).trim();
          if (answer === '') continue;
          if (answer === ':fin' || answer === '/fin') break;

          // A transient LLM failure must not kill the session: processAnswer
          // leaves the state untouched on error, so the user just retries.
          // The spinner stops before anything else prints — it owns the line.
          const spin = ui.spinner('pensando');
          let outcome: Awaited<ReturnType<typeof extractors.processAnswer>>;
          try {
            outcome = await extractors.processAnswer(llm, state, answer);
            spin.stop();
          } catch (err) {
            spin.stop();
            console.log(
              pc.yellow(
                `error del LLM (${err instanceof Error ? err.message : String(err)}) — la sesión sigue: reintenta la respuesta o cierra con ":fin"`,
              ),
            );
            continue;
          }
          if (outcome.proposals.length > 0) {
            console.log(pc.dim('propuestas de este turno:'));
            for (const p of outcome.proposals) {
              console.log(`  ${pc.cyan(p.id)} ${p.statement}`);
            }
            const selection = (
              await rl.question('aceptar (ids separados por espacio, "todo", ENTER = decidir al final): ')
            ).trim();
            if (selection.toLowerCase() === 'todo') {
              for (const p of outcome.proposals) extractors.acceptProposal(state, p.id);
              ui.celebrate(outcome.proposals.length);
            } else if (selection !== '') {
              let accepted = 0;
              for (const id of selection.split(/\s+/)) {
                try {
                  extractors.acceptProposal(state, id);
                  accepted++;
                } catch (err) {
                  console.log(pc.yellow(err instanceof Error ? err.message : String(err)));
                }
              }
              ui.celebrate(accepted);
            }
          }
          saveSession();
          ui.agentSays(outcome.reply);
          console.log('');
          if (outcome.finished) {
            console.log(pc.dim('El guion está cubierto; puedes seguir hablando o cerrar con ":fin".'));
          }
        }

        const pending = state.proposals.filter(
          (p) => p.kind !== 'verification' && p.status === 'proposed',
        );
        if (pending.length > 0) {
          const bulk = (
            await rl.question(
              `Quedan ${pending.length} propuestas pendientes. ¿Aceptarlas todas? [s/N] `,
            )
          )
            .trim()
            .toLowerCase();
          if (bulk === 's' || bulk === 'si' || bulk === 'sí') {
            ui.celebrate(extractors.acceptAll(state).length);
          }
        }
      } finally {
        // Belt and braces: whatever path leaves this block, the last state is
        // on disk (the success paths below delete the file afterwards).
        try {
          saveSession();
        } catch {
          /* saving must never mask the original error */
        }
        rl.close();
      }

      const batch = extractors.finishInterview(state);
      if (batch.nodes.length === 0 && batch.edges.length === 0) {
        rmSync(sessionPath, { force: true });
        console.log(pc.dim('nada aceptado — la sesión no se importa'));
        return;
      }
      try {
        const imported = await importBatch(repo, batch);
        const s = imported.stats;
        for (const issue of imported.rejections) {
          console.log(`${pc.yellow('rejected')} ${issue.path}: ${issue.message}`);
        }
        console.log(
          `${pc.green('run ' + imported.runId)}: +${s.nodes_created}/~${s.nodes_updated} nodes, ` +
            `+${s.edges_created}/~${s.edges_updated} edges, +${s.evidence_added} evidence`,
        );
        if (imported.commit) console.log(pc.dim(`  commit ${imported.commit.slice(0, 10)}`));
        // Only a successful close removes the resumable session.
        rmSync(sessionPath, { force: true });
      } catch (err) {
        // The session cost a real conversation — never lose the batch to an
        // import failure the user can fix and retry. The session file stays
        // resumable too (--resume) in case they prefer to keep talking.
        const rescue = resolve(`untacit-batch-${batch.run_id}.json`);
        writeFileSync(rescue, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
        console.error(
          pc.yellow(`import failed; batch saved to ${rescue} — fix the problem and re-run: untacit import ${rescue} --graph ...`),
        );
        throw err;
      }
    });

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
