import { describe, expect, it } from 'vitest';

import {
  ART_HEIGHT,
  ART_WIDTH,
  EMBED_VERBS,
  EXTRACT_VERBS,
  MASCOT_ART,
  MASCOT_FRAMES,
  SCRIPT_VERBS,
  SPARK_FRAMES,
  SPARK_PAINTS,
  STATUS_GLYPHS,
  THINKING_VERBS,
  WAKE_ART,
  WAKE_FRAMES,
} from './theme.js';
import type { Charset, Mood } from './theme.js';

const MOODS = Object.keys(MASCOT_FRAMES) as Mood[];
const CHARSETS: Charset[] = ['unicode', 'ascii'];
const VERB_LISTS = [THINKING_VERBS, SCRIPT_VERBS, EXTRACT_VERBS, EMBED_VERBS];

describe('theme (frames, verbs, glyphs)', () => {
  it('every mood animates (≥2 frames per charset) with a distinct canonical face', () => {
    for (const charset of CHARSETS) {
      const canonical = MOODS.map((m) => MASCOT_FRAMES[m][charset][0]);
      expect(new Set(canonical).size).toBe(MOODS.length);
      for (const mood of MOODS) {
        expect(new Set(MASCOT_FRAMES[mood][charset]).size).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('all frames of an animation share the same width (no \\r residue)', () => {
    const sequences: readonly string[][] = [
      ...MOODS.flatMap((m) => CHARSETS.map((c) => [...MASCOT_FRAMES[m][c]])),
      ...CHARSETS.map((c) => [...WAKE_FRAMES[c]]),
      ...CHARSETS.map((c) => [...SPARK_FRAMES[c]]),
    ];
    for (const frames of sequences) {
      expect(frames.length).toBeGreaterThan(0);
      expect(new Set(frames.map((f) => f.length)).size).toBe(1);
    }
  });

  it('ascii frames are pure 7-bit', () => {
    const ascii = [
      ...MOODS.flatMap((m) => MASCOT_FRAMES[m].ascii),
      ...WAKE_FRAMES.ascii,
      ...SPARK_FRAMES.ascii,
      STATUS_GLYPHS.ok.ascii,
      STATUS_GLYPHS.warn.ascii,
      STATUS_GLYPHS.fail.ascii,
    ];
    for (const frame of ascii) {
      expect(frame).toMatch(/^[\x00-\x7F]+$/);
    }
  });

  it('gerund lists are non-empty and fit the one-line budget', () => {
    for (const verbs of VERB_LISTS) {
      expect(verbs.length).toBeGreaterThan(0);
      for (const verb of verbs) {
        expect(verb.length).toBeLessThanOrEqual(24);
        expect(verb.trim()).toBe(verb);
      }
    }
  });

  it('the shimmer palette aligns with the unicode spark cycle', () => {
    expect(SPARK_PAINTS.length).toBe(SPARK_FRAMES.unicode.length);
  });

  it('every art frame is a perfect ART_WIDTH×ART_HEIGHT rectangle', () => {
    const allFrames = [...MOODS.flatMap((m) => MASCOT_ART[m].frames), ...WAKE_ART];
    for (const frame of allFrames) {
      expect(frame.length).toBe(ART_HEIGHT);
      for (const row of frame) {
        expect(row.length).toBe(ART_WIDTH);
      }
    }
  });

  it('art moods animate (≥2 distinct frames) with distinct canonical poses', () => {
    const canonical = MOODS.map((m) => MASCOT_ART[m].frames[0]!.join('\n'));
    expect(new Set(canonical).size).toBe(MOODS.length);
    for (const mood of MOODS) {
      const distinct = new Set(MASCOT_ART[mood].frames.map((f) => f.join('\n')));
      expect(distinct.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('art uses only single-column glyphs (column math stays valid)', () => {
    const allFrames = [...MOODS.flatMap((m) => MASCOT_ART[m].frames), ...WAKE_ART];
    for (const row of allFrames.flat()) {
      for (const ch of row) {
        expect(ch).toMatch(/^[ ▐▌▀▄█✧✦·✢?]$/);
      }
    }
  });
});
