/**
 * components/states.tsx — Loading / Error / Empty / Skeleton / SignIn /
 * Upgrade state displays. Every screen renders these instead of bespoke
 * placeholders, so the offline/quota/auth states look identical everywhere.
 */

import React from 'react';
import { AlertTriangle, LogIn, RefreshCw, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function LoadingState({ label = 'Loading…', compact = false }: { label?: string; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`state${compact ? ' state--compact' : ''}`} role="status" aria-live="polite">
      <div className="spinner" />
      <div className="state__title">{label}</div>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={`state state--error${compact ? ' state--compact' : ''}`} role="alert">
      <AlertTriangle size={22} color="var(--red)" />
      <div className="state__title">{message}</div>
      {onRetry ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={onRetry}>
          <RefreshCw size={13} /> Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="state">
      <div className="state__title">{title}</div>
      {hint ? <p className="state__hint">{hint}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({
  w,
  h,
  radius,
  className = '',
  style,
}: {
  w?: number | string;
  h?: number | string;
  radius?: number;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width: w, height: h, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}

export function SkeletonRow({ count = 6, height = 230 }: { count?: number; height?: number }): React.JSX.Element {
  return (
    <div className="row-scroller" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} w={168} h={height} radius={12} />
      ))}
    </div>
  );
}

/** Auth-gated feature placeholder with a jump to the Auth screen. */
export function SignInCard({ message }: { message: string }): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  if (user) return <></>;
  return (
    <div className="state">
      <LogIn size={22} color="var(--rose-soft)" />
      <div className="state__title">Sign in to continue</div>
      <p className="state__hint">{message}</p>
      <button type="button" className="btn" onClick={() => navigate('/auth')}>
        Sign in / Register
      </button>
    </div>
  );
}

/** 402 quota placeholder with a jump to Premium. */
export function UpgradeCard({ message }: { message: string }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="state">
      <Sparkles size={22} color="var(--amber)" />
      <div className="state__title">Daily AI quota reached</div>
      <p className="state__hint">{message}</p>
      <button type="button" className="btn" onClick={() => navigate('/premium')}>
        See Premium plans
      </button>
    </div>
  );
}
