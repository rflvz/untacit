import type { ReactNode } from 'react';

/**
 * Cabecera de sección del design system (components/layout/SectionHeader.jsx):
 * kicker mono `01 / grafo` con el número en azul y titular Archivo 760 con
 * tracking -0.04em. Escala reducida para páginas de la app (la landing usa
 * clamp(32px,3.6vw,52px)).
 */
export function SectionHeader({
  number,
  kicker,
  title,
  lead,
  actions,
}: {
  number: string;
  kicker: string;
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <p
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-kicker)',
          fontWeight: 500,
          color: 'var(--text-faint)',
          margin: '0 0 10px',
        }}
      >
        <span style={{ color: 'var(--accent-heading)', fontWeight: 600 }}>{number}</span> / {kicker}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 26,
            lineHeight: 'var(--leading-h2)',
            letterSpacing: 'var(--tracking-h2)',
            fontWeight: 760,
            color: 'var(--text-heading)',
            fontFamily: 'var(--font-sans)',
            textWrap: 'pretty',
          }}
        >
          {title}
        </h2>
        {actions !== undefined && <div style={{ marginLeft: 'auto' }}>{actions}</div>}
      </div>
      {lead !== undefined && (
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 14.5,
            color: 'var(--text-body)',
            maxWidth: '62ch',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {lead}
        </p>
      )}
    </div>
  );
}
