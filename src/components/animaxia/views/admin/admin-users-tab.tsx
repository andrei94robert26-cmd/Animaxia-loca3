'use client';

/**
 * admin-users-tab.tsx — TS2b: admin user management. Real users from
 * GET /api/admin/users (admin-gated) in a searchable, paginated table
 * (10/page, client-side) with confirm dialogs for ban/unban and
 * promote/demote — PATCH /api/admin/users/:id is guarded server-side too
 * (no self-demote, no self-ban, no last-admin demotion, no banning admins).
 * Deep-linked via #/admin/users.
 */

import { useMemo, useState } from 'react';
import {
  BadgeCheck,
  Ban,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '../../auth-provider';
import type { AdminUserRow } from '@/lib/animaxia/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState } from '../../states';
import { Pagination } from '../../pagination';
import { cn } from '@/lib/utils';

/* ------------------------------- helpers ------------------------------- */

const PAGE_SIZE = 10;

function isForbidden(message: string | null): boolean {
  return Boolean(message && /admin access required|forbidden|status 40[13]/i.test(message));
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `acum ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `acum ${days}z`;
  const months = Math.floor(days / 30);
  if (months < 12) return `acum ${months}l`;
  return `acum ${Math.floor(months / 12)}a`;
}

/* -------------------------------- badges -------------------------------- */

function UserBadges({ user }: { user: AdminUserRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {user.isadmin && (
        <Badge className="border-rose-500/30 bg-rose-500/15 text-[10px] font-bold text-rose-300 hover:bg-rose-500/15">
          <ShieldCheck className="mr-1 h-3 w-3" aria-hidden /> Admin
        </Badge>
      )}
      {user.twofaenabled && (
        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/10">
          2FA
        </Badge>
      )}
      {user.emailverified && (
        <Badge className="border-sky-500/30 bg-sky-500/10 text-[10px] font-bold text-sky-300 hover:bg-sky-500/10">
          <BadgeCheck className="mr-1 h-3 w-3" aria-hidden /> Verificat
        </Badge>
      )}
      {user.banned && (
        <Badge className="border-red-500/40 bg-red-500/15 text-[10px] font-bold text-red-300 hover:bg-red-500/15">
          <Ban className="mr-1 h-3 w-3" aria-hidden /> Banat
        </Badge>
      )}
      {!user.isadmin && !user.twofaenabled && !user.emailverified && !user.banned && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">user</span>
      )}
    </span>
  );
}

/* ------------------------------ lock card ------------------------------ */

function LockCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Sunt necesare drepturi de administrator</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            Conectează-te ca administrator pentru a gestiona utilizatorii platformei.
          </p>
          <p className="mt-1 text-xs text-zinc-600">Admin demo: admin@animaxia.test</p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Conectare
        </Button>
      </CardContent>
    </Card>
  );
}

/* --------------------------------- tab --------------------------------- */

type PendingAction =
  | { kind: 'ban'; user: AdminUserRow }
  | { kind: 'unban'; user: AdminUserRow }
  | { kind: 'promote'; user: AdminUserRow }
  | { kind: 'demote'; user: AdminUserRow };

export function AdminUsersTab() {
  const { user: me, isAdmin, initializing } = useAuth();
  const users = useApi('admin:users', () => api.adminUsers.list(), { enabled: !initializing && isAdmin });

  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [mutating, setMutating] = useState(false);

  const locked = !initializing && (!isAdmin || (users.error != null && isForbidden(users.error)));

  /* Client-side search filter (username + email, case-insensitive). */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = users.data?.data ?? [];
    if (!q) return all;
    return all.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users.data, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function runAction() {
    if (!pending || mutating) return;
    setMutating(true);
    try {
      if (pending.kind === 'ban' || pending.kind === 'unban') {
        const banned = pending.kind === 'ban';
        await api.adminUsers.patch(pending.user.id, { banned });
        toast.success(banned ? `„${pending.user.username}” a fost suspendat` : `„${pending.user.username}” a fost reactivat`);
      } else {
        const isadmin = pending.kind === 'promote';
        await api.adminUsers.patch(pending.user.id, { isadmin });
        toast.success(
          isadmin
            ? `„${pending.user.username}” a fost promovat administrator`
            : `„${pending.user.username}” a fost retrogradat la user`,
        );
      }
      setPending(null);
      await users.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Acțiunea a eșuat');
    } finally {
      setMutating(false);
    }
  }

  if (locked) return <LockCard />;

  if (users.loading && !users.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (users.error && !users.data) {
    return <ErrorState message={users.error} onRetry={() => void users.refetch()} compact />;
  }

  const all = users.data?.data ?? [];
  const bannedCount = all.filter((u) => u.banned).length;
  const adminCount = all.filter((u) => u.isadmin).length;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-semibold text-zinc-300">
            <Users className="h-3.5 w-3.5 text-rose-400" aria-hidden /> {all.length} utilizatori
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
            <ShieldCheck className="h-3.5 w-3.5 text-rose-400" aria-hidden /> {adminCount} admini
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
            <Ban className="h-3.5 w-3.5 text-red-400" aria-hidden /> {bannedCount} suspendați
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Filtrează după nume sau email…"
              aria-label="Filtrează utilizatorii"
              className="h-9 w-56 border-white/10 bg-white/5 pl-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-rose-500/50"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
            onClick={() => void users.refetch()}
          >
            <RefreshCw aria-hidden /> Reîmprospătează
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="p-0">
          {pageRows.length === 0 ? (
            <div className="p-8">
              <EmptyState
                icon={<UserRound className="h-6 w-6" aria-hidden />}
                title={query.trim() ? 'Niciun utilizator găsit' : 'Niciun utilizator'}
                message={
                  query.trim()
                    ? `Nimic pentru „${query.trim()}” — încearcă alt termen.`
                    : 'Conturile create pe platformă vor apărea aici.'
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/10 hover:bg-transparent">
                    <TableHead className="pl-4 text-zinc-400">Utilizator</TableHead>
                    <TableHead className="text-zinc-400">Badge-uri</TableHead>
                    <TableHead className="text-zinc-400">Creat</TableHead>
                    <TableHead className="text-zinc-400">Ultima conectare</TableHead>
                    <TableHead className="pr-4 text-right text-zinc-400">Acțiuni</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((u) => {
                    const isMe = me?.id === u.id;
                    return (
                      <TableRow key={u.id} className="border-white/5">
                        <TableCell className="pl-4">
                          <div className="flex items-center gap-2.5">
                            <span
                              className={cn(
                                'grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-black',
                                u.banned
                                  ? 'bg-red-500/15 text-red-300'
                                  : u.isadmin
                                    ? 'bg-rose-500/20 text-rose-200'
                                    : 'bg-gradient-to-br from-white/15 to-white/5 text-zinc-300',
                              )}
                              aria-hidden
                            >
                              {u.username.slice(0, 2).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5">
                                <span className={cn('truncate text-sm font-semibold', u.banned ? 'text-red-300 line-through' : 'text-zinc-100')}>
                                  {u.username}
                                </span>
                                {isMe && (
                                  <span className="rounded bg-white/10 px-1 text-[10px] font-bold text-zinc-400">tu</span>
                                )}
                              </span>
                              <span className="block max-w-[220px] truncate text-xs text-zinc-500">{u.email}</span>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <UserBadges user={u} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                          {relativeTime(u.createdat)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                          {relativeTime(u.lastloginat)}
                        </TableCell>
                        <TableCell className="pr-4">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={mutating || isMe}
                              onClick={() => setPending(u.banned ? { kind: 'unban', user: u } : { kind: 'ban', user: u })}
                              className={cn(
                                'h-8 border-white/15 bg-white/5 text-xs font-semibold hover:bg-white/10',
                                u.banned
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                                  : 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20',
                                isMe && 'opacity-50',
                              )}
                              title={isMe ? 'Nu îți poți suspenda propriul cont' : undefined}
                            >
                              {u.banned ? 'Reactivează' : 'Suspendă'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={mutating || isMe}
                              onClick={() => setPending(u.isadmin ? { kind: 'demote', user: u } : { kind: 'promote', user: u })}
                              className={cn(
                                'h-8 border-white/15 bg-white/5 text-xs font-semibold hover:bg-white/10',
                                isMe && 'opacity-50',
                              )}
                              title={isMe ? 'Nu îți poți retrage singur statutul de administrator' : undefined}
                            >
                              {u.isadmin ? 'Retrogradează' : 'Promovează'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {filtered.length > PAGE_SIZE && (
        <Pagination page={safePage} totalPages={totalPages} onPage={setPage} />
      )}

      {/* Confirm dialog */}
      <AlertDialog open={pending !== null} onOpenChange={(open) => (open ? null : setPending(null))}>
        <AlertDialogContent className="border-white/10 bg-[#12121c] text-zinc-100">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {pending?.kind === 'ban' && (
                <>
                  <Ban className="h-5 w-5 text-red-400" aria-hidden /> Suspendă „{pending?.user.username}”?
                </>
              )}
              {pending?.kind === 'unban' && (
                <>
                  <BadgeCheck className="h-5 w-5 text-emerald-400" aria-hidden /> Reactivează „{pending?.user.username}”?
                </>
              )}
              {pending?.kind === 'promote' && (
                <>
                  <ShieldCheck className="h-5 w-5 text-rose-400" aria-hidden /> Promovează „{pending?.user.username}” administrator?
                </>
              )}
              {pending?.kind === 'demote' && (
                <>
                  <Trash2 className="h-5 w-5 text-amber-400" aria-hidden /> Retrogradează „{pending?.user.username}”?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              {pending?.kind === 'ban' &&
                'Contul nu se va mai putea conecta (login → „Cont suspendat”). Poate fi reactivat oricând.'}
              {pending?.kind === 'unban' && 'Contul își va recăpăta accesul la autentificare imediat.'}
              {pending?.kind === 'promote' &&
                '⚠️ ATENȚIE: administratorii pot gestiona conținutul, utilizatorii și setările platformei. Acordă acest drept doar persoanelor de încredere.'}
              {pending?.kind === 'demote' &&
                'Utilizatorul pierde accesul la panoul de administrare, iar sesiunile sale active sunt revocate (trebuie să se reconecteze).'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/15 bg-white/5 hover:bg-white/10" disabled={mutating}>
              Anulează
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runAction();
              }}
              disabled={mutating}
              className={cn(
                'font-bold',
                pending?.kind === 'ban' && 'bg-red-600 hover:bg-red-500',
                pending?.kind === 'unban' && 'bg-emerald-600 hover:bg-emerald-500',
                (pending?.kind === 'promote' || pending?.kind === 'demote') && 'bg-rose-600 hover:bg-rose-500',
              )}
            >
              {mutating && <Loader2 className="animate-spin" aria-hidden />}
              Confirmă
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
