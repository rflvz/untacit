import type { CSSProperties, ReactNode } from 'react';

export type ChipTone = 'conflict' | 'neutral' | 'accent' | 'ok';

/**
 * Recetas de píldora del DS: `conflict` (ámbar — reservado a conflictos) y
 * `neutral` vienen de components/core/Chip.jsx; `accent` es la receta azul
 * del MetaPill, compartida aquí para que exista una sola vez; `ok` (teal)
 * marca estados validados (propuestas aceptadas/confirmadas en la entrevista).
 */
const TONES: Record<ChipTone, CSSProperties> = {
  conflict: {
    color: 'var(--amber)',
    border: '1px solid var(--conflict-border)',
    background: 'var(--conflict-bg)',
  },
  neutral: {
    color: '#B6C4DE',
    border: '1px solid rgba(148,168,215,0.25)',
    background: 'rgba(148,168,215,0.1)',
  },
  accent: {
    color: 'var(--blue-300)',
    border: '1px solid rgba(91,141,255,0.24)',
    background: 'rgba(91,141,255,0.09)',
  },
  ok: {
    color: 'var(--teal)',
    border: '1px solid rgba(41,211,184,0.35)',
    background: 'rgba(41,211,184,0.07)',
  },
};

/**
 * Chip en píldora mono del design system (components/core/Chip.jsx).
 * `size="sm"` es la adaptación de densidad para la app (misma receta,
 * padding y cuerpo menores).
 */
export function Chip({
  tone = 'neutral',
  size = 'md',
  children,
  style,
}: {
  tone?: ChipTone;
  size?: 'md' | 'sm';
  children: ReactNode;
  style?: CSSProperties;
}) {
  const sm = size === 'sm';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: sm ? '11px' : '12px',
        borderRadius: '99px',
        padding: sm ? '3px 10px' : '5px 13px',
        display: 'inline-block',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
        ...TONES[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Metadato en píldora azul (`confianza 0.92`): components/core/Chip.jsx. */
export function MetaPill({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        borderRadius: '99px',
        padding: '7px 14px',
        display: 'inline-block',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)',
        ...TONES.accent,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Punto de color de la leyenda de tipos de nodo. El DS lo indexa por los
 * nombres en español de la ontología; aquí acepta el color directamente para
 * enchufarlo a NODE_TYPE_COLORS sin duplicar el mapa.
 */
export function NodeDot({
  color,
  label,
  size = 7,
  glow = false,
}: {
  color: string;
  label?: ReactNode;
  size?: number;
  glow?: boolean;
}) {
  const dot = (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: glow ? `0 0 12px ${color}E6` : 'none',
        flexShrink: 0,
      }}
    />
  );
  if (label === undefined) return dot;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: '10.5px',
        color: 'var(--text-muted)',
      }}
    >
      {dot}
      {label}
    </span>
  );
}
