/**
 * Pluggable LLM layer. Extractors never call a provider directly — they talk
 * to LlmClient, so tests run against MockLlmClient and the engine can be
 * swapped. The engine is Claude Code (docs/03 §4): completions run through
 * the local `claude` CLI in print mode, inheriting whatever authentication
 * Claude Code already has. There is no direct Anthropic API client and no
 * ANTHROPIC_API_KEY anywhere in untacit — hosts without Claude Code drive
 * extraction and interviews through the MCP server instead.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LlmRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must conform to (embedded in the prompt). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmClient {
  name: string;
  model: string;
  complete(req: LlmRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// Claude Code engine
// ---------------------------------------------------------------------------

/** Resolution order for the claude binary: option > env override > PATH. */
export function claudeCodeBin(bin?: string): string {
  return bin ?? process.env.UNTACIT_CLAUDE_BIN ?? 'claude';
}

/**
 * Is the Claude Code CLI reachable? Cheap probe (`claude --version`), used by
 * the sidecar and the CLI to fail fast with an actionable message instead of
 * erroring mid-conversation.
 */
export function claudeCodeAvailable(bin?: string): { ok: boolean; detail: string } {
  const resolved = claudeCodeBin(bin);
  try {
    const version = execFileSync(resolved, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, detail: version };
  } catch (err) {
    return {
      ok: false,
      detail:
        `no se pudo ejecutar "${resolved}" (${err instanceof Error ? err.message : String(err)}) — ` +
        'instala Claude Code (https://claude.com/claude-code), o define UNTACIT_CLAUDE_BIN, ' +
        'o usa untacit desde Claude Code/Claude Desktop vía MCP',
    };
  }
}

export interface ClaudeCodeClientOptions {
  /** Model override for the session (`claude --model`); default: Claude Code's default. */
  model?: string;
  /** Path to the claude binary; default `claude` on PATH (or UNTACIT_CLAUDE_BIN). */
  bin?: string;
  /** Wall-clock budget per completion. */
  timeoutMs?: number;
}

/** Result envelope of `claude -p --output-format json`. */
interface ClaudeCodeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

/**
 * LlmClient over the Claude Code CLI: one print-mode invocation per
 * completion, all built-in tools disabled (`--tools ""`), prompt over stdin.
 * Schema-first emission is enforced downstream by the core validator; here
 * the schema travels inside the prompt as the emission contract.
 */
export class ClaudeCodeLlmClient implements LlmClient {
  readonly name = 'claude-code';
  readonly model: string;
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCodeClientOptions = {}) {
    this.model = opts.model ?? 'default';
    this.bin = claudeCodeBin(opts.bin);
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async complete(req: LlmRequest): Promise<string> {
    const args = [
      '--print',
      '--output-format',
      'json',
      '--tools',
      '',
      '--system-prompt',
      req.system,
    ];
    if (this.model !== 'default') args.push('--model', this.model);

    let prompt = req.prompt;
    if (req.schema !== undefined) {
      prompt +=
        '\n\nResponde ÚNICAMENTE con un objeto JSON válido conforme a este JSON Schema (sin prosa, sin markdown, sin bloques de código):\n' +
        JSON.stringify(req.schema);
    }

    const child = execFileAsync(this.bin, args, {
      encoding: 'utf8',
      timeout: this.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    });
    child.child.stdin?.write(prompt);
    child.child.stdin?.end();

    let stdout: string;
    try {
      ({ stdout } = await child);
    } catch (err) {
      const detail =
        err instanceof Error && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim() !== ''
          ? err.stderr.trim().slice(-500)
          : err instanceof Error
            ? err.message
            : String(err);
      throw new Error(`Claude Code falló (${this.bin}): ${detail}`);
    }

    let envelope: ClaudeCodeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCodeEnvelope;
    } catch {
      throw new Error(
        `Claude Code devolvió una salida no-JSON inesperada: ${stdout.trim().slice(0, 200)}`,
      );
    }
    if (envelope.is_error === true || envelope.subtype !== 'success') {
      throw new Error(
        `Claude Code terminó con error (${envelope.subtype ?? 'unknown'}): ${envelope.result?.slice(0, 300) ?? 'sin detalle'}`,
      );
    }
    if (typeof envelope.result !== 'string') {
      throw new Error('Claude Code no devolvió texto de resultado');
    }
    return envelope.result;
  }
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

/** Deterministic scripted client for tests: returns queued responses in order. */
export class MockLlmClient implements LlmClient {
  readonly name = 'mock';
  readonly model = 'mock';
  requests: LlmRequest[] = [];
  private responses: string[];

  constructor(responses: (string | object)[]) {
    this.responses = responses.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  }

  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('MockLlmClient: no scripted responses left');
    return next;
  }
}

/** Extract the first JSON object from a completion (defensive against prose wrappers). */
export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('LLM response contained no parseable JSON object');
  }
}
