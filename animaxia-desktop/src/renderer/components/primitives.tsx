/**
 * components/primitives.tsx — Small shared UI atoms: Button, Input, Textarea,
 * Badge, Avatar, Toggle, Tabs, SectionHeader. All styling comes from
 * globals.css classes; screens compose these instead of re-inventing them.
 */

import React, { useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';

/* --------------------------------- Button ---------------------------------- */

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  full = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = [
    'btn',
    variant !== 'primary' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    full ? 'btn--full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <span className="btn__spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------- Input ----------------------------------- */

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  hint?: string;
}

export function Input({ label, error, hint, id, ...rest }: InputProps): React.JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="field">
      {label ? (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input id={inputId} className="input" aria-invalid={Boolean(error)} {...rest} />
      {error ? <div className="field__error">{error}</div> : hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string | null;
  hint?: string;
}

export function Textarea({ label, error, hint, id, ...rest }: TextareaProps): React.JSX.Element {
  const autoId = useId();
  const areaId = id ?? autoId;
  return (
    <div className="field">
      {label ? (
        <label className="field__label" htmlFor={areaId}>
          {label}
        </label>
      ) : null}
      <textarea id={areaId} className="textarea" aria-invalid={Boolean(error)} {...rest} />
      {error ? <div className="field__error">{error}</div> : hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
}

/* ---------------------------------- Badge ----------------------------------- */

export type BadgeTone = 'rose' | 'emerald' | 'amber' | 'zinc';

export function Badge({
  tone = 'rose',
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}): React.JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/* ---------------------------------- Avatar ---------------------------------- */

export function Avatar({
  url,
  name,
  size = 40,
}: {
  url?: string | null;
  name?: string | null;
  size?: number;
}): React.JSX.Element {
  const initial = (name || '?').charAt(0).toUpperCase();
  return url ? (
    <img
      src={url}
      alt={name ? `${name} avatar` : 'Avatar'}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
    />
  ) : (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--rose-tint)',
        border: '1px solid var(--rose-line)',
        color: 'var(--rose-soft)',
        fontWeight: 800,
        fontSize: size / 2.4,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

/* ---------------------------------- Toggle ---------------------------------- */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle${checked ? ' toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <span className="toggle__track">
        <span className="toggle__thumb" />
      </span>
      {label ? <span className="toggle__label">{label}</span> : null}
    </button>
  );
}

/* ----------------------------------- Tabs ----------------------------------- */

export interface TabOption<V extends string> {
  value: V;
  label: string;
}

export function Tabs<V extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: TabOption<V>[];
  value: V;
  onChange: (value: V) => void;
}): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          className={`tabs__tab${tab.value === value ? ' tabs__tab--on' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ SectionHeader ------------------------------- */

export function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="section-header">
      <div className="section-header__title">{title}</div>
      {subtitle ? <div className="section-header__subtitle">{subtitle}</div> : null}
      {right ? <div className="section-header__right">{right}</div> : null}
    </div>
  );
}
