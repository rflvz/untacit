import type { CSSProperties } from 'react';

/**
 * Callout glass flotante con tile del glifo (components/surfaces/Callout.jsx):
 * título en sans 650 + metadato mono. `float` activa la animación omFloat.
 */
export function Callout({
  title,
  meta,
  float = false,
  style,
}: {
  title: string;
  meta?: string;
  float?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-callout-glass)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        border: '1px solid var(--border-glass-strong)',
        borderRadius: 'var(--radius-callout)',
        padding: '10px 16px 10px 11px',
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14), 0 18px 48px rgba(0,0,0,0.6)',
        animation: float ? 'omFloat 6.5s ease-in-out infinite' : 'none',
        ...style,
      }}
    >
      <span
        style={{
          width: 27,
          height: 27,
          borderRadius: 8,
          background: 'var(--grad-tile)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3)',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <line x1="4" y1="11.5" x2="11.5" y2="4" stroke="#FFFFFF" strokeWidth="1.6" />
          <circle cx="4" cy="11.5" r="2.4" fill="#FFFFFF" />
          <circle cx="11.5" cy="4" r="2.4" fill="#FFFFFF" />
        </svg>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '12.5px',
            fontWeight: 650,
            color: '#EAF0FA',
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </span>
        {meta !== undefined && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-muted)' }}>
            {meta}
          </span>
        )}
      </span>
    </div>
  );
}
