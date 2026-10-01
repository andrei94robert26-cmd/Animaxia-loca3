'use client';

/**
 * footer.tsx — Sticky bottom footer (mt-auto on a min-h-screen flex column
 * root) with platform links, categories, backend resources and ZIP download.
 */

import { Download, Github, Play, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { navigate } from '@/lib/animaxia/router';

const EXPLORE_LINKS: { label: string; href: string }[] = [
  { label: 'Acasă', href: '/home' },
  { label: 'Căutare', href: '/search' },
  { label: 'Pentru tine', href: '/recommendations' },
  { label: 'Francize', href: '/franchise' },
];

const CATEGORY_LINKS: { label: string; href: string }[] = [
  { label: 'Filme', href: '/category/movie' },
  { label: 'Seriale', href: '/category/tv' },
  { label: 'Anime', href: '/category/anime' },
  { label: 'Sport', href: '/category/sports' },
  { label: 'Minate', href: '/category/mined' },
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
              aria-label="Acasă Animaxia"
            >
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-rose-500 to-fuchsia-600">
                <Play className="h-4.5 w-4.5 fill-white text-white" aria-hidden />
              </span>
              <span className="text-lg font-black tracking-tight text-white">
                ANIMA<span className="text-rose-400">XIA</span>
              </span>
            </button>
            <p className="mt-3 max-w-xs text-xs leading-relaxed text-zinc-500">
              O singură platformă pentru anime, filme, seriale, sport și știri. Conturi, planuri
              premium, feed-uri sociale, recomandări AI, analytics, motor de căutare, worker-i și un API
              mobil — pe un backend enterprise Express + Neon PostgreSQL.
            </p>
            <a href="/animaxia-platform.zip" download className="mt-4 inline-block">
              <Button
                size="sm"
                className="bg-rose-600 font-semibold text-white shadow-lg shadow-rose-900/30 hover:bg-rose-500"
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                Descarcă arhiva completă a platformei
              </Button>
            </a>
            <a href="/animaxia-backend.zip" download className="mt-2 inline-block">
              <Button
                size="sm"
                variant="outline"
                className="border-white/10 bg-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
              >
                <Download className="mr-2 h-4 w-4" aria-hidden />
                Doar backend
              </Button>
            </a>
          </div>

          <nav aria-label="Explorează">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Explorează</h3>
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

          <nav aria-label="Categorii">
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Categorii</h3>
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
                  Panou Admin
                </button>
              </li>
              <li>
                <a
                  href="/animaxia-platform.zip"
                  download
                  className="text-sm text-zinc-400 transition hover:text-rose-300"
                >
                  Arhiva completă (backend + frontend)
                </a>
              </li>
              <li>
                <a
                  href="/animaxia-backend.zip"
                  download
                  className="text-sm text-zinc-400 transition hover:text-rose-300"
                >
                  Arhiva backend (Express + Neon)
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
          <p className="text-xs text-zinc-600">© 2025 Animaxia — construit în scop demonstrativ.</p>
          <p className="flex items-center gap-1.5 text-xs text-zinc-600">
            <Github className="h-3.5 w-3.5" aria-hidden />
            Node.js + Express · Neon PostgreSQL · Next.js
          </p>
        </div>
      </div>
    </footer>
  );
}
