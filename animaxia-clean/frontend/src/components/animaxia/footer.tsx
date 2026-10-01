'use client';

/**
 * footer.tsx — Sticky bottom footer (mt-auto on a min-h-screen flex column
 * root) with platform links, categories, backend resources and ZIP download.
 */

import { Download, Github, Play, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { navigate } from '@/lib/animaxia/router';

const EXPLORE_LINKS: { label: string; href: string }[] = [
  { label: 'Home', href: '/home' },
  { label: 'Search', href: '/search' },
  { label: 'For You', href: '/recommendations' },
  { label: 'Franchises', href: '/franchise' },
];

const CATEGORY_LINKS: { label: string; href: string }[] = [
  { label: 'Movies', href: '/category/movie' },
  { label: 'TV Shows', href: '/category/tv' },
  { label: 'Anime', href: '/category/anime' },
  { label: 'Sports', href: '/category/sports' },
  { label: 'News', href: '/category/news' },
  { label: 'Mined', href: '/category/mined' },
];

export function Footer() {
  return (
    <footer className="mt-auto border-t border-white/10 bg-black/40 pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <button
              type="button"
              onClick={() => navigate('/home')}
              className="flex items-center gap-2.5"
              aria-label="Animaxia home"
            >
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-fuchsia-600">
                <Play className="h-4.5 w-4.5 fill-white text-white" aria-hidden />
              </span>
              <span className="text-lg font-black tracking-tight text-white">
                ANIMA<span className="text-rose-400">XIA</span>
              </span>
            </button>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-zinc-500">
              One platform for anime, movies, TV, sports and news. Accounts, premium plans, social
              feeds, AI recommendations, analytics, search engine, workers and a mobile API — on an
              enterprise Express + Neon PostgreSQL backend.
            </p>
            <a href="/animaxia-platform.zip" download className="mt-4 inline-block">
              <Button
                size="sm"
                className="bg-rose-600 font-semibold text-white shadow-lg shadow-rose-900/30 hover:bg-rose-500"
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                Download full platform ZIP
              </Button>
            </a>
            <a href="/animaxia-backend.zip" download className="mt-2 inline-block">
              <Button
                size="sm"
                variant="outline"
                className="border-white/10 bg-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                Backend only
              </Button>
            </a>
          </div>

          <nav aria-label="Explore">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Explore</h3>
            <ul className="mt-3 space-y-2">
              {EXPLORE_LINKS.map((link) => (
                <li key={link.href}>
                  <button
                    type="button"
                    onClick={() => navigate(link.href)}
                    className="text-sm text-zinc-400 transition hover:text-rose-300"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Categories">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Categories</h3>
            <ul className="mt-3 space-y-2">
              {CATEGORY_LINKS.map((link) => (
                <li key={link.href}>
                  <button
                    type="button"
                    onClick={() => navigate(link.href)}
                    className="text-sm text-zinc-400 transition hover:text-rose-300"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Backend">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Backend</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <button
                  type="button"
                  onClick={() => navigate('/admin')}
                  className="flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-rose-300"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  Admin panel
                </button>
              </li>
              <li>
                <a
                  href="/animaxia-platform.zip"
                  download
                  className="text-sm text-zinc-400 transition hover:text-rose-300"
                >
                  Full platform ZIP (backend + frontend)
                </a>
              </li>
              <li>
                <a
                  href="/animaxia-backend.zip"
                  download
                  className="text-sm text-zinc-400 transition hover:text-rose-300"
                >
                  Backend ZIP (Express + Neon)
                </a>
              </li>
              <li className="text-sm text-zinc-500">Express · Neon PostgreSQL</li>
              <li className="text-sm text-zinc-500">TMDB · Jikan · TVmaze</li>
              <li className="text-sm text-zinc-500">Football-Data · Ergast F1</li>
              <li className="text-sm text-zinc-500">BBC · CNN · NHK · Al Jazeera</li>
            </ul>
          </nav>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-white/5 pt-6 sm:flex-row">
          <p className="text-xs text-zinc-600">© 2026 Animaxia — platformă 100% reală, conținut live din huburile API.</p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-600">
            <Github className="h-3.5 w-3.5" aria-hidden />
            Node.js + Express · Neon PostgreSQL · Next.js
          </p>
        </div>
      </div>
    </footer>
  );
}
