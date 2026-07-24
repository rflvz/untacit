import pc from 'picocolors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THINKING_VERBS } from './theme.js';
import { createInterviewUi, createSpinner } from './ui.js';

function capture(): { chunks: string[]; write: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { chunks, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

const ANSI = /\[/;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const COLORS = pc.createColors(true);
const UP5 = '\x1b[5A';
const ERASE_UP = '\x1b[1A\x1b[2K';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

// Art rows (see theme.ts sprite templates).
const BODY = '▐███████▌';
const FACE_OPEN = '▐██ █ ██▌';
const FACE_GAZE_LEFT = '▐██▐█▐██▌';
const FACE_GAZE_RIGHT = '▐██▌█▌██▌';
const FACE_LIDS = '▐██▀█▀██▌';

/** Interview UI on the pixel-art tier: TTY + unicode + wide terminal. */
function artUi(overrides: Partial<Parameters<typeof createInterviewUi>[0]> = {}) {
  const out = capture();
  const ui = createInterviewUi({
    tty: true,
    unicode: true,
    write: out.write,
    colors: COLORS,
    columns: () => 80,
    ...overrides,
  });
  return { out, ui };
}

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
    expect(text).not.toContain('\x1b');
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

  it('the art region paints the creature plus a status line', () => {
    const { out, ui } = artUi();
    const spinner = ui.spinner('pensando', { mood: 'thinking' });
    // First paint: hide-cursor, then 5 `\n`-terminated lines (4 art + status).
    expect(out.chunks[0]).toBe(HIDE);
    const firstPaint = out.chunks.slice(1, 6);
    expect(firstPaint).toHaveLength(5);
    for (const line of firstPaint) {
      expect(line.startsWith('\r\x1b[2K')).toBe(true);
      expect(line.endsWith('\n')).toBe(true);
    }
    const text = stripAnsi(out.text());
    expect(text).toContain(BODY);
    expect(text).toContain(FACE_GAZE_LEFT); // thinking canonical pose
    expect(text).toContain('· pensando'); // status: spark frame 0 + label
    spinner.stop();
  });

  it('redraws move relative: one cursor-up-5 per tick after the first paint', () => {
    const { out, ui } = artUi();
    const spinner = ui.spinner('pensando', { mood: 'listening' });
    expect(count(out.text(), UP5)).toBe(0); // first paint allocates with \n only
    vi.advanceTimersByTime(300);
    expect(count(out.text(), UP5)).toBe(3); // one per redraw
    spinner.stop();
  });

  it('the creature animates: the gaze wanders while thinking', () => {
    const { out, ui } = artUi();
    const spinner = ui.spinner('pensando', { mood: 'thinking' });
    vi.advanceTimersByTime(1000);
    spinner.stop();
    const text = stripAnsi(out.text());
    expect(text).toContain(FACE_GAZE_RIGHT); // wandered off the canonical pose
  });

  it('stop() erases the whole region and restores the cursor', () => {
    const { out, ui } = artUi();
    const spinner = ui.spinner('pensando', { mood: 'thinking' });
    vi.advanceTimersByTime(500);
    spinner.stop();
    const last = out.chunks[out.chunks.length - 1]!;
    expect(last).toBe(`${ERASE_UP.repeat(5)}\r${SHOW}`);
    const afterStop = out.chunks.length;
    vi.advanceTimersByTime(1000);
    expect(out.chunks.length).toBe(afterStop); // no writes after stop
    spinner.stop(); // idempotent
    expect(out.chunks.length).toBe(afterStop);
  });

  it('a narrow terminal falls back to the single-line kaomoji spinner', () => {
    const { out, ui } = artUi({ columns: () => 30 });
    const spinner = ui.spinner('pensando', { mood: 'thinking' });
    vi.advanceTimersByTime(400);
    spinner.stop();
    const text = out.text();
    expect(text).not.toContain(UP5);
    expect(text).not.toContain(HIDE);
    expect(stripAnsi(text)).toContain('(¬‿¬)'); // kaomoji face, one line
  });

  it('createSpinner without block never opens a region (progressSpinner path)', () => {
    const out = capture();
    const spin = createSpinner({ tty: true, unicode: true, write: out.write, colors: COLORS, columns: () => 80 })(
      'extrayendo',
      { mood: 'thinking' },
    );
    vi.advanceTimersByTime(400);
    spin.stop();
    const text = out.text();
    expect(text).not.toContain(UP5);
    expect(text).not.toContain(HIDE);
    expect(text).not.toContain(BODY);
    expect(stripAnsi(text)).toContain('(¬‿¬)');
  });

  it('with a TTY the single-line spinner advances frames and stop() clears the line', () => {
    const out = capture();
    const spin = createSpinner({ tty: true, unicode: true, write: out.write, colors: COLORS })('pensando');
    const first = out.chunks.length;
    vi.advanceTimersByTime(400);
    expect(out.chunks.length).toBeGreaterThan(first); // frames advanced
    expect(out.text()).toContain('\r');
    spin.stop();
    const afterStop = out.chunks.length;
    expect(out.chunks[afterStop - 1]).toMatch(/^\r\s+\r$/); // line cleared
    vi.advanceTimersByTime(1000);
    expect(out.chunks.length).toBe(afterStop); // no writes after stop
    spin.stop(); // idempotent
    expect(out.chunks.length).toBe(afterStop);
  });

  it('falls back to pure ASCII without a UTF-8 locale', async () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: false, write: out.write, columns: () => 80 });
    await runBanner(ui.banner('0.1.0', '/tmp/grafo', 'ventas'));
    const spinner = ui.spinner('generando guion');
    vi.advanceTimersByTime(200);
    spinner.stop();
    ui.celebrate(1);
    // Decorative glyphs degrade to ASCII; Spanish prose keeps its accents
    // (the locale check gates ornaments, not the language).
    const text = stripAnsi(out.text());
    for (const glyph of ['✻', '✽', '✢', '✳', '╭', '╰', '│', '─', '‿', '¬', 'ô', '…', '▐', '▌', '▀', '▄', '█', '✧', '✦']) {
      expect(text).not.toContain(glyph);
    }
    expect(text).not.toContain(UP5);
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

  it('gerunds rotate deterministically, index 0 first', () => {
    const run = (): string[] => {
      const { out, ui } = artUi();
      const spinner = ui.spinner('pensando', { verbs: ['pensando', 'rumiando'] });
      vi.advanceTimersByTime(4500);
      spinner.stop();
      return out.chunks;
    };
    const a = run();
    const early = stripAnsi(a.slice(0, 40 * 6).join('')); // ~first 39 ticks of region paints
    expect(early).toContain('pensando');
    expect(early).not.toContain('rumiando');
    expect(stripAnsi(a.join(''))).toContain('rumiando'); // rotated after ~4s
    expect(run()).toEqual(a); // tick-driven, no randomness
  });

  it('shows an elapsed counter only after a few seconds', () => {
    const { out, ui } = artUi();
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
    const { out, ui } = artUi();
    const uniSpin = ui.spinner('pensando');
    vi.advanceTimersByTime(900); // a full 8-frame cycle
    uniSpin.stop();
    expect(out.text()).toContain('\x1b[1m');
    const asc = capture();
    const ascSpin = createSpinner({ tty: true, unicode: false, write: asc.write, colors: COLORS })('pensando');
    vi.advanceTimersByTime(900);
    ascSpin.stop();
    expect(asc.text()).not.toContain('\x1b[1m');
    expect(asc.text()).toContain('\x1b[36m'); // still cyan, just flat
  });

  it('the single-line spinner clears the widest line ever rendered', () => {
    const out = capture();
    const spin = createSpinner({ tty: true, unicode: true, write: out.write, colors: COLORS })('pensando', {
      mood: 'thinking',
      verbs: ['pensando', 'hilando fino'],
      elapsed: true,
    });
    vi.advanceTimersByTime(6000); // long line: face + spark + long verb + (5s)
    spin.stop();
    const last = out.chunks[out.chunks.length - 1]!;
    expect(last).toMatch(/^\r +\r$/);
    const widest = Math.max(
      ...out.chunks.slice(0, -1).map((c) => stripAnsi(c).replace(/\r/g, '').length),
    );
    expect(last.length - 2).toBeGreaterThanOrEqual(widest); // clear covers everything
  });

  it('the banner wakes the creature up, then seats it beside the box', async () => {
    const { out, ui } = artUi();
    await runBanner(ui.banner('0.1.0', '/tmp/grafo', 'ventas'));
    const text = stripAnsi(out.text());
    expect(text).toContain(FACE_LIDS); // lids lifting mid-wake
    expect(text).toContain(FACE_OPEN); // …eyes open
    expect(text.indexOf('╭')).toBeGreaterThan(text.indexOf(FACE_LIDS)); // box after the wake
    expect(out.text().indexOf(SHOW)).toBeLessThan(out.text().indexOf('╭')); // cursor restored first
    // Side-by-side: one output line carries both an art row and a box border.
    const zipped = text.split('\n').find((l) => l.includes(FACE_OPEN) && l.includes('│'));
    expect(zipped).toBeDefined();
    expect(text).toContain('untacit interview v0.1.0');
    expect(text).toContain('rol: ventas');
    expect(text).toContain('grafo: /tmp/grafo');
  });

  it('a narrow terminal gets the kaomoji banner (no art column)', async () => {
    const { out, ui } = artUi({ columns: () => 38 });
    await runBanner(ui.banner('0.1.0', '/tmp/grafo', 'ventas'));
    const text = stripAnsi(out.text());
    expect(text).not.toContain(BODY);
    expect(text).toContain('(-‿-)'); // kaomoji wake
    expect(text).toContain('(o‿o)  ✻ untacit interview v0.1.0');
  });
});
