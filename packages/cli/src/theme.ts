/**
 * Theme registry for the untacit CLI: every glyph, animation frame, gerund
 * list and color convention lives here as pure data — no timers, no process
 * access — so ui.ts (interview TUI) and doctor.ts consume one table instead
 * of keeping private copies. Animation is cycled by tick index, never by
 * wall clock or randomness, so rendering is deterministic under fake timers.
 *
 * Invariant (asserted in theme.test.ts): within one mood+charset every frame
 * has the same string length, so a `\r`-rewritten line never leaves residue.
 */

import pc from 'picocolors';

export type Charset = 'unicode' | 'ascii';
export type Mood = 'listening' | 'thinking' | 'celebrating' | 'verifying';

/** Spark cadence. All other rhythms are multiples of this tick. */
export const FRAME_MS = 100;
/** The mascot advances one frame every N spark ticks (~300ms). */
export const MASCOT_TICKS = 3;
/** The gerund rotates every N spark ticks (~4s). */
export const VERB_TICKS = 40;
/** The elapsed counter appears once this much time has passed. */
export const ELAPSED_AFTER_MS = 3000;
/** Banner wake-up intro cadence. */
export const WAKE_FRAME_MS = 120;

export const SPARK_FRAMES: Record<Charset, readonly string[]> = {
  unicode: ['·', '✢', '✳', '✻', '✽', '✻', '✳', '✢'],
  ascii: ['|', '/', '-', '\\'],
};

/** The picocolors surface (pc itself, or pc.createColors(...) in tests). */
export type Palette = typeof pc;

/**
 * Shimmer, aligned index-by-index with SPARK_FRAMES.unicode: dim at the small
 * dot, bold at the full bloom, plain cyan on the shoulders — the spark
 * "breathes". ASCII terminals get flat cyan (bold rendering there is the
 * least trustworthy, and shimmer is an ornament on the unicode axis).
 * A factory over the palette so tests can force color detection on.
 */
export function sparkPaints(c: Palette): readonly ((s: string) => string)[] {
  const boldCyan = (s: string): string => c.bold(c.cyan(s));
  return [c.dim, c.cyan, c.cyan, boldCyan, boldCyan, boldCyan, c.cyan, c.dim];
}

export const SPARK_PAINTS: readonly ((s: string) => string)[] = sparkPaints(pc);

/**
 * Frame 0 of each mood is the canonical static face — what mood() returns
 * and what non-animated call sites (prompts, agentSays) render. The ASCII
 * listening blink is (u.u), not (-.-), so it never collides with the
 * canonical ASCII thinking face.
 */
export const MASCOT_FRAMES: Record<Mood, Record<Charset, readonly string[]>> = {
  // Slow blink, then a wink.
  listening: {
    unicode: ['(o‿o)', '(o‿o)', '(o‿o)', '(o‿o)', '(o‿o)', '(-‿-)', '(o‿-)', '(o‿o)'],
    ascii: ['(o.o)', '(o.o)', '(o.o)', '(o.o)', '(o.o)', '(u.u)', '(o.u)', '(o.o)'],
  },
  // Sidelong gaze wandering left and right.
  thinking: {
    unicode: ['(¬‿¬)', '(¬‿¬)', '(¬‿-)', '(¬‿¬)', '(-‿¬)', '(¬‿¬)'],
    ascii: ['(-.-)', '(-.-)', '(o.-)', '(-.-)', '(-.o)', '(-.-)'],
  },
  // Sparkle wink.
  celebrating: {
    unicode: ['(^‿^)', '(^‿^)', '(^‿~)', '(^‿^)'],
    ascii: ['(^-^)', '(^-^)', '(^-~)', '(^-^)'],
  },
  // Questioning eyebrow wiggle.
  verifying: {
    unicode: ['(o_o)?', '(o_o)?', '(ô_o)?', '(o_ô)?'],
    ascii: ['(o_O)?', '(o_O)?', '(O_o)?', '(o_O)?'],
  },
};

/** Banner intro: the mascot wakes up (closed → wink → open). */
export const WAKE_FRAMES: Record<Charset, readonly string[]> = {
  unicode: ['(-‿-)', '(o‿-)', '(o‿o)'],
  ascii: ['(u.u)', '(o.u)', '(o.o)'],
};

// ───────────────────────── pixel-art mascot ─────────────────────────
//
// A half-block creature, one bounding box (ART_WIDTH × ART_HEIGHT) for every
// frame of every mood — the width/height invariant holds by construction
// because all rows come from these four templates. Eyes are negative space
// carved out of the solid body; partial blocks act as eyelids and gaze:
//   ' ' open   '▐' looking left   '▌' looking right
//   '▀' squint '▄' happy-closed   '█' fully shut (wake-up only)
//
//    ▄█████▄
//   ▐██ █ ██▌
//   ▐███████▌
//    ▀▀   ▀▀

export const ART_WIDTH = 9;
export const ART_HEIGHT = 4;
/** Below this many columns the block region falls back to the single line. */
export const MIN_BLOCK_COLUMNS = 40;

const crown = (tl = ' ', tr = ' '): string => `${tl}▄█████▄${tr}`;
const face = (l: string, r: string): string => `▐██${l}█${r}██▌`;
const BODY = '▐███████▌';
const FEET = ' ▀▀   ▀▀ ';
const sprite = (l: string, r: string, tl?: string, tr?: string): readonly string[] => [
  crown(tl, tr),
  face(l, r),
  BODY,
  FEET,
];
const OPEN = sprite(' ', ' ');

export interface ArtSprite {
  /** Each frame: ART_HEIGHT rows of exactly ART_WIDTH chars. Frame 0 is canonical. */
  readonly frames: readonly (readonly string[])[];
}

export const MASCOT_ART: Record<Mood, ArtSprite> = {
  // Mostly open, a slow blink, then a wink.
  listening: {
    frames: [OPEN, OPEN, OPEN, OPEN, OPEN, sprite('▄', '▄'), sprite(' ', '▄'), OPEN],
  },
  // Gaze wanders left/right while a thought-spark pulses at the crown.
  thinking: {
    frames: [
      sprite('▐', '▐'),
      sprite('▐', '▐', ' ', '·'),
      sprite('▌', '▌', ' ', '✢'),
      sprite('▌', '▌', ' ', '·'),
      sprite(' ', ' ', ' ', '·'),
      sprite('▐', '▐'),
    ],
  },
  // Happy closed eyes, sparks dancing at the crown corners.
  celebrating: {
    frames: [
      sprite('▄', '▄', '✧', '✦'),
      sprite('▄', '▄', '✦', '✧'),
      sprite(' ', '▄', '✧', '✦'),
      sprite('▄', '▄'),
    ],
  },
  // One eye wide, one squinting, a question mark beside the head.
  verifying: {
    frames: [
      sprite(' ', '▀', ' ', '?'),
      sprite(' ', '▀', ' ', '?'),
      sprite('▀', ' ', ' ', '?'),
      sprite(' ', '▀', ' ', '?'),
    ],
  },
};

/** Banner intro in art: eyes shut → lids lifting → one eye → awake. */
export const WAKE_ART: readonly (readonly string[])[] = [
  sprite('█', '█'),
  sprite('▀', '▀'),
  sprite(' ', '▄'),
  OPEN,
];

/**
 * Whimsical Spanish gerunds, cycled by index (index 0 first, never random).
 * Length-capped in theme.test.ts so face+spark+verb+(NNs) stays well under
 * any real terminal width.
 */
export const THINKING_VERBS = [
  'pensando',
  'rumiando',
  'hilando fino',
  'cavilando',
  'maquinando',
  'destilando',
  'atando cabos',
  'urdiendo',
] as const;

export const SCRIPT_VERBS = ['generando guion', 'leyendo huecos', 'afinando preguntas'] as const;

export const EXTRACT_VERBS = [
  'extrayendo',
  'leyendo código',
  'destilando reglas',
  'anotando evidencia',
] as const;

export const EMBED_VERBS = ['calculando embeddings', 'vectorizando'] as const;

/** Status glyphs shared by doctor (and any future check-style output). */
export const STATUS_GLYPHS: Record<
  'ok' | 'warn' | 'fail',
  { unicode: string; ascii: string; paint: (s: string) => string }
> = {
  ok: { unicode: '✓', ascii: '+', paint: pc.green },
  warn: { unicode: '!', ascii: '!', paint: pc.yellow },
  fail: { unicode: '✗', ascii: 'x', paint: pc.red },
};
