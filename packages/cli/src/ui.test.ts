import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInterviewUi } from './ui.js';

function capture(): { chunks: string[]; write: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { chunks, write: (s) => chunks.push(s), text: () => chunks.join('') };
}

const ANSI = /\[/;

describe('interview UI (mascot + spinner)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('without a TTY nothing animates: no \\r, no ANSI, one line per event', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: false, unicode: true, write: out.write });
    ui.banner('0.1.0', '/tmp/grafo', 'administracion');
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

  it('falls back to pure ASCII without a UTF-8 locale', () => {
    const out = capture();
    const ui = createInterviewUi({ tty: true, unicode: false, write: out.write });
    ui.banner('0.1.0', '/tmp/grafo', 'ventas');
    const spinner = ui.spinner('generando guion');
    vi.advanceTimersByTime(200);
    spinner.stop();
    ui.celebrate(1);
    // Decorative glyphs degrade to ASCII; Spanish prose keeps its accents
    // (the locale check gates ornaments, not the language).
    const text = out.text().replace(/\[[0-9;]*m/g, '');
    for (const glyph of ['✻', '✽', '✢', '✳', '╭', '╰', '│', '─', '‿', '¬', '…']) {
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
});
