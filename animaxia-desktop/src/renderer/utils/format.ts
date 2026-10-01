/**
 * utils/format.ts — Small formatting helpers shared by the screens
 * (timecodes, relative dates, progress percent, plan labels).
 */

/** 7823 → "2:10:23" (seconds → h:mm:ss / m:ss). */
export function formatTimecode(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || (seconds ?? 0) < 0) return '0:00';
  const total = Math.floor(seconds as number);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "2 h 10 m" style runtime for content metadata. */
export function formatRuntime(seconds: number | null | undefined): string | null {
  if (!Number.isFinite(seconds) || (seconds ?? 0) <= 0) return null;
  const total = Math.floor(seconds as number);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  return `${m} m`;
}

/** Compact relative time ("3 m ago", "2 h ago", "5 d ago", "Sep 3"). */
export function formatRelative(iso: string | number | null | undefined): string {
  if (iso == null) return '';
  const date = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  const time = date.getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 0–100 progress clamp for history rows. */
export function progressPercent(progress: number | null | undefined): number {
  if (!Number.isFinite(progress as number)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress as number)));
}

/** "Free" | "Plus" | "Pro" display label for plan keys. */
export function planLabel(plan: string | null | undefined): string {
  if (!plan) return 'Free';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Truncate long overviews for cards ("…"). */
export function truncate(text: string | null | undefined, max = 180): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
