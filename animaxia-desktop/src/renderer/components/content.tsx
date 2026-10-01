/**
 * components/content.tsx — Content display building blocks: ContentCard
 * (poster card with rating/reason), ContentRow (horizontal scroller section)
 * and HeroCarousel (auto-advancing featured banner).
 *
 * Items use the compact MobileItem shape from the mobile-service BFF, so the
 * same cards render home rows, RAG picks, watchlist grids, "more like this"…
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Play, Star } from 'lucide-react';
import type { MobileItem } from '../api/mobile';
import { Button } from './primitives';

/* ------------------------------- ContentCard -------------------------------- */

export function ContentCard({
  item,
  reason,
  onOpen,
  width,
}: {
  item: Pick<MobileItem, 'id' | 'title' | 'type' | 'thumbnail' | 'rating' | 'year'> & {
    reason?: string;
  };
  reason?: string;
  onOpen?: (id: number) => void;
  width?: number;
}): React.JSX.Element {
  const why = reason ?? (item as { reason?: string }).reason;
  return (
    <button
      type="button"
      className="poster-card"
      style={width ? { width } : undefined}
      onClick={() => onOpen?.(item.id)}
      aria-label={`Open ${item.title}`}
    >
      <div className="poster-card__frame">
        {item.thumbnail ? (
          <img className="poster-card__img" src={item.thumbnail} alt="" loading="lazy" />
        ) : (
          <div className="poster-card__fallback">{item.title}</div>
        )}
        {item.rating != null ? <span className="poster-card__rating">★ {Number(item.rating).toFixed(1)}</span> : null}
        {why ? <span className="poster-card__reason">{why}</span> : null}
      </div>
      <div className="poster-card__title">{item.title}</div>
      <div className="poster-card__meta">
        <span>{item.type}</span>
        {item.year != null && item.year !== '' ? <span>·</span> : null}
        {item.year != null && item.year !== '' ? <span>{String(item.year)}</span> : null}
      </div>
    </button>
  );
}

/* ------------------------------- ContentRow --------------------------------- */

export function ContentRow({
  title,
  items,
  onOpen,
  right,
}: {
  title: string;
  items: (Pick<MobileItem, 'id' | 'title' | 'type' | 'thumbnail' | 'rating' | 'year'> & { reason?: string })[];
  onOpen: (id: number) => void;
  right?: React.ReactNode;
}): React.JSX.Element {
  if (!items || items.length === 0) return <></>;
  return (
    <section>
      <div className="section-header">
        <div className="section-header__title">{title}</div>
        {right ? <div className="section-header__right">{right}</div> : null}
      </div>
      <div className="row-scroller">
        {items.map((item) => (
          <ContentCard key={`${item.id}-${item.title}`} item={item} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------ HeroCarousel -------------------------------- */

export interface HeroSlide {
  id: number;
  title: string;
  type: string;
  overview?: string | null;
  thumbnail: string | null;
  backdrop?: string | null;
  rating?: number | null;
}

const AUTO_ADVANCE_MS = 7000;

export function HeroCarousel({
  slides,
  onPlay,
  onDetails,
}: {
  slides: HeroSlide[];
  onPlay: (id: number) => void;
  onDetails: (id: number) => void;
}): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const timer = useRef<number | null>(null);
  const count = slides.length;

  const clear = useCallback(() => {
    if (timer.current != null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    clear();
    if (count > 1) timer.current = window.setInterval(() => setIndex((n) => (n + 1) % count), AUTO_ADVANCE_MS);
  }, [clear, count]);

  useEffect(() => {
    schedule();
    return clear;
  }, [schedule, clear]);

  if (count === 0) return <></>;

  return (
    <div className="hero" onMouseEnter={clear} onMouseLeave={schedule}>
      {slides.map((slide, i) => (
        <div key={slide.id} className={`hero__slide${i === index ? ' hero__slide--on' : ''}`}>
          {slide.backdrop || slide.thumbnail ? (
            <img className="hero__img" src={slide.backdrop ?? slide.thumbnail ?? ''} alt="" />
          ) : null}
          <div className="hero__shade" />
          <div className="hero__content">
            <div className="hero__badge">
              <span className="badge badge--rose">
                {slide.type}
                {slide.rating != null ? ` · ★ ${Number(slide.rating).toFixed(1)}` : ''}
              </span>
            </div>
            <h1 className="hero__title">{slide.title}</h1>
            {slide.overview ? <p className="hero__overview">{slide.overview}</p> : null}
            <div className="hero__actions">
              <Button onClick={() => onPlay(slide.id)}>
                <Play size={15} /> Play
              </Button>
              <Button variant="ghost" onClick={() => onDetails(slide.id)}>
                <Info size={15} /> Details
              </Button>
            </div>
          </div>
        </div>
      ))}
      {count > 1 ? (
        <div className="hero__dots">
          {slides.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              className={`hero__dot${i === index ? ' hero__dot--on' : ''}`}
              aria-label={`Show ${slide.title}`}
              onClick={() => {
                setIndex(i);
                schedule();
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Small inline rating (used by Content/Player headers). */
export function RatingChip({ rating }: { rating: number | null | undefined }): React.JSX.Element | null {
  if (rating == null || !Number.isFinite(rating)) return null;
  return (
    <span className="badge badge--amber">
      <Star size={11} /> {Number(rating).toFixed(1)}
    </span>
  );
}
