/**
 * Terminal UI for the untacit CLI — banner, animated spinner and a pixel-art
 * mascot, Claude Code-style. Degradation is structural, not cosmetic, in
 * three tiers: (a) TTY + UTF-8 + a wide-enough terminal renders the
 * multi-line half-block mascot region; (b) a TTY without UTF-8 (or too
 * narrow) falls back to the single-line kaomoji spinner; (c) without a TTY
 * no timer ever starts and no `\r`/ANSI byte is written (the non-TTY paths
 * avoid picocolors entirely, so even FORCE_COLOR cannot leak escapes into a
 * pipe). The UTF-8 criterion is the same one install.sh uses.
 *
 * All animation derives from a single tick counter (never Date.now() or
 * Math.random()), so fake-timer tests are deterministic and the elapsed
 * counter can never drift from the frame clock. agentSays is deliberately
 * NOT animated: a typewriter effect would race readline for stdout and add
 * latency for zero information.
 */

import pc from 'picocolors';

import { stderrIsInteractive, unicodeOk } from './output.js';
import {
  ART_HEIGHT,
  ART_WIDTH,
  ELAPSED_AFTER_MS,
  FRAME_MS,
  MASCOT_ART,
  MASCOT_FRAMES,
  MASCOT_TICKS,
  MIN_BLOCK_COLUMNS,
  SPARK_FRAMES,
  VERB_TICKS,
  WAKE_ART,
  WAKE_FRAME_MS,
  WAKE_FRAMES,
  sparkPaints,
} from './theme.js';
import type { Charset, Mood, Palette } from './theme.js';

export type { Mood } from './theme.js';

export interface UiOptions {
  /** stdout is a live terminal (spinner/banner animation allowed). */
  tty: boolean;
  /** The locale advertises UTF-8 (box drawing + mascot art allowed). */
  unicode: boolean;
  /** Output sink, injectable for tests. Default: process.stdout. */
  write?: (chunk: string) => void;
  /** Palette, injectable for tests (pc.createColors(true)). Default: pc. */
  colors?: Palette;
  /** Terminal width probe, injectable for tests. Default: stdout columns. */
  columns?: () => number;
  /**
   * Allow the multi-line pixel-art region. The interview UI sets it;
   * progressSpinner (stderr, next to machine output) deliberately does not.
   */
  block?: boolean;
}

export interface SpinnerOptions {
  /** Animated mascot rendered with the spinner (TTY only). */
  mood?: Mood;
  /** Gerunds cycled every ~4s, index 0 first. Default: [label]. */
  verbs?: readonly string[];
  /** Append " (Ns)" once a few seconds have passed. Default: false. */
  elapsed?: boolean;
}

export interface Spinner {
  stop(): void;
}

export interface InterviewUi {
  banner(version: string, graph: string, role: string): Promise<void>;
  /** Animated while a slow LLM call runs. ALWAYS stop() before prompting. */
  spinner(label: string, options?: SpinnerOptions): Spinner;
  mood(state: Mood): string;
  agentSays(text: string): void;
  celebrate(count: number): void;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const cursorUp = (n: number): string => `\x1b[${n}A`;

/**
 * A hidden cursor must survive any exit path (the interview's SIGINT handler
 * calls process.exit(130), which fires 'exit'). Every live art region arms
 * its sink here and disarms it on stop(); the hook is registered once.
 */
const hiddenCursorSinks = new Set<(chunk: string) => void>();
let exitHookArmed = false;
function armCursorRestore(write: (chunk: string) => void): void {
  hiddenCursorSinks.add(write);
  if (!exitHookArmed) {
    exitHookArmed = true;
    process.on('exit', () => {
      for (const sink of hiddenCursorSinks) sink(SHOW_CURSOR);
    });
  }
}
function disarmCursorRestore(write: (chunk: string) => void): void {
  hiddenCursorSinks.delete(write);
}

interface StatusCfg {
  sparks: readonly string[];
  paints: readonly ((s: string) => string)[];
  verbs: readonly string[];
  elapsed: boolean;
  unicode: boolean;
  c: Palette;
}

/** Tick → status text (spark + shimmer + gerund + elapsed), shared by tiers. */
function statusAt(tick: number, cfg: StatusCfg): { plain: string; painted: string } {
  const spark = cfg.sparks[tick % cfg.sparks.length]!;
  const verb = cfg.verbs[Math.floor(tick / VERB_TICKS) % cfg.verbs.length]!;
  const ms = tick * FRAME_MS; // tick-derived: fake-timer friendly, drift-free
  const secs = cfg.elapsed && ms >= ELAPSED_AFTER_MS ? ` (${Math.floor(ms / 1000)}s)` : '';
  const paint = cfg.unicode ? cfg.paints[tick % cfg.paints.length]! : cfg.c.cyan;
  return {
    plain: `${spark} ${verb}${secs}`,
    painted: `${paint(spark)} ${cfg.c.dim(verb)}${cfg.c.dim(secs)}`,
  };
}

const defaultColumns = (): number => process.stdout.columns ?? 80;

/**
 * Spinner factory shared by the interview UI and the long-running commands
 * (extract, embed). The block tier renders the pixel-art mascot plus a
 * status line as an N+1-line live region redrawn with relative cursor moves
 * (first paint allocates the lines with `\n`, so a cursor at the bottom row
 * scrolls naturally); the single-line tier `\r`-rewrites one line, padding
 * to the widest line seen so stop() never leaves residue.
 */
export function createSpinner(opts: UiOptions): (label: string, options?: SpinnerOptions) => Spinner {
  const write = opts.write ?? ((chunk: string): void => void process.stdout.write(chunk));
  const c = opts.colors ?? pc;
  const paints = sparkPaints(c);
  const charset: Charset = opts.unicode ? 'unicode' : 'ascii';
  const columns = opts.columns ?? defaultColumns;

  return (label, options = {}) => {
    if (!opts.tty) {
      // One plain line, no rewrites: agent/CI logs stay readable.
      write(`${opts.unicode ? '…' : '...'} ${label}\n`);
      return { stop: (): void => undefined };
    }

    const cfg: StatusCfg = {
      sparks: SPARK_FRAMES[charset],
      paints,
      verbs: options.verbs !== undefined && options.verbs.length > 0 ? options.verbs : [label],
      elapsed: options.elapsed === true,
      unicode: opts.unicode,
      c,
    };
    const cols = columns();

    if (opts.block === true && opts.unicode && cols >= MIN_BLOCK_COLUMNS) {
      // ── block tier: pixel-art region ──
      const frames = MASCOT_ART[options.mood ?? 'listening'].frames;
      const height = ART_HEIGHT + 1; // art + status line
      let tick = 0;
      let paintedOnce = false;
      const render = (): void => {
        const frame = frames[Math.floor(tick / MASCOT_TICKS) % frames.length]!;
        const status = statusAt(tick, cfg);
        const statusText =
          2 + status.plain.length < cols
            ? `  ${status.painted}`
            : `  ${status.plain}`.slice(0, cols - 1); // resize guard: clamp, unpainted
        if (paintedOnce) write(cursorUp(height));
        for (const row of frame) write(`\r${CLEAR_LINE}${c.cyan(row)}\n`);
        write(`\r${CLEAR_LINE}${statusText}\n`);
        paintedOnce = true;
        tick++;
      };
      armCursorRestore(write);
      write(HIDE_CURSOR);
      render();
      const timer = setInterval(render, FRAME_MS);
      // unref: a hung LLM call must not keep the process alive on its own.
      timer.unref();
      let stopped = false;
      return {
        stop(): void {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          // Walk up erasing the whole region; end at col 0 of its top line.
          write(`${`${cursorUp(1)}${CLEAR_LINE}`.repeat(height)}\r${SHOW_CURSOR}`);
          disarmCursorRestore(write);
        },
      };
    }

    // ── single-line tier: kaomoji face + status ──
    const faces = options.mood === undefined ? undefined : MASCOT_FRAMES[options.mood][charset];
    let tick = 0;
    let maxLen = 0;
    const render = (): void => {
      const face = faces?.[Math.floor(tick / MASCOT_TICKS) % faces.length];
      const status = statusAt(tick, cfg);
      const plain = `${face === undefined ? '' : `${face} `}${status.plain}`;
      maxLen = Math.max(maxLen, plain.length);
      const painted = `${face === undefined ? '' : `${c.cyan(face)} `}${status.painted}`;
      write(`\r${painted}${' '.repeat(maxLen - plain.length)} `);
      tick++;
    };
    render();
    const timer = setInterval(render, FRAME_MS);
    timer.unref();
    let stopped = false;
    return {
      stop(): void {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        write(`\r${' '.repeat(maxLen + 2)}\r`);
      },
    };
  };
}

/**
 * Progress spinner on stderr for non-interview commands: stdout stays
 * machine-clean (batch JSON, --json output) while a human watching the
 * terminal still sees life. Single-line by design — a multi-row region on
 * stderr would interleave badly with stdout. Degrades to one plain stderr
 * line without a TTY.
 */
export function progressSpinner(label: string, options?: SpinnerOptions): Spinner {
  return createSpinner({
    tty: stderrIsInteractive(),
    unicode: unicodeOk(),
    write: (chunk: string): void => void process.stderr.write(chunk),
  })(label, options);
}

export function createInterviewUi(opts: UiOptions): InterviewUi {
  const write = opts.write ?? ((chunk: string): void => void process.stdout.write(chunk));
  const c = opts.colors ?? pc;
  const charset: Charset = opts.unicode ? 'unicode' : 'ascii';
  const columns = opts.columns ?? defaultColumns;
  const mood = (state: Mood): string => MASCOT_FRAMES[state][charset][0]!;
  const spinner = createSpinner({ ...opts, block: true });

  return {
    mood,
    spinner,

    async banner(version, graph, role): Promise<void> {
      if (!opts.tty) {
        write(`untacit interview v${version} — rol: ${role} — grafo: ${graph}\n`);
        return;
      }

      const [tl, tr, bl, br, h, v] = opts.unicode
        ? ['╭', '╮', '╰', '╯', '─', '│']
        : ['+', '+', '+', '+', '-', '|'];
      const spark = opts.unicode ? '✻' : '*';

      // Box lines, width computed on the plain strings; painting happens per
      // segment afterwards so ANSI escapes never count as columns. In the
      // art tier the creature replaces the kaomoji face on the title line;
      // the tier needs room for art column + gap + the box itself.
      const boxInnerWidth =
        Math.max(
          `${spark} untacit interview v${version}`.length,
          `rol: ${role}`.length,
          `grafo: ${graph}`.length,
        ) + 2;
      const art =
        opts.unicode && columns() >= ART_WIDTH + 2 + boxInnerWidth + 2
          ? MASCOT_ART.listening.frames[0]!
          : undefined;
      const titleFace = art === undefined ? `${mood('listening')}  ` : '';
      const lines: { plain: string; painted: string }[] = [
        {
          plain: `${titleFace}${spark} untacit interview v${version}`,
          painted: `${art === undefined ? `${c.cyan(mood('listening'))}  ` : ''}${c.cyan(spark)} ${c.bold('untacit interview')} ${c.dim(`v${version}`)}`,
        },
        { plain: `rol: ${role}`, painted: `${c.dim('rol:')} ${role}` },
        { plain: `grafo: ${graph}`, painted: `${c.dim('grafo:')} ${graph}` },
      ];
      const width = Math.max(...lines.map((l) => l.plain.length)) + 2;
      const box: string[] = [
        c.cyan(`${tl}${h.repeat(width)}${tr}`),
        ...lines.map(
          (line) => `${c.cyan(v)} ${line.painted}${' '.repeat(width - 1 - line.plain.length)}${c.cyan(v)}`,
        ),
        c.cyan(`${bl}${h.repeat(width)}${br}`),
      ];

      if (art === undefined) {
        // Fallback tier: single-line kaomoji wake-up, then the box alone.
        const wake = WAKE_FRAMES[charset];
        for (const frame of wake) {
          write(`\r${c.cyan(frame)}`);
          await sleep(WAKE_FRAME_MS);
        }
        write(`\r${' '.repeat(wake[0]!.length + 1)}\r`);
        for (const line of box) write(`${line}\n`);
      } else {
        // Art tier: the creature wakes up in place…
        armCursorRestore(write);
        write(HIDE_CURSOR);
        for (let i = 0; i < WAKE_ART.length; i++) {
          if (i > 0) write(cursorUp(ART_HEIGHT));
          for (const row of WAKE_ART[i]!) write(`\r${CLEAR_LINE}${c.cyan(row)}\n`);
          await sleep(WAKE_FRAME_MS);
        }
        write(`${`${cursorUp(1)}${CLEAR_LINE}`.repeat(ART_HEIGHT)}\r${SHOW_CURSOR}`);
        disarmCursorRestore(write);
        // …then sits beside the box (art column zipped with the box lines).
        const artPad = ' '.repeat(ART_WIDTH);
        for (let i = 0; i < box.length; i++) {
          const artRow = i < art.length ? c.cyan(art[i]!) : artPad;
          write(`${artRow}  ${box[i]!}\n`);
        }
      }
      write(c.dim('Cada afirmación tuya se convierte en una propuesta que puedes aceptar o rechazar.\n\n'));
    },

    agentSays(text): void {
      if (!opts.tty) {
        write(`agente > ${text}\n`);
        return;
      }
      write(`${c.green(`${mood('listening')} agente >`)} ${text}\n`);
    },

    celebrate(count): void {
      if (count < 1) return;
      const noun = `propuesta${count === 1 ? '' : 's'} aceptada${count === 1 ? '' : 's'}`;
      if (!opts.tty) {
        write(`+${count} ${noun}\n`);
        return;
      }
      const spark = opts.unicode ? '✽' : '*';
      write(`${c.green(`${spark} ${mood('celebrating')} +${count} ${noun} ${spark}`)}\n`);
    },
  };
}
