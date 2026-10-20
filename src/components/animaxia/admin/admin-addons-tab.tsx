'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { authRequest } from '@/lib/animaxia/platform';
import { useAuth } from '../auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type SourceType = 'addon' | 'api' | 'hub';
type SourceIdentity = { type: SourceType; id: string };
type RegistrySource = {
  source: SourceIdentity;
  name: string;
  version: string;
  protocol: string;
  categories: string[];
  enabled: boolean;
  hasCredential: boolean;
  updatedAt: string | null;
};
type InstallResponse = RegistrySource & { credential: string };
type QueueProvider = {
  type: SourceType;
  id: string;
  total: number;
  queued: number;
  done: number;
  partial: number;
  failed: number;
  lastSuccess: string | null;
};
type QueueStatus = { sources: QueueProvider[] };
type CatalogProvider = {
  id: string; category: string; driverImplemented: boolean;
  requiredEnv: string[]; installed: boolean; enabled: boolean;
  credentialsPresent: boolean; readyForSync: boolean; liveVerified: boolean;
  fetchHealth?: {
    attempts: number; lastStatus: string; lastAttemptAt: string | null;
    lastSuccessAt: string | null; lastItemCount: number | null;
    lastError: string | null;
  };
};
type CatalogResponse = {
  catalogCount: number; implementedDrivers: number;
  providers: CatalogProvider[];
};
const backend = (path: string) => path + '?XTransformPort=4000';

export function AdminAddonsTab() {
  const { isAdmin, initializing } = useAuth();
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [queue, setQueue] = useState<QueueProvider[]>([]);
  const [providerCatalog, setProviderCatalog] = useState<CatalogResponse | null>(null);
  const [providerQuery, setProviderQuery] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('addon');
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [categories, setCategories] = useState('filme, seriale, anime');
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [secretFor, setSecretFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const [registry, status, catalog] = await Promise.all([
        authRequest<{ sources: RegistrySource[] }>(backend('/api/integrations/sources')),
        authRequest<QueueStatus>(backend('/api/ingest/metadata/sources/status')),
        authRequest<CatalogResponse>(backend('/api/integrations/providers')),
      ]);
      setSources(registry.sources);
      setQueue(status.sources);
      setProviderCatalog(catalog);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nu se poate citi registrul de addonuri.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!initializing && isAdmin) void refresh();
  }, [initializing, isAdmin, refresh]);

  const mutate = async <T,>(path: string, method: string, body: unknown): Promise<T> =>
    authRequest<T>(backend(path), { method, body: JSON.stringify(body) });

  async function install(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isAdmin || busy) return;
    setBusy(true);
    setSecretOnce(null);
    try {
      const source = await mutate<InstallResponse>('/api/integrations/sources', 'POST', {
        source: { type: sourceType, id: sourceId.trim() },
        name: name.trim() || sourceId.trim(),
        version: '1',
        protocol: 'json-push-v1',
        categories: categories.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setSecretOnce(source.credential);
      setSecretFor(source.source.type + ':' + source.source.id);
      toast.success('Sursa a fost instalată, dar rămâne dezactivată până la activare.');
      setSourceId('');
      setName('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Instalarea a eșuat.');
    } finally {
      setBusy(false);
    }
  }
  async function toggle(source: RegistrySource) {
    if (busy || !isAdmin) return;
    setBusy(true);
    try {
      await mutate<RegistrySource>(
        '/api/integrations/sources/' + encodeURIComponent(source.source.type) +
          '/' + encodeURIComponent(source.source.id),
        'PATCH', { enabled: !source.enabled },
      );
      toast.success(source.enabled ? 'Sursa este dezactivată.' : 'Sursa este activată.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Modificarea a eșuat.');
    } finally {
      setBusy(false);
    }
  }
  async function rotate(source: RegistrySource) {
    if (busy || !isAdmin || !window.confirm(
      'Rotești cheia? Integrarea externă va trebui configurată cu cheia nouă.'
    )) return;
    setBusy(true);
    try {
      const result = await mutate<InstallResponse>(
        '/api/integrations/sources/' + encodeURIComponent(source.source.type) +
          '/' + encodeURIComponent(source.source.id) + '/rotate-key',
        'POST', {},
      );
      setSecretOnce(result.credential);
      setSecretFor(result.source.type + ':' + result.source.id);
      toast.success('Cheia a fost rotită; cheia veche este invalidă.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rotirea a eșuat.');
    } finally {
      setBusy(false);
    }
  }

  async function syncProvider(providerId: string) {
    if (!isAdmin || busy) return;
    setBusy(true);
    try {
      const response = await mutate<{
        fetched: number; jobId?: string; status?: string; duplicate?: boolean;
      }>('/api/integrations/providers/' + encodeURIComponent(providerId) + '/sync',
        'POST', { q: providerId === 'freetogame' ? '' : providerQuery, page: 1 });
      toast.success(response.jobId
        ? providerId + ': ' + response.fetched + ' elemente în coadă (' + response.status + ')'
        : providerId + ': nu există rezultate compatibile pentru import.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sincronizarea API a eșuat.');
    } finally {
      setBusy(false);
    }
  }

  if (initializing) return <p className="text-sm text-zinc-400">Se verifică sesiunea…</p>;
  if (!isAdmin) return <p className="text-sm text-rose-400">Doar administratorii pot gestiona addonurile.</p>;
  return (
    <div className="space-y-5">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle>Furnizori API — catalog și sincronizare</CardTitle>
          <CardDescription>
            {providerCatalog?.catalogCount ?? 0} surse catalogate;{' '}
            {providerCatalog?.implementedDrivers ?? 0} drivere de preluare JSON implementate.
            Un conector nu este activ până la instalarea și activarea sursei.
            Fără teste live nu se confirmă disponibilitatea furnizorului.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="provider-search">Interogare pentru API (necesară pentru iTunes, CheapShark, GDELT)</Label>
            <Input id="provider-search" value={providerQuery} maxLength={120}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="ex: anime, Star Wars, sport" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(providerCatalog?.providers.filter((provider) => provider.driverImplemented) ?? [])
              .map((provider) => (
                <div key={provider.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/10 p-3">
                  <div>
                    <p className="font-medium">{provider.id}</p>
                    <p className="text-xs text-zinc-400">
                      {provider.readyForSync ? 'Configurat pentru sincronizare'
                        : !provider.installed ? 'Neinstalat'
                        : !provider.enabled ? 'Dezactivat' : 'Necesită chei API'}
                      {' · '}{provider.category}
                    </p>
                    <p className="text-xs text-zinc-500">
                      API: {provider.fetchHealth?.lastStatus === 'success' ? 'ultima cerere reușită'
                        : provider.fetchHealth?.lastStatus === 'error' ? 'ultima cerere a eșuat'
                        : 'neverificat prin HTTP'}
                      {provider.fetchHealth?.lastAttemptAt
                        ? ' · ' + new Date(provider.fetchHealth.lastAttemptAt).toLocaleString('ro-RO')
                        : ''}
                    </p>
                  </div>
                  <Button type="button" variant="outline" disabled={busy || !provider.readyForSync}
                    onClick={() => void syncProvider(provider.id)}>
                    Sincronizează
                  </Button>
                </div>
              ))}
          </div>
          <p className="text-xs text-zinc-400">
            Rezultatele sunt introduse într-o coadă persistentă; pornirea workerului
            este configurată separat pe server. Celelalte API-uri sunt doar catalogate.
          </p>
        </CardContent>
      </Card>

      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle>Registrul de addonuri, API-uri și huburi</CardTitle>
          <CardDescription>
            Instalare controlată a manifestelor JSON. Nu rulează cod JavaScript extern.
            Importurile noi necesită activare și o cheie dedicată sursei.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void install(event)} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="addon-kind">Tip sursă</Label>
              <select id="addon-kind" value={sourceType}
                onChange={(e) => setSourceType(e.target.value as SourceType)}
                className="h-10 w-full rounded-md border border-white/15 bg-zinc-900 px-3 text-sm">
                <option value="addon">Addon</option>
                <option value="api">API</option>
                <option value="hub">Hub</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="addon-id">Identificator sursă</Label>
              <Input id="addon-id" value={sourceId} onChange={(e) => setSourceId(e.target.value)}
                maxLength={64} required placeholder="ex: torentino" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="addon-name">Nume afișat</Label>
              <Input id="addon-name" value={name} onChange={(e) => setName(e.target.value)}
                maxLength={120} placeholder="Nume addon" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="addon-categories">Categorii (separate prin virgulă)</Label>
              <Input id="addon-categories" value={categories}
                onChange={(e) => setCategories(e.target.value)} placeholder="filme, seriale, anime" />
            </div>
            <Button type="submit" disabled={busy || !sourceId.trim()} className="sm:col-span-2">
              {busy ? 'Se procesează…' : 'Instalează manifest JSON'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {secretOnce && (
        <Card className="border-amber-500/40 bg-amber-500/[0.07]">
          <CardContent className="space-y-2 py-5">
            <p className="font-semibold">Cheie unică pentru {secretFor}</p>
            <p className="text-xs text-zinc-300">
              Copiaz-o în secret manager. Nu este salvată în browser și nu va mai fi afișată.
            </p>
            <code className="block break-all rounded bg-black/40 p-3 text-xs">{secretOnce}</code>
            <Button variant="outline" type="button" onClick={() => setSecretOnce(null)}>
              Am salvat cheia · Ascunde
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-400">
          {sources.length} surse instalate · {sources.filter((s) => s.enabled).length} active
        </p>
        <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Se actualizează…' : 'Reîmprospătează'}
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <div className="grid gap-3">
        {sources.map((source) => {
          const id = source.source.type + ':' + source.source.id;
          const stats = queue.find((entry) =>
            entry.type === source.source.type && entry.id === source.source.id);
          return (
            <Card key={id} className="border-white/10 bg-white/[0.03]">
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold text-white">{source.name}</p>
                  <p className="break-all font-mono text-xs text-zinc-400">{id}</p>
                  <p className="text-xs text-zinc-500">
                    {source.enabled ? 'Activat' : 'Dezactivat'} · {source.protocol}
                    {' · '}v{source.version}
                  </p>
                  <p className="text-xs text-zinc-400">
                    Joburi: {stats?.done ?? 0} finalizate, {stats?.queued ?? 0} în coadă,
                    {' '}{stats?.failed ?? 0} eșuate
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={busy}
                    onClick={() => void rotate(source)}>Rotește cheia</Button>
                  <Button type="button" variant={source.enabled ? 'destructive' : 'default'}
                    disabled={busy} onClick={() => void toggle(source)}>
                    {source.enabled ? 'Dezactivează' : 'Activează'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {!loading && sources.length === 0 && !error && (
          <p className="rounded border border-white/10 p-6 text-center text-sm text-zinc-400">
            Nicio sursă instalată. Începe cu un manifest JSON.
          </p>
        )}
      </div>
    </div>
  );
}
