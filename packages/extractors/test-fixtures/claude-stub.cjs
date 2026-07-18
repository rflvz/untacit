#!/usr/bin/env node
/**
 * Test stub for the Claude Code CLI (ClaudeCodeLlmClient tests).
 *
 * Mimics `claude -p --output-format json`: reads the prompt from stdin and
 * prints a result envelope. The envelope's `result` echoes back the argv and
 * the stdin it received, so tests can assert exactly what the client sent.
 *
 * Modes (env CLAUDE_STUB_MODE):
 *   echo (default) — success envelope, result = JSON of {argv, stdin}
 *   error          — success=false envelope (is_error), like a failed run
 *   garbage        — non-JSON stdout
 *   exit1          — nonzero exit with stderr
 */

const mode = process.env.CLAUDE_STUB_MODE ?? 'echo';

if (process.argv[2] === '--version') {
  console.log('9.9.9 (claude-stub)');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  if (mode === 'exit1') {
    process.stderr.write('stub: simulated crash\n');
    process.exit(1);
  }
  if (mode === 'garbage') {
    process.stdout.write('not json at all\n');
    process.exit(0);
  }
  if (mode === 'error') {
    process.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'simulated engine error' })}\n`,
    );
    process.exit(0);
  }
  const result = JSON.stringify({ argv: process.argv.slice(2), stdin });
  process.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })}\n`,
  );
});
