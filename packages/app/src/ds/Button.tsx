import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'glass' | 'nav';

/**
 * Botón del design system: primary (gradiente azul en píldora), glass
 * (mono translúcido con blur) y nav (píldora compacta de la barra).
 * Port de components/core/Button.jsx; `size="sm"` es la adaptación de
 * densidad para la app de escritorio (mismos estilos, padding menor).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  href,
  onClick,
  disabled,
  title,
  children,
  style,
}: {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  // A disabled <button> suppresses mouse events, so onMouseLeave never fires
  // while disabled — reset here or hover sticks across a disable→enable cycle.
  useEffect(() => {
    if (disabled) setHover(false);
  }, [disabled]);
  const h = hover && !disabled;
  const sm = size === 'sm';
  const base: CSSProperties = {
    display: 'inline-block',
    borderRadius: 'var(--radius-pill)',
    cursor: disabled ? 'default' : 'pointer',
    textDecoration: 'none',
    opacity: disabled ? 0.55 : 1,
    transition:
      'border-color 0.25s, background 0.25s, color 0.25s, transform 0.35s var(--ease-spring), box-shadow 0.35s',
    border: 'none',
  };
  const variants: Record<ButtonVariant, CSSProperties> = {
    primary: {
      background: h ? 'var(--grad-btn-hover)' : 'var(--grad-btn)',
      color: '#FFFFFF',
      fontFamily: 'var(--font-sans)',
      fontWeight: 650,
      fontSize: sm ? '13px' : '15.5px',
      padding: sm ? '8px 18px' : '15px 30px',
      letterSpacing: '-0.01em',
      boxShadow: h ? 'var(--shadow-btn-hover)' : 'var(--shadow-btn)',
      transform: h ? 'translateY(-2px)' : 'none',
    },
    glass: {
      fontFamily: 'var(--font-mono)',
      fontSize: sm ? '12px' : '13.5px',
      color: h ? '#FFFFFF' : '#B6C6E4',
      padding: sm ? '8px 16px' : '15px 24px',
      border: '1px solid ' + (h ? 'rgba(163,186,242,0.45)' : 'rgba(163,186,242,0.2)'),
      background: h ? 'rgba(148,178,255,0.1)' : 'rgba(148,178,255,0.05)',
      // Sin backdrop-filter (el DS original lleva blur(18px)): en la app este
      // botón vive dentro de GlassCards que ya filtran su fondo, y los
      // backdrop-filter anidados doble-filtran y rinden mal en WebKit.
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.09)',
      transform: h ? 'translateY(-2px)' : 'none',
    },
    nav: {
      color: '#FFFFFF',
      background: h ? 'rgba(148,178,255,0.16)' : 'rgba(148,178,255,0.08)',
      border: '1px solid ' + (h ? 'rgba(255,255,255,0.4)' : 'rgba(163,186,242,0.22)'),
      fontFamily: 'var(--font-sans)',
      fontWeight: 600,
      fontSize: sm ? '12.5px' : '13.5px',
      padding: sm ? '7px 15px' : '10px 20px',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
    },
  };
  const s: CSSProperties = { ...base, ...variants[variant], ...style };
  const shared = {
    style: s,
    title,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };
  if (href !== undefined) {
    return (
      <a
        href={disabled ? undefined : href}
        aria-disabled={disabled || undefined}
        {...shared}
        style={{ ...s, pointerEvents: disabled ? 'none' : undefined }}
        onClick={disabled ? undefined : onClick}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" {...shared} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
