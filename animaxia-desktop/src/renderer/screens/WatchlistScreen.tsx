/**
 * screens/WatchlistScreen.tsx — Saved titles (/api/users/me/watchlist).
 *
 * Poster grid (grid--posters) of ContentCards with a remove chip per card
 * (optimistic via the useWatchlist hook). Plan limits are enforced
 * server-side (free 20 · plus 200 · pro unlimited) — a failed mutation
 * surfaces the server message inline. Auth is enforced by the AuthGate in
 * app.tsx; the fetcher-null guard below keeps the screen safe regardless.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, RefreshCw, X } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useWatchlist } from '../watchlist/useWatchlist';
import { ContentCard } from '../components/content';
import { Button, SectionHeader } from '../components/primitives';
import { EmptyState, ErrorState, SignInCard, Skeleton } from '../components/states';
import styles from './WatchlistScreen.module.css';

export default function WatchlistScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const wl = useWatchlist(user != null);

  return (
    <div>
      <SectionHeader
        title="Watchlist"
        subtitle={
          user
            ? `${wl.entries.length} saved${wl.stale ? ' · cached copy' : ''} · more with Plus / Pro`
            : undefined
        }
        right={
          user && wl.entries.length > 0 ? (
            <Button variant="ghost" size="sm" loading={wl.refreshing} onClick={wl.load}>
              <RefreshCw size={13} /> Refresh
            </Button>
          ) : undefined
        }
      />

      {wl.lastError ? (
        <div className="row row--wrap" style={{ marginBottom: 14 }}>
          <span className="badge badge--amber">{wl.lastError}</span>
          <Button variant="ghost" size="sm" onClick={wl.clearLastError}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {!user ? (
        <SignInCard message="Sign in to keep your watchlist across devices — it syncs with the web console." />
      ) : wl.loading ? (
        <div className="grid grid--posters">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} h={230} radius={12} />
          ))}
        </div>
      ) : wl.error ? (
        <ErrorState message={wl.error} onRetry={wl.load} />
      ) : wl.entries.length === 0 ? (
        <EmptyState
          title="Your watchlist is empty"
          hint="Save any title you like — your list syncs across the app and the web console."
          action={
            <Button onClick={() => navigate('/')}>
              <Bookmark size={14} /> Browse Home
            </Button>
          }
        />
      ) : (
        <div className="grid grid--posters">
          {wl.entries.map((entry) => (
            <div key={entry.content.id} className={styles.slot}>
              <ContentCard item={entry.content} onOpen={(id) => navigate(`/content/${id}`)} />
              <button
                type="button"
                className={styles.remove}
                onClick={() => {
                  void wl.toggle(entry.content.id);
                }}
                aria-label={`Remove ${entry.content.title || 'title'} from watchlist`}
                title="Remove from watchlist"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
