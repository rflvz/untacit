#!/usr/bin/env node
/**
 * untacit benchmark (CodeGraph style): the same 10 business questions from
 * evals/evals.json answered by an agent twice —
 *
 *   A. WITH untacit: Claude Code in print mode connected ONLY to the
 *      untacit MCP server (strict MCP config, allowedTools restricted to the
 *      read-only untacit_* query tools, no filesystem/web). Same isolation as
 *      the Fase 5 gate recorded in ../evals/RESULTS.md.
 *   B. WITHOUT untacit: same engine, no tools at all.
 *
 * A judge invocation grades each answer against the eval's expected_answer.
 * The run reports accuracy and agent turns per condition and writes
 * benchmark/results.md.
 *
 * Engine: the local Claude Code CLI (no API key, consistent with the rest of
 * untacit — docs/03 §4). Exits 0 with a notice when `claude` is not
 * available, so it can be invoked unconditionally. Binary override:
 * UNTACIT_CLAUDE_BIN; model override: UNTACIT_BENCH_MODEL.
 *
 * Requires a previous `pnpm build`.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

const BIN = process.env.UNTACIT_CLAUDE_BIN ?? 'claude';
const MODEL = process.env.UNTACIT_BENCH_MODEL; // undefined → Claude Code's default

try {
  execFileSync(BIN, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  console.log(
    `Claude Code CLI not available ("${BIN}") — skipping the agentic benchmark ` +
      '(the deterministic evals still run in CI via evals/run.mjs). ' +
      'Install Claude Code or set UNTACIT_CLAUDE_BIN.',
  );
  process.exit(0);
}

const core = await import(pathToFileURL(join(root, 'packages/core/dist/index.js')));

// ---------------------------------------------------------------------------
// Graph repo + MCP config
// ---------------------------------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), 'acme-bench-'));
core.initGraphRepo(repo);
for (const file of [
  '01-code.json',
  '02-docs.json',
  '03-interview.json',
  '04-code-extended.json',
  '05-docs-extended.json',
  '06-interview-produccion.json',
]) {
  const batch = JSON.parse(readFileSync(join(here, '../batches', file), 'utf8'));
  await core.importBatch(repo, batch, { now: new Date('2026-07-14T12:00:00Z') });
}

const mcpConfigPath = join(repo, 'mcp-config.json');
writeFileSync(
  mcpConfigPath,
  JSON.stringify({
    mcpServers: {
      untacit: { command: 'node', args: [join(root, 'packages/mcp/dist/bin.js'), '--graph', repo] },
    },
  }),
  'utf8',
);

const UNTACIT_TOOLS = [
  'untacit_context',
  'untacit_explore',
  'untacit_impact',
  'untacit_paths',
  'untacit_similar',
  'untacit_evidence',
  'untacit_diff',
  'untacit_conflicts',
]
  .map((t) => `mcp__untacit__${t}`)
  .join(',');

// ---------------------------------------------------------------------------
// Claude Code print-mode invocations
// ---------------------------------------------------------------------------

async function claude(prompt, extraArgs) {
  const args = ['--print', '--output-format', 'json', ...extraArgs];
  if (MODEL) args.push('--model', MODEL);
  const child = execFileAsync(BIN, args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  child.child.stdin?.write(prompt);
  child.child.stdin?.end();
  const { stdout } = await child;
  const envelope = JSON.parse(stdout);
  if (envelope.is_error === true || envelope.subtype !== 'success') {
    throw new Error(`Claude Code error (${envelope.subtype ?? 'unknown'}): ${envelope.result?.slice(0, 300) ?? ''}`);
  }
  return { answer: envelope.result ?? '', turns: envelope.num_turns ?? 1 };
}

const QUESTION_PREAMBLE =
  'Responde usando EXCLUSIVAMENTE las tools MCP de untacit (no tienes acceso a las fuentes ni al sistema de ' +
  'ficheros). Sé conciso y cita los ids de nodo. Pregunta: ';

function answerWithUntacit(question) {
  return claude(QUESTION_PREAMBLE + question, [
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    UNTACIT_TOOLS,
  ]);
}

function answerWithout(question) {
  return claude(
    'Responde sobre la lógica de negocio de Acme Manufactura, una empresa ficticia de embalaje de cartón. ' +
      'No tienes tools ni documentación; responde lo mejor que puedas y di explícitamente cuando no puedas saberlo. ' +
      'Pregunta: ' +
      question,
    ['--strict-mcp-config', '--tools', ''],
  );
}

async function judge(question, expected, candidate) {
  const { answer } = await claude(
    'Evalúa una respuesta contra la verdad de referencia. Contesta SOLO con JSON: {"correct": true|false}. ' +
      '"correct" significa que la respuesta candidata afirma los mismos hechos que la referencia (los ids pueden ' +
      'parafrasearse como nombres); respuestas parciales, evasivas o contradictorias son incorrectas.\n\n' +
      `Pregunta: ${question}\n\nReferencia: ${expected}\n\nCandidata: ${candidate}`,
    ['--strict-mcp-config', '--tools', ''],
  );
  try {
    return Boolean(JSON.parse(answer.replace(/^[^{]*/, '').replace(/[^}]*$/, '')).correct);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const evals = JSON.parse(readFileSync(join(here, '../evals/evals.json'), 'utf8')).evals;
const rows = [];
for (const evalCase of evals) {
  process.stdout.write(`${evalCase.id} … `);
  const withGraph = await answerWithUntacit(evalCase.question);
  const without = await answerWithout(evalCase.question);
  const okWith = await judge(evalCase.question, evalCase.expected_answer, withGraph.answer);
  const okWithout = await judge(evalCase.question, evalCase.expected_answer, without.answer);
  rows.push({ id: evalCase.id, okWith, turns: withGraph.turns, okWithout });
  console.log(
    `with untacit: ${okWith ? 'correct' : 'incorrect'} (${withGraph.turns} turns) | without: ${okWithout ? 'correct' : 'incorrect'}`,
  );
}

rmSync(repo, { recursive: true, force: true });

const correctWith = rows.filter((r) => r.okWith).length;
const correctWithout = rows.filter((r) => r.okWithout).length;
const totalTurns = rows.reduce((n, r) => n + r.turns, 0);

const table = [
  '| Eval | With untacit | Agent turns | Without untacit |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${r.okWith ? '✅' : '❌'} | ${r.turns} | ${r.okWithout ? '✅' : '❌'} |`),
  `| **Total** | **${correctWith}/10** | **${totalTurns}** | **${correctWithout}/10** |`,
].join('\n');

const report = `# untacit benchmark

Same 10 business questions (evals/evals.json), same engine (Claude Code${MODEL ? `, model \`${MODEL}\`` : ''}),
two conditions: an agent with only the untacit MCP query tools (no source access) vs. the bare model.

${table}

Generated by \`benchmark/run-benchmark.mjs\`.
`;
writeFileSync(join(here, 'results.md'), report, 'utf8');
console.log(`\nWith untacit: ${correctWith}/10 (${totalTurns} agent turns) — without: ${correctWithout}/10`);
console.log('Report written to examples/acme-manufactura/benchmark/results.md');
