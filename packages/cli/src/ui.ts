/**
 * Terminal UI for the untacit CLI — banner, animated spinner and a small
 * animated mascot, Claude Code-style. Degradation is structural, not
 * cosmetic: without a TTY no timer ever starts and no `\r`/ANSI byte is
 * written (the non-TTY paths avoid picocolors entirely, so even FORCE_COLOR
 * cannot leak escapes into a pipe), and without a UTF-8 locale every glyph
 * falls back to ASCII — the same criterion install.sh uses.
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
  ELAPSED_AFTER_MS,
  FRAME_MS,
  MASCOT_FRAMES,
  MASCOT_TICKS,
  SPARK_FRAMES,
  VERB_TICKS,
  WAKE_FRAME_MS,
  WAKE_FRAMES,
  sparkPaints,
} from './theme.js';
import type { Charset, Mood, Palette } from './theme.js';

export type { Mood } from './theme.js';

export interface UiOptions {
  /** stdout is a live terminal (spinner/banner animation allowed). */
  tty: boolean;
  /** The locale advertises UTF-8 (box drawing + mascot faces allowed). */
  unicode: boolean;
  /** Output sink, injectable for tests. Default: process.stdout. */
  write?: (chunk: string) => void;
  /** Palette, injectable for tests (pc.createColors(true)). Default: pc. */
  colors?: Palette;
}

export interface SpinnerOptions {
  /** Animated mascot rendered before the spark (TTY only). */
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

/**
 * Spinner factory shared by the interview UI and the long-running commands
 * (extract, embed). One line, `\r`-rewritten every tick: {mascot} {spark
 * with shimmer} {gerund} {(Ns)}. Every frame pads to the widest line seen so
 * far and stop() clears that width, so verb rotation or a growing elapsed
 * counter never leaves residue.
 */
export function createSpinner(opts: UiOptions): (label: string, options?: SpinnerOptions) => Spinner {
  const write = opts.write ?? ((chunk: string): void => void process.stdout.write(chunk));
  const c = opts.colors ?? pc;
  const paints = sparkPaints(c);
  const charset: Charset = opts.unicode ? 'unicode' : 'ascii';

  return (label, options = {}) => {
    if (!opts.tty) {
      // One plain line, no rewrites: agent/CI logs stay readable.
      write(`${opts.unicode ? '…' : '...'} ${label}\n`);
      return { stop: (): void => undefined };
    }
    const sparks = SPARK_FRAMES[charset];
    const faces = options.mood === undefined ? undefined : MASCOT_FRAMES[options.mood][charset];
    const verbs = options.verbs !== undefined && options.verbs.length > 0 ? options.verbs : [label];
    let tick = 0;
    let maxLen = 0;
    const render = (): void => {
      const spark = sparks[tick % sparks.length]!;
      const face = faces?.[Math.floor(tick / MASCOT_TICKS) % faces.length];
      const verb = verbs[Math.floor(tick / VERB_TICKS) % verbs.length]!;
      const ms = tick * FRAME_MS; // tick-derived: fake-timer friendly, drift-free
      const secs =
        options.elapsed === true && ms >= ELAPSED_AFTER_MS ? ` (${Math.floor(ms / 1000)}s)` : '';
      const plain = `${face === undefined ? '' : `${face} `}${spark} ${verb}${secs}`;
      maxLen = Math.max(maxLen, plain.length);
      const paint = opts.unicode ? paints[tick % paints.length]! : c.cyan;
      const painted =
        `${face === undefined ? '' : `${c.cyan(face)} `}` +
        `${paint(spark)} ${c.dim(verb)}${c.dim(secs)}`;
      write(`\r${painted}${' '.repeat(maxLen - plain.length)} `);
      tick++;
    };
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
        write(`\r${' '.repeat(maxLen + 2)}\r`);
      },
    };
  };
}

/**
 * Progress spinner on stderr for non-interview commands: stdout stays
 * machine-clean (batch JSON, --json output) while a human watching the
 * terminal still sees life. Degrades to one plain stderr line without a TTY.
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
  const mood = (state: Mood): string => MASCOT_FRAMES[state][charset][0]!;
  const spinner = createSpinner(opts);

  return {
    mood,
    spinner,

    async banner(version, graph, role): Promise<void> {
      if (!opts.tty) {
        write(`untacit interview v${version} — rol: ${role} — grafo: ${graph}\n`);
        return;
      }
      // Wake-up intro: the mascot opens its eyes on one line, then the line
      // is cleared and the box takes over.
      const wake = WAKE_FRAMES[charset];
      for (const frame of wake) {
        write(`\r${c.cyan(frame)}`);
        await sleep(WAKE_FRAME_MS);
      }
      write(`\r${' '.repeat(wake[0]!.length + 1)}\r`);

      const [tl, tr, bl, br, h, v] = opts.unicode
        ? ['╭', '╮', '╰', '╯', '─', '│']
        : ['+', '+', '+', '+', '-', '|'];
      const spark = opts.unicode ? '✻' : '*';
      // Width is computed on the plain strings; painting happens per segment
      // afterwards so ANSI escapes never count as columns.
      const lines: { plain: string; painted: string }[] = [
        {
          plain: `${mood('listening')}  ${spark} untacit interview v${version}`,
          painted: `${c.cyan(mood('listening'))}  ${c.cyan(spark)} ${c.bold('untacit interview')} ${c.dim(`v${version}`)}`,
        },
        { plain: `rol: ${role}`, painted: `${c.dim('rol:')} ${role}` },
        { plain: `grafo: ${graph}`, painted: `${c.dim('grafo:')} ${graph}` },
      ];
      const width = Math.max(...lines.map((l) => l.plain.length)) + 2;
      write(c.cyan(`${tl}${h.repeat(width)}${tr}\n`));
      for (const line of lines) {
        write(`${c.cyan(v)} ${line.painted}${' '.repeat(width - 1 - line.plain.length)}${c.cyan(v)}\n`);
      }
      write(c.cyan(`${bl}${h.repeat(width)}${br}\n`));
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
