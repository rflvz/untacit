import { useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Tarjeta glass del design system (components/surfaces/GlassCard.jsx):
 * gradiente translúcido azulado + blur saturado + bisel superior + sheen
 * radial y sombra negra profunda. `hover` activa el lift de -3px.
 */
export function GlassCard({
  children,
  size = 'md',
  hover = false,
  pad,
  style,
}: {
  children: ReactNode;
  size?: 'md' | 'lg';
  hover?: boolean;
  pad?: CSSProperties['padding'];
  style?: CSSProperties;
}) {
  const [h, setH] = useState(false);
  const lg = size === 'lg';
  const s: CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    background: lg ? 'var(--grad-card-glass-lg)' : 'var(--grad-card-glass)',
    backdropFilter: lg ? 'var(--blur-glass)' : 'var(--blur-glass-card)',
    WebkitBackdropFilter: lg ? 'var(--blur-glass)' : 'var(--blur-glass-card)',
    border:
      '1px solid ' +
      (hover && h
        ? 'var(--border-glass-hover)'
        : lg
          ? 'var(--border-glass)'
          : 'var(--border-glass-mid)'),
    borderRadius: lg ? 'var(--radius-card-lg)' : 'var(--radius-card)',
    padding: pad ?? (lg ? '12px 38px' : '32px 30px'),
    boxShadow:
      hover && h ? 'var(--shadow-card-hover)' : lg ? 'var(--shadow-card-lg)' : 'var(--shadow-card)',
    transform: hover && h ? 'translateY(-3px)' : 'none',
    transition: 'transform 0.35s var(--ease-spring), border-color 0.35s, box-shadow 0.35s',
    ...style,
  };
  return (
    <div
      style={s}
      onMouseEnter={hover ? () => setH(true) : undefined}
      onMouseLeave={hover ? () => setH(false) : undefined}
    >
      <div
        style={{ position: 'absolute', inset: 0, background: 'var(--grad-sheen)', pointerEvents: 'none' }}
      />
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
}
