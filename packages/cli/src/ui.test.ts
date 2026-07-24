import pc from 'picocolors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THINKING_VERBS } from './theme.js';
import { createInterviewUi } from './ui.js';

function capture(): { chunks: string[]; write: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { chunks, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

const ANSI = /\[/;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Drive an async banner to completion under fake timers. */
async function runBanner(banner: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000);
  await banner;
}

describe('interview UI (mascot + spinner)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('without a TTY nothing animates: no \\r, no ANSI, one line per event', async () => {
    const out = capture();
    const ui = createInterviewUi({ tty: false, unicode: true, write: out.write });
    await ui.banner('0.1.0', '/tmp/grafo', 'administracion');
    const spinner = ui.spinner('pensando');
    vi.advanceTimersByTime(2000);
    spinner.stop();
    ui.agentSays('Hola.');
    ui.celebrate(3);
    const text = out.text();
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(ANSI);
    expect(text).toContain('untacit interview v0.1.0');
    expect(text).toContain('… pensando');
    expect(text).toContain('agente > Hola.');
    expect(text).toContain('+3 propuestas aceptadas');
  });

  it('without a TTY a fully-optioned spinner is still one plain line', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: false, unicode: true, write: out.write });
    const spinner = ui.spinner('pensando', { mood: 'thinking', verbs: THINKING_VERBS, elapsed: true });
    const after = out.chunks.length;
    vi.advanceTimersByTime(10_000);
    expect(out.chunks.length).toBe(after); // no timer ever started
    spinner.stop();
    expect(out.text()).toBe('… pensando\n');
  });

  it('with a TTY the spinner advances frames and stop() clears the line', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
    const spinner = ui.spinner('pensando');
    const first = out.chunks.length;
    vi.advanceTimersByTime(400);
    expect(out.chunks.length).toBeGreaterThan(first); // frames advanced
    expect(out.text()).toContain('\r');
    spinner.stop();
    const afterStop = out.chunks.length;
    expect(out.chunks[afterStop - 1]).toMatch(/^\r\s+\r$/); // line cleared
    vi.advanceTimersByTime(1000);
    expect(out.chunks.length).toBe(afterStop); // no writes after stop
    spinner.stop(); // idempotent
    expect(out.chunks.length).toBe(afterStop);
  });

  it('falls back to pure ASCII without a UTF-8 locale', async () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: false, write: out.write });
    await runBanner(ui.banner('0.1.0', '/tmp/grafo', 'ventas'));
    const spinner = ui.spinner('generando guion');
    vi.advanceTimersByTime(200);
    spinner.stop();
    ui.celebrate(1);
    // Decorative glyphs degrade to ASCII; Spanish prose keeps its accents
    // (the locale check gates ornaments, not the language).
    const text = stripAnsi(out.text());
    for (const glyph of ['✻', '✽', '✢', '✳', '╭', '╰', '│', '─', '‿', '¬', 'ô', '…']) {
      expect(text).not.toContain(glyph);
    }
    expect(text).toContain('+-');
    expect(text).toContain('(^-^)');
    expect(text).toContain('+1 propuesta aceptada');
  });

  it('the mascot has a distinct face per mood, in both charsets', () => {
    const uni = createInterviewUi({ tty: true, unicode: true, write: () => undefined });
    const ascii = createInterviewUi({ tty: true, unicode: false, write: () => undefined });
    for (const ui of [uni, ascii]) {
      const faces = (['listening', 'thinking', 'celebrating', 'verifying'] as const).map((m) =>
        ui.mood(m),
      );
      expect(new Set(faces).size).toBe(4);
    }
    expect(/^[\x00-\x7F]*$/.test(ascii.mood('thinking'))).toBe(true);
  });

  it('the mascot animates while the spinner thinks', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
    const spinner = ui.spinner('pensando', { mood: 'thinking' });
    expect(stripAnsi(out.chunks[0]!)).toContain('(¬‿¬)'); // canonical frame first
    vi.advanceTimersByTime(1000);
    spinner.stop();
    const text = stripAnsi(out.text());
    expect(text).toMatch(/\(¬‿-\)|\(-‿¬\)/); // gaze wandered off-canon
  });

  it('gerunds rotate deterministically, index 0 first', () => {
    const run = (): string[] => {
      const out = capture();
      const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
      const spinner = ui.spinner('pensando', { verbs: ['pensando', 'rumiando'] });
      vi.advanceTimersByTime(4500);
      spinner.stop();
      return out.chunks;
    };
    const a = run();
    const early = stripAnsi(a.slice(0, 40).join(''));
    expect(early).toContain('pensando');
    expect(early).not.toContain('rumiando');
    expect(stripAnsi(a.join(''))).toContain('rumiando'); // rotated after ~4s
    expect(run()).toEqual(a); // tick-driven, no randomness
  });

  it('shows an elapsed counter only after a few seconds', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
    const spinner = ui.spinner('pensando', { elapsed: true });
    vi.advanceTimersByTime(2800);
    expect(out.text()).not.toMatch(/\(\d+s\)/);
    vi.advanceTimersByTime(2400);
    spinner.stop();
    const text = stripAnsi(out.text());
    expect(text).toContain('(3s)');
    expect(text).toContain('(4s)');
    expect(text.indexOf('(3s)')).toBeLessThan(text.indexOf('(4s)'));
  });

  it('the spark shimmers (bold) in unicode but never in ascii', () => {
    // The test env has no TTY, so force the palette on through the seam.
    const colors = pc.createColors(true);
    const uni = capture();
    const uniSpin = createInterviewUi({ tty: true, unicode: true, write: uni.write, colors }).spinner('pensando');
    vi.advanceTimersByTime(900); // a full 8-frame cycle
    uniSpin.stop();
    expect(uni.text()).toContain('\x1b[1m');
    const asc = capture();
    const ascSpin = createInterviewUi({ tty: true, unicode: false, write: asc.write, colors }).spinner('pensando');
    vi.advanceTimersByTime(900);
    ascSpin.stop();
    expect(asc.text()).not.toContain('\x1b[1m');
    expect(asc.text()).toContain('\x1b[36m'); // still cyan, just flat
  });

  it('stop() clears the widest line ever rendered', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
    const spinner = ui.spinner('pensando', {
      mood: 'thinking',
      verbs: ['pensando', 'hilando fino'],
      elapsed: true,
    });
    vi.advanceTimersByTime(6000); // long line: face + spark + long verb + (5s)
    spinner.stop();
    const last = out.chunks[out.chunks.length - 1]!;
    expect(last).toMatch(/^\r +\r$/);
    const widest = Math.max(
      ...out.chunks.slice(0, -1).map((c) => stripAnsi(c).replace(/\r/g, '').length),
    );
    expect(last.length - 2).toBeGreaterThanOrEqual(widest); // clear covers everything
  });

  it('the banner wakes the mascot up before drawing the box', async () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: true, write: out.write });
    await runBanner(ui.banner('0.1.0', '/tmp/grafo', 'ventas'));
    const text = stripAnsi(out.text());
    expect(text).toContain('\r(-‿-)'); // eyes closed…
    expect(text).toContain('(o‿o)'); // …then open
    expect(text.indexOf('╭')).toBeGreaterThan(text.indexOf('(-‿-)')); // box comes after
    expect(text).toContain('untacit interview v0.1.0');
    expect(text).toContain('rol: ventas');
    expect(text).toContain('grafo: /tmp/grafo');
  });
});
