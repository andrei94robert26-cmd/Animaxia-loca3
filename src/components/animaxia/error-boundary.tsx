'use client';

/**
 * error-boundary.tsx — Render-error containment (FAZA 17).
 *
 * A crash inside any view must never take the whole SPA down (white screen).
 * Wrap the active view switch in page.tsx with this boundary: a render error
 * is replaced by a friendly Romanian card with "Reîncearcă" (resets the
 * boundary state) and, optionally, "Înapoi acasă" (navigate('/home')).
 *
 * Only render-phase errors are caught (getDerivedStateFromError +
 * componentDidCatch). There is no external error reporting — the optional
 * onError callback is the only side channel.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { navigate } from '@/lib/animaxia/router';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Fallback card title (default: "Ceva s-a stricat aici"). */
  title?: string;
  /** Friendly description shown under the title. */
  description?: string;
  /** Show the "Înapoi acasă" button (default: true). */
  showHome?: boolean;
  /** Optional local hook (logging, analytics) — no external reporting. */
  onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  /** "Reîncearcă" — clears the error so the children re-render from scratch. */
  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const {
      title = 'Ceva s-a stricat aici',
      description = 'A apărut o eroare neașteptată la afișarea acestei secțiuni. Restul platformei funcționează în continuare — poți reîncerca sau să te întorci acasă.',
      showHome = true,
    } = this.props;

    return (
      <div
        role="alert"
        className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center sm:p-10"
      >
        <span className="grid h-12 w-12 place-items-center rounded-2xl border border-rose-500/30 bg-rose-500/10">
          <AlertTriangle className="h-6 w-6 text-rose-400" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <p className="max-w-md text-sm leading-relaxed text-zinc-400">{description}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <Button onClick={this.reset} className="bg-rose-600 font-bold hover:bg-rose-500">
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Reîncearcă
          </Button>
          {showHome && (
            <Button
              variant="outline"
              onClick={() => navigate('/home')}
              className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            >
              <Home className="mr-1.5 h-4 w-4" aria-hidden />
              Înapoi acasă
            </Button>
          )}
        </div>
      </div>
    );
  }
}
