'use client';

/**
 * router.ts — Hash-based SPA router. The platform constraint allows only the
 * `/` Next.js route, so all "pages" (home, category, franchise, content,
 * player, search, recommendations, admin) are views switched by location.hash.
 *
 * Hash formats:
 *   #/home | #/category/movie | #/content/12 | #/content/ext:anime:1535
 *   #/player/12 | #/search?q=naruto | #/franchise?q=Naruto
 *   #/recommendations | #/admin
 */

import { useEffect, useState } from 'react';
import type { NormalizedItem } from './types';

export interface AppRoute {
  view: string;
  params: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): AppRoute {
  const raw = (hash || '').replace(/^#/, '');
  const pathPart = raw.split('?')[0] || '';
  const queryPart = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const segments = pathPart
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const view = segments[0] || 'home';
  const params = segments.slice(1);
  return { view, params, query: new URLSearchParams(queryPart) };
}

/** Returns null until mounted (avoids SSR/hydration mismatch on deep links). */
export function useRoute(): AppRoute | null {
  const [route, setRoute] = useState<AppRoute | null>(null);
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function navigate(to: string) {
  let target = to.startsWith('#') ? to : `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

/* ------------------- in-memory cache for external items ------------------- */

const itemCache = new Map<string, NormalizedItem>();

export const extItemCache = {
  put(key: string, item: NormalizedItem) {
    itemCache.set(key, item);
  },
  get(key: string): NormalizedItem | undefined {
    return itemCache.get(key);
  },
};

/* ------------------------------ link targets ------------------------------ */

export interface LinkTarget {
  kind: 'internal' | 'external';
  href: string;
}

export function targetForItem(item: NormalizedItem): LinkTarget | null {
  if (item.kind === 'db' && item.dbId != null) {
    return { kind: 'internal', href: `/content/${item.dbId}` };
  }
  if (item.kind === 'external' && item.extType && item.extId) {
    extItemCache.put(`ext:${item.extType}:${item.extId}`, item);
    return { kind: 'internal', href: `/content/ext:${item.extType}:${item.extId}` };
  }
  if (item.kind === 'link' && item.url) {
    return { kind: 'external', href: item.url };
  }
  return null;
}

/* ------------------------------ shared consts ------------------------------ */

export const franchiseChips = [
  'Naruto',
  'One Piece',
  'Dragon Ball',
  'Demon Slayer',
  'Jujutsu Kaisen',
  'Attack on Titan',
  'My Hero Academia',
  'Spy x Family',
  'Marvel',
  'Star Wars',
  'Harry Potter',
  'Lord of the Rings',
  'DC Universe',
  'James Bond',
  'Fast & Furious',
  'Mission: Impossible',
];
