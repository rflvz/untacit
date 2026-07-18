import type { CSSProperties, ReactNode } from 'react';

/**
 * Marca untacit: glifo de grafo (3 nodos + 2 aristas) sobre tile con gradiente
 * y wordmark tipográfico `untacit_` en IBM Plex Mono 600 (el underscore en
 * azul). Port de components/brand/LogoMark.jsx del design system.
 */
export function LogoMark({
  size = 30,
  withWordmark = true,
  variant = 'tile',
}: {
  size?: number;
  withWordmark?: boolean;
  variant?: 'tile' | 'glyph';
}) {
  const glyph = (s: number): ReactNode => (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <line x1="4" y1="11.5" x2="11.5" y2="4" stroke="#FFFFFF" strokeWidth="1.5" />
      <line x1="4" y1="11.5" x2="12.5" y2="12" stroke="#FFFFFF" strokeWidth="1.5" />
      <circle cx="4" cy="11.5" r="2.3" fill="#FFFFFF" />
      <circle cx="11.5" cy="4" r="2.3" fill="#FFFFFF" />
      <circle cx="12.5" cy="12" r="1.7" fill="#FFFFFF" />
    </svg>
  );
  const tileStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size * 0.3,
    background: 'var(--grad-tile)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    boxShadow: 'var(--shadow-tile)',
  };
  const tile = variant === 'tile' ? <span style={tileStyle}>{glyph(size * 0.5)}</span> : glyph(size);
  if (!withWordmark) return <>{tile}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.37, color: '#FFFFFF' }}>
      {tile}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          fontSize: size * 0.55,
          letterSpacing: '-0.02em',
        }}
      >
        untacit<span style={{ color: 'var(--blue-400)' }}>_</span>
      </span>
    </span>
  );
}
