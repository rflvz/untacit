import type { CSSProperties, ReactNode } from 'react';

export interface TerminalLine {
  cmd: ReactNode;
  prompt?: boolean;
  comment?: string;
}

/**
 * Ventana de terminal del design system (components/surfaces/Terminal.jsx):
 * traffic lights, título mono centrado, código a line-height 2.15 y prompt
 * `$` cian. El motivo visual de la marca para todo lo que sea código o diff.
 */
export function Terminal({
  title,
  rightMeta,
  action,
  lines,
  dense = false,
  children,
  style,
}: {
  title?: string;
  rightMeta?: string;
  action?: ReactNode;
  lines?: TerminalLine[];
  dense?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-terminal)',
        border: '1px solid var(--border-glass-mid)',
        borderRadius: 'var(--radius-terminal)',
        textAlign: 'left',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-terminal)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 18px',
          borderBottom: '1px solid var(--border-inner)',
        }}
      >
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
            <span
              key={c}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: c,
                opacity: 0.85,
                display: 'block',
              }}
            />
          ))}
        </div>
        {title !== undefined && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#8FA0BE' }}>
            {title}
          </span>
        )}
        {action ??
          (rightMeta !== undefined ? (
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faintest)' }}
            >
              {rightMeta}
            </span>
          ) : (
            <span />
          ))}
      </div>
      <div
        style={{
          padding: '24px 26px',
          fontFamily: 'var(--font-mono)',
          fontSize: dense ? 13 : 14,
          lineHeight: dense ? 1.85 : 2.15,
          overflowX: 'auto',
        }}
      >
        {lines
          ? lines.map((l, i) => (
              <p key={i} style={{ margin: 0, color: 'var(--text-code)' }}>
                {l.prompt !== false && <span style={{ color: 'var(--prompt)' }}>$ </span>}
                {l.cmd}
                {l.comment !== undefined && (
                  <span style={{ color: 'var(--text-faint)' }}>
                    {'  '}# {l.comment}
                  </span>
                )}
              </p>
            ))
          : children}
      </div>
    </div>
  );
}

/** Cursor de bloque parpadeando (omBlink), para prompts vivos. */
export function TerminalCursor() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 9,
        height: 16,
        background: 'var(--blue-300)',
        verticalAlign: '-2px',
        animation: 'omBlink 1.15s steps(1) infinite',
      }}
    />
  );
}
