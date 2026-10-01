'use client';

/**
 * collections.ts — "Colecțiile Mele" client-side store. Collections are
 * persisted in localStorage (per-device), each holding references to library
 * content (contentId + snapshot of title/thumbnail/type). Emits a custom
 * event so every open panel re-renders on change.
 */

import { useCallback, useEffect, useState } from 'react';

export interface CollectionItem {
  contentId: number;
  title: string;
  thumbnail: string | null;
  type: string;
  addedAt: string;
}

export interface UserCollection {
  id: string;
  name: string;
  createdAt: string;
  items: CollectionItem[];
}

const STORAGE_KEY = 'animaxia.collections.v1';
const CHANGE_EVENT = 'animaxia:collections-changed';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readAll(): UserCollection[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is UserCollection =>
        Boolean(c) &&
        typeof c === 'object' &&
        typeof (c as UserCollection).id === 'string' &&
        typeof (c as UserCollection).name === 'string' &&
        Array.isArray((c as UserCollection).items),
    );
  } catch {
    return [];
  }
}

function writeAll(collections: UserCollection[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
  } catch {
    /* storage full / private mode — collections stay in memory for this session */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function newId(): string {
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const collectionsStore = {
  list(): UserCollection[] {
    return readAll();
  },

  create(name: string): UserCollection | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const all = readAll();
    const collection: UserCollection = {
      id: newId(),
      name: trimmed,
      createdAt: new Date().toISOString(),
      items: [],
    };
    writeAll([...all, collection]);
    return collection;
  },

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    writeAll(readAll().map((c) => (c.id === id ? { ...c, name: trimmed } : c)));
  },

  remove(id: string): void {
    writeAll(readAll().filter((c) => c.id !== id));
  },

  add(id: string, item: Omit<CollectionItem, 'addedAt'>): boolean {
    const all = readAll();
    const target = all.find((c) => c.id === id);
    if (!target) return false;
    if (target.items.some((i) => i.contentId === item.contentId)) return true;
    writeAll(
      all.map((c) =>
        c.id === id ? { ...c, items: [...c.items, { ...item, addedAt: new Date().toISOString() }] } : c,
      ),
    );
    return true;
  },

  removeItem(id: string, contentId: number): void {
    writeAll(
      readAll().map((c) => (c.id === id ? { ...c, items: c.items.filter((i) => i.contentId !== contentId) } : c)),
    );
  },

  totalItems(): number {
    return readAll().reduce((sum, c) => sum + c.items.length, 0);
  },
};

/** React hook: live collections list that re-renders on any store change. */
export function useCollections(): UserCollection[] {
  const [collections, setCollections] = useState<UserCollection[]>([]);

  const refresh = useCallback(() => {
    setCollections(collectionsStore.list());
  }, []);

  useEffect(() => {
    /* Deferred via macrotask so setState never runs synchronously in the
       effect body (same convention as hooks.ts useApi). */
    const timer = setTimeout(refresh, 0);
    const handler = () => refresh();
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, [refresh]);

  return collections;
}
