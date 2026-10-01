'use client';

/**
 * admin-tenants-tab.tsx — FAZA 11 Tenant Admin Console: tenant registry with
 * usage rollups, create-tenant dialog, per-tenant limits editor, member
 * management, metered billing (summary + invoice generation + plan upgrades)
 * and the global tenant AI/vector status. Deep-linked via #/admin/tenants.
 */

import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { tenantApi, TENANT_PLANS, type Tenant, type TenantMember, type TenantLimits } from '@/lib/animaxia/tenant';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { useAuth } from '../auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState } from '../states';

/* ------------------------------- helpers --------------------------------- */

const PLAN_TONE: Record<string, string> = {
  free: 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300',
  starter: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  business: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  enterprise: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
};

function PlanBadge({ plan }: { plan: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide', PLAN_TONE[plan] ?? PLAN_TONE.free)}>
      {plan}
    </span>
  );
}

function fmtUsd(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 100 && n % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function fmtNum(v: number | null | undefined): string {
  return Number(v ?? 0).toLocaleString('en-US');
}

const METRIC_LABELS: Record<string, string> = {
  ai_call: 'AI calls',
  vector_index: 'Vector docs',
  storage_gb: 'Storage GB',
  api_request: 'API requests',
};

/* ------------------------------ forbidden -------------------------------- */

function ForbiddenCard() {
  return (
    <Card className="border-rose-500/20 bg-white/[0.03]">
      <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/10">
          <Lock className="h-6 w-6 text-rose-400" aria-hidden />
        </div>
        <div>
          <p className="font-semibold text-zinc-100">Admin access required</p>
          <p className="mt-1 max-w-md text-sm text-zinc-400">
            The tenant console manages platform-wide tenants, limits and billing.
          </p>
        </div>
        <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/auth')}>
          Sign in as admin
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- summary ---------------------------------- */

function SummaryChips() {
  const summary = useApi('tenant-billing-summary', () => tenantApi.billingSummary());
  if (summary.loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[74px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (summary.error && !summary.data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-zinc-400">
          <p className="text-lg font-black">—</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-70">MRR (est.)</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-zinc-400">
          <p className="text-lg font-black">—</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-70">Billing mode</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-zinc-400">
          <p className="text-lg font-black">—</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-70">Open invoices</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-zinc-400">
          <p className="text-lg font-black">—</p>
          <p className="text-[10px] font-semibold uppercase tracking-widest opacity-70">Paid invoices</p>
        </div>
      </div>
    );
  }
  const d = summary.data;
  const chips: { label: string; value: string; tone?: string }[] = [
    { label: 'MRR (est.)', value: fmtUsd(d?.mrrEstimateUsd) },
    { label: 'Billing mode', value: d?.mode === 'stripe-live' ? 'Stripe live' : 'Sandbox' },
    { label: 'Open invoices', value: fmtUsd(d?.invoices?.open?.totalUsd), tone: 'amber' },
    { label: 'Paid invoices', value: fmtUsd(d?.invoices?.paid?.totalUsd), tone: 'emerald' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {chips.map((c) => (
        <div
          key={c.label}
          className={cn(
            'rounded-xl border px-4 py-3',
            c.tone === 'amber'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : c.tone === 'emerald'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-white/10 bg-white/[0.04] text-zinc-300',
          )}
        >
          <p className="text-lg font-black leading-tight">{c.value}</p>
          <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest opacity-70">{c.label}</p>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------- usage bars --------------------------------- */

function UsageBar({ metric, total, cap }: { metric: string; total: number; cap?: number }) {
  const label = METRIC_LABELS[metric] ?? metric;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((total / cap) * 100)) : null;
  return (
    <div className="min-w-[150px] flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-400">{label}</span>
        <span className="font-mono text-[11px] text-zinc-300">
          {fmtNum(total)}
          {pct != null && <span className="text-zinc-500"> / {fmtNum(cap)} ({pct}%)</span>}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={cn('h-full rounded-full', (pct ?? 0) > 85 ? 'bg-rose-500' : (pct ?? 10) > 60 ? 'bg-amber-400' : 'bg-emerald-500')}
          style={{ width: `${pct != null ? Math.max(3, pct) : Math.min(100, Math.max(4, Math.log10(total + 1) * 18))}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------ create form ------------------------------- */

function CreateTenantForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<(typeof TENANT_PLANS)[number]>('starter');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
      toast.error('Slug must be 3-40 chars: lowercase letters, digits, hyphens');
      return;
    }
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setBusy(true);
    try {
      const res = await tenantApi.create({ slug, name: name.trim(), plan });
      toast.success(`Tenant '${res.tenant.slug}' created (${plan})`);
      setSlug('');
      setName('');
      setOpen(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setBusy(false);
    }
  }, [slug, name, plan, onCreated]);

  return (
    <>
      <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => setOpen((v) => !v)}>
        {open ? <X aria-hidden /> : <Plus aria-hidden />}
        {open ? 'Cancel' : 'New tenant'}
      </Button>
      {open && (
        <Card className="border-rose-500/20 bg-white/[0.03]">
          <CardContent className="grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="tenant-slug" className="text-xs text-zinc-400">Slug</Label>
              <Input
                id="tenant-slug"
                placeholder="acme"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className="border-white/15 bg-white/5 font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tenant-name" className="text-xs text-zinc-400">Display name</Label>
              <Input
                id="tenant-name"
                placeholder="ACME Streaming"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="border-white/15 bg-white/5"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-zinc-400">Plan</Label>
              <Select value={plan} onValueChange={(v) => setPlan(v as (typeof TENANT_PLANS)[number])}>
                <SelectTrigger className="w-[140px] border-white/15 bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TENANT_PLANS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={submit} disabled={busy} className="font-bold">
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              Create
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}

/* ------------------------------ limits editor ----------------------------- */

const LIMIT_FIELDS: { key: keyof TenantLimits; label: string }[] = [
  { key: 'maxusers', label: 'Max users' },
  { key: 'aiperday', label: 'AI / day' },
  { key: 'ratelimitpermin', label: 'Rate / min' },
  { key: 'vectorcollections', label: 'Vector collections' },
  { key: 'storagegb', label: 'Storage GB' },
];

function LimitsEditor({ tenant, onSaved }: { tenant: Tenant; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(tenant.limits[f.key] ?? 0)])),
  );
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      const body: Record<string, number> = {};
      for (const f of LIMIT_FIELDS) {
        const v = Number(draft[f.key]);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${f.label} must be a non-negative number`);
        body[f.key] = Math.floor(v);
      }
      await tenantApi.updateLimits(tenant.slug, body as Partial<TenantLimits>);
      toast.success(`Limits updated for '${tenant.slug}'`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update limits');
    } finally {
      setBusy(false);
    }
  }, [draft, tenant.slug, onSaved]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {LIMIT_FIELDS.map((f) => (
        <div key={f.key} className="grid gap-1.5">
          <Label htmlFor={`limit-${f.key}`} className="text-[11px] text-zinc-400">{f.label}</Label>
          <Input
            id={`limit-${f.key}`}
            inputMode="numeric"
            value={draft[f.key] ?? '0'}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.replace(/[^0-9]/g, '') }))}
            className="border-white/15 bg-white/5 font-mono text-sm"
          />
        </div>
      ))}
      <div className="flex items-end">
        <Button size="sm" variant="outline" onClick={save} disabled={busy} className="border-white/15 bg-white/5 font-semibold hover:bg-white/10">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          Save limits
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ member list -------------------------------- */

function MemberList({ slug, members, onChanged }: { slug: string; members: TenantMember[]; onChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);

  const add = useCallback(async () => {
    if (!email.includes('@')) {
      toast.error('Enter a valid account email');
      return;
    }
    setBusy(true);
    try {
      await tenantApi.addMember(slug, email.trim().toLowerCase(), role);
      toast.success(`${email} added to '${slug}' as ${role}`);
      setEmail('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setBusy(false);
    }
  }, [slug, email, role, onChanged]);

  const remove = useCallback(async (userid: number, memberEmail: string) => {
    setBusy(true);
    try {
      await tenantApi.removeMember(slug, userid);
      toast.success(`${memberEmail} removed from '${slug}'`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setBusy(false);
    }
  }, [slug, onChanged]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="account email…"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-56 border-white/15 bg-white/5"
          aria-label={`Add member to ${slug}`}
        />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-[120px] border-white/15 bg-white/5" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="owner">owner</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
            <SelectItem value="member">member</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={add} disabled={busy} className="font-semibold">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          Add
        </Button>
      </div>
      {members.length === 0 ? (
        <p className="py-3 text-sm text-zinc-500">No members yet — the tenant is accessible only via the X-Animaxia-Tenant header.</p>
      ) : (
        <ul className="max-h-48 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10">
          {members.map((m) => (
            <li key={m.userid} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-200">{m.email}</p>
                <p className="text-[11px] text-zinc-500">@{m.username}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-400">{m.role}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400"
                  onClick={() => remove(m.userid, m.email)}
                  aria-label={`Remove ${m.email}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------ tenant detail ------------------------------ */

function TenantDetailCard({ slug, onChanged }: { slug: string; onChanged: () => void }) {
  const detail = useApi(`tenant-detail-${slug}`, () => tenantApi.detail(slug));
  const [genBusy, setGenBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);

  const generateInvoice = useCallback(async () => {
    setGenBusy(true);
    try {
      const res = await tenantApi.generateInvoice(slug);
      toast.success(`Invoice #${res.invoice.id} generated — ${fmtUsd(res.invoice.totalusd)} (${res.invoice.status})`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invoice generation failed');
    } finally {
      setGenBusy(false);
    }
  }, [slug, onChanged]);

  const changePlan = useCallback(async (plan: string) => {
    setPlanBusy(true);
    try {
      const res = await tenantApi.setPlan(slug, plan as (typeof TENANT_PLANS)[number]);
      toast.success(`'${slug}' ${res.direction}: ${res.from} → ${res.to}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Plan change failed');
    } finally {
      setPlanBusy(false);
    }
  }, [slug, onChanged]);

  if (detail.loading) {
    return (
      <Card className="border-white/10 bg-white/[0.02]">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (detail.error && !detail.data) {
    return (
      <Card className="border-rose-500/20 bg-white/[0.02]">
        <CardContent className="p-5">
          <ErrorState compact message={detail.error} onRetry={detail.refetch} />
        </CardContent>
      </Card>
    );
  }

  const t = detail.data?.tenant;
  const members = detail.data?.members ?? [];
  if (!t) return null;
  const usage = t.usage;

  return (
    <Card className="border-white/10 bg-white/[0.02]">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Building2 className="h-4 w-4 text-rose-400" aria-hidden />
              {t.name}
              <span className="font-mono text-xs text-zinc-500">#{t.id} · {t.slug}</span>
            </CardTitle>
            <CardDescription>
              Created {t.createdat ? new Date(t.createdat).toLocaleDateString('en-US') : '—'} · {members.length} member{members.length === 1 ? '' : 's'}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={t.plan} onValueChange={changePlan} disabled={planBusy || t.slug === 'global'}>
              <SelectTrigger className="w-[150px] border-white/15 bg-white/5" aria-label="Tenant plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TENANT_PLANS.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={generateInvoice} disabled={genBusy} className="border-white/15 bg-white/5 font-semibold hover:bg-white/10">
              {genBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />}
              Generate invoice
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* usage */}
        <section aria-label="Tenant usage">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Usage (last {usage?.windowdays ?? 30} days)</h4>
          {usage && Object.keys(usage.bymetric).length > 0 ? (
            <div className="flex flex-wrap gap-4">
              {Object.entries(usage.bymetric).map(([metric, v]) => (
                <UsageBar
                  key={metric}
                  metric={metric}
                  total={v.total}
                  cap={metric === 'ai_call' ? (t.limits.aiperday * (usage.windowdays || 30)) : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No metered usage recorded yet.</p>
          )}
        </section>

        {/* limits */}
        <section aria-label="Tenant limits">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Enforceable limits</h4>
          <LimitsEditor tenant={t} onSaved={() => { detail.refetch(); onChanged(); }} />
        </section>

        {/* members */}
        <section aria-label="Tenant members">
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            <Users className="h-3.5 w-3.5" aria-hidden /> Members
          </h4>
          <MemberList slug={t.slug} members={members} onChanged={() => { detail.refetch(); onChanged(); }} />
        </section>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ tenants list ------------------------------- */

function TenantsTable({ tenants, loading, error, onRetry, onChanged }: {
  tenants: Tenant[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => tenants, [tenants]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (error && !tenants.length) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }
  if (!rows.length) {
    return <EmptyState title="No tenants" message="Create the first tenant to start scoping AI, vectors and edge caches." />;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-white/10">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              <TableHead>Tenant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">AI (30d)</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => {
              const isOpen = expanded === t.slug;
              const aiUsage = t.usage?.bymetric?.ai_call?.total ?? 0;
              return (
                <Fragment key={t.slug}>
                  <TableRow
                    className={cn('cursor-pointer', isOpen ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]')}
                    onClick={() => setExpanded(isOpen ? null : t.slug)}
                  >
                    <TableCell className="w-8 text-zinc-500">
                      {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                        <div>
                          <p className="font-medium text-zinc-100">{t.name}</p>
                          <p className="font-mono text-[11px] text-zinc-500">{t.slug}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell><PlanBadge plan={t.plan} /></TableCell>
                    <TableCell className="text-right font-mono text-sm text-zinc-300">
                      {fmtNum(t.usercount)}
                      <span className="text-zinc-600"> / {fmtNum(t.limits.maxusers)}</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-zinc-300">
                      {fmtNum(aiUsage)}
                      <span className="text-zinc-600"> / {fmtNum(t.limits.aiperday * 30)}</span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px]',
                        t.status === 'active' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400')}>
                        {t.status}
                      </span>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-black/20 p-4">
                        <TenantDetailCard slug={t.slug} onChanged={onChanged} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* ------------------------------ invoices ---------------------------------- */

function InvoicesPanel() {
  const invoices = useApi('tenant-billing-invoices', () => tenantApi.billingInvoices());
  if (invoices.loading) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }
  if (invoices.error && !invoices.data) {
    return <ErrorState compact message={invoices.error} onRetry={invoices.refetch} />;
  }
  const list = invoices.data?.invoices ?? [];
  if (!list.length) {
    return <p className="py-3 text-sm text-zinc-500">No invoices yet — generate one from a tenant row.</p>;
  }
  return (
    <div className="max-h-72 overflow-y-auto rounded-xl border border-white/10">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>#</TableHead>
            <TableHead>Tenant</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Base</TableHead>
            <TableHead className="text-right">Usage</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((inv) => (
            <TableRow key={inv.id} className="hover:bg-white/[0.03]">
              <TableCell className="font-mono text-xs text-zinc-500">{inv.id}</TableCell>
              <TableCell className="font-mono text-xs text-zinc-300">{inv.tenant}</TableCell>
              <TableCell className="text-xs text-zinc-400">
                {new Date(inv.periodstart).toLocaleDateString('en-US')} → {new Date(inv.periodend).toLocaleDateString('en-US')}
              </TableCell>
              <TableCell>
                <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px]',
                  inv.status === 'paid' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' :
                  inv.status === 'void' ? 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500' :
                  'border-amber-500/30 bg-amber-500/10 text-amber-300')}>
                  {inv.status}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-zinc-400">{fmtUsd(inv.baseusd)}</TableCell>
              <TableCell className="text-right font-mono text-sm text-zinc-400">{fmtUsd(inv.usageusd)}</TableCell>
              <TableCell className="text-right font-mono text-sm font-bold text-zinc-100">{fmtUsd(inv.totalusd)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ------------------------------ AI status --------------------------------- */

function TenantAiPanel() {
  const status = useApi('tenant-ai-status', () => tenantApi.aiStatus());
  if (status.loading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (status.error && !status.data) {
    return <ErrorState compact message={status.error} onRetry={status.refetch} />;
  }
  const d = status.data;
  const q = d?.quota;
  const v = d?.vector;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Your tenant</p>
        <p className="mt-1 font-mono text-sm font-bold text-zinc-100">{q?.tenant ?? '—'}</p>
        <p className="text-[11px] text-zinc-500">{q?.scoped ? `scoped quota: ${fmtNum(q.used)} / ${fmtNum(q.limit)} daily` : 'platform-wide (global)'}</p>
      </div>
      <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Vector namespace</p>
        <p className="mt-1 font-mono text-sm font-bold text-zinc-100">{v?.tenant ?? '—'}</p>
        <p className="text-[11px] text-zinc-500">
          {v?.scoped ? Object.entries(v.counts).map(([k, c]) => `${k}: ${c}`).join(' · ') || 'empty — run index' : 'shared platform index'}
        </p>
      </div>
      <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">LLM provider</p>
        <p className="mt-1 font-mono text-sm font-bold text-zinc-100">{d?.provider?.provider ?? '—'}</p>
        <p className="text-[11px] text-zinc-500">{d?.provider?.available ? `available (fallback ${d.provider.fallback})` : 'degraded'}</p>
      </div>
    </div>
  );
}

/* -------------------------------- main tab -------------------------------- */

export function AdminTenantsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const list = useApi('tenants-list', () => tenantApi.list(), { enabled: isAdmin });

  if (!isAdmin) return <ForbiddenCard />;

  return (
    <div className="space-y-6">
      <SummaryChips />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Building2 className="h-4 w-4 text-rose-400" aria-hidden />
          Tenant registry ({list.data?.total ?? '…'})
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => list.refetch()} className="border-white/15 bg-white/5 font-semibold hover:bg-white/10">
            <RefreshCw aria-hidden /> Refresh
          </Button>
          <CreateTenantForm onCreated={() => list.refetch()} />
        </div>
      </div>

      <TenantsTable
        tenants={list.data?.tenants ?? []}
        loading={list.loading}
        error={list.error}
        onRetry={list.refetch}
        onChanged={() => list.refetch()}
      />

      <Tabs defaultValue="invoices" className="gap-4">
        <TabsList className="w-full flex-wrap justify-start border border-white/10 bg-white/[0.03] sm:w-fit">
          <TabsTrigger value="invoices">
            <CreditCard className="h-3.5 w-3.5" aria-hidden /> Invoices
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Server className="h-3.5 w-3.5" aria-hidden /> Tenant AI context
          </TabsTrigger>
        </TabsList>
        <TabsContent value="invoices">
          <Card className="border-white/10 bg-white/[0.02]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Metered invoices</CardTitle>
              <CardDescription>
                Generated from tenantusageevents (ai_call / vector_index / storage_gb) with plan allowances deducted; overage billed at plan unit prices.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <InvoicesPanel />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="ai">
          <Card className="border-white/10 bg-white/[0.02]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your tenant AI context</CardTitle>
              <CardDescription>What /api/ai/tenant/* resolves for YOUR session right now (quota pool + vector namespace + provider).</CardDescription>
            </CardHeader>
            <CardContent>
              <TenantAiPanel />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
