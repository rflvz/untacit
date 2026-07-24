/**
 * Terminal UI for `untacit interview` — banner, spinner and a small mascot,
 * Claude Code-style. Degradation is structural, not cosmetic: without a TTY
 * no timer ever starts and no `\r`/ANSI byte is written (the non-TTY paths
 * avoid picocolors entirely, so even FORCE_COLOR cannot leak escapes into a
 * pipe), and without a UTF-8 locale every glyph falls back to ASCII — the
 * same criterion install.sh uses.
 */

import pc from 'picocolors';

export type Mood = 'listening' | 'thinking' | 'celebrating' | 'verifying';

export interface UiOptions {
  /** stdout is a live terminal (spinner/banner animation allowed). */
  tty: boolean;
  /** The locale advertises UTF-8 (box drawing + mascot faces allowed). */
  unicode: boolean;
  /** Output sink, injectable for tests. Default: process.stdout. */
  write?: (chunk: string) => void;
}

export interface Spinner {
  stop(): void;
}

export interface InterviewUi {
  banner(version: string, graph: string, role: string): void;
  /** Animated while a slow LLM call runs. ALWAYS stop() before prompting. */
  spinner(label: string): Spinner;
  mood(state: Mood): string;
  agentSays(text: string): void;
  celebrate(count: number): void;
}

const FRAMES_UNICODE = ['·', '✢', '✳', '✻', '✽', '✻', '✳', '✢'];
const FRAMES_ASCII = ['|', '/', '-', '\\'];
const FRAME_MS = 90;

const FACES: Record<Mood, { unicode: string; ascii: string }> = {
  listening: { unicode: '(o‿o)', ascii: '(o.o)' },
  thinking: { unicode: '(¬‿¬)', ascii: '(-.-)' },
  celebrating: { unicode: '(^‿^)', ascii: '(^-^)' },
  verifying: { unicode: '(o_o)?', ascii: '(o_O)?' },
};

export function createInterviewUi(opts: UiOptions): InterviewUi {
  const write = opts.write ?? ((chunk: string): void => void process.stdout.write(chunk));
  const frames = opts.unicode ? FRAMES_UNICODE : FRAMES_ASCII;
  const mood = (state: Mood): string => FACES[state][opts.unicode ? 'unicode' : 'ascii'];

  return {
    mood,

    banner(version, graph, role): void {
      if (!opts.tty) {
        write(`untacit interview v${version} — rol: ${role} — grafo: ${graph}\n`);
        return;
      }
      const [tl, tr, bl, br, h, v] = opts.unicode
        ? ['╭', '╮', '╰', '╯', '─', '│']
        : ['+', '+', '+', '+', '-', '|'];
      const lines = [
        `${mood('listening')}  untacit interview v${version}`,
        `rol: ${role}`,
        `grafo: ${graph}`,
      ];
      const width = Math.max(...lines.map((l) => l.length)) + 2;
      write(pc.cyan(`${tl}${h.repeat(width)}${tr}\n`));
      for (const line of lines) {
        write(`${pc.cyan(v)} ${line.padEnd(width - 1)}${pc.cyan(v)}\n`);
      }
      write(pc.cyan(`${bl}${h.repeat(width)}${br}\n`));
      write(pc.dim('Cada afirmación tuya se convierte en una propuesta que puedes aceptar o rechazar.\n\n'));
    },

    spinner(label): Spinner {
      if (!opts.tty) {
        // One plain line, no rewrites: agent/CI logs stay readable.
        write(`${opts.unicode ? '…' : '...'} ${label}\n`);
        return { stop: (): void => undefined };
      }
      let i = 0;
      const render = (): void => {
        write(`\r${pc.cyan(frames[i % frames.length]!)} ${pc.dim(label)} `);
        i++;
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
          write(`\r${' '.repeat(label.length + 4)}\r`);
        },
      };
    },

    agentSays(text): void {
      if (!opts.tty) {
        write(`agente > ${text}\n`);
        return;
      }
      write(`${pc.green(`${mood('listening')} agente >`)} ${text}\n`);
    },

    celebrate(count): void {
      if (count < 1) return;
      const noun = `propuesta${count === 1 ? '' : 's'} aceptada${count === 1 ? '' : 's'}`;
      if (!opts.tty) {
        write(`+${count} ${noun}\n`);
        return;
      }
      const spark = opts.unicode ? '✽' : '*';
      write(`${pc.green(`${spark} ${mood('celebrating')} +${count} ${noun}`)}\n`);
    },
  };
}
