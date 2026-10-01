'use client';

/**
 * section.tsx — Page section wrapper with title, subtitle and optional action.
 */

import { cn } from '@/lib/utils';

export function Section({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-4', className)}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-4">
          <div>
            {title && <h2 className="text-lg font-bold tracking-tight text-zinc-100 sm:text-xl">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500 sm:text-sm">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="space-y-2">
      <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">{title}</h1>
      {subtitle && <p className="max-w-2xl text-sm text-zinc-400">{subtitle}</p>}
      {children}
    </header>
  );
}

export function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>;
}
