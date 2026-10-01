/**
 * screens/MiniPlayerScreen.tsx — The standalone always-on-top mini-player
 * window (frameless, loads index.html#/mini-player — no Shell/sidebar).
 *
 *   • On mount: window.animaxia.miniPlayer.getData() → payload; null → a tiny
 *     "Nothing playing" note with a close button.
 *   • Compact layout: draggable title bar (expand → main window navigates to
 *     /player/:id?resume=<position>, mini closes; X → close) + VideoPlayer in
 *     fill mode (autoPlay, resume position, no contentId — the mini window
 *     reports progress through the mini-player IPC channel instead).
 *   • onReplaced swaps the payload live — VideoPlayer re-arms on source change
 *     and re-seeks when the position changes.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { VideoPlayer } from '../player/VideoPlayer';
import type { VideoPlayerHandle } from '../player/VideoPlayer';
import vpStyles from '../player/VideoPlayer.module.css';
import { Button } from '../components/primitives';
import styles from './MiniPlayerScreen.module.css';

export default function MiniPlayerScreen(): React.JSX.Element {
  const [payload, setPayload] = useState<MiniPlayerPayload | null>(null);
  const [booted, setBooted] = useState(false);
  const playerRef = useRef<VideoPlayerHandle>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.animaxia) {
      setBooted(true);
      return undefined;
    }
    const bridge = window.animaxia;
    let cancelled = false;

    bridge.miniPlayer
      .getData()
      .then((data) => {
        if (!cancelled) {
          setPayload(data);
          setBooted(true);
        }
      })
      .catch(() => {
        if (!cancelled) setBooted(true);
      });

    // Reuse path: the main window popped a different title into this window.
    const offReplaced = bridge.miniPlayer.onReplaced((next) => {
      if (!cancelled) setPayload(next);
    });

    return () => {
      cancelled = true;
      offReplaced();
    };
  }, []);

  /* Progress → playback store through the mini-player IPC (throttled by the
     VideoPlayer's ~10s onPosition cadence + pause/unmount flush). */
  const handlePosition = useCallback((position: number, duration: number) => {
    try {
      window.animaxia?.miniPlayer.reportProgress({ position, duration });
    } catch {
      /* best-effort */
    }
  }, []);

  const expand = useCallback(() => {
    const position = playerRef.current?.getPosition() ?? payload?.position ?? 0;
    try {
      window.animaxia?.miniPlayer.expand(Math.max(0, Math.floor(position)));
    } catch {
      /* ignore */
    }
  }, [payload]);

  const close = useCallback(() => {
    try {
      window.animaxia?.miniPlayer.close();
    } catch {
      /* ignore */
    }
  }, []);

  if (!booted) {
    return (
      <div className={`${styles.root} ${styles.boot}`} role="status" aria-live="polite">
        <div className="spinner" />
      </div>
    );
  }

  if (!payload) {
    return (
      <div className={`${styles.root} ${styles.empty}`}>
        <p className={styles.emptyText}>Nothing playing</p>
        <Button size="sm" variant="ghost" onClick={close}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <span className={styles.title} title={payload.title}>
          {payload.title}
        </span>
        <button
          type="button"
          className={styles.tool}
          onClick={expand}
          aria-label="Expand to the main window"
          title="Expand"
        >
          <Maximize2 size={13} />
        </button>
        <button type="button" className={styles.tool} onClick={close} aria-label="Close mini-player" title="Close">
          <X size={14} />
        </button>
      </header>
      <div className={styles.stage}>
        <VideoPlayer
          ref={playerRef}
          className={vpStyles.fill}
          source={payload.source}
          poster={payload.thumbnail}
          autoPlay
          initialPosition={payload.position}
          onPosition={handlePosition}
        />
      </div>
    </div>
  );
}
