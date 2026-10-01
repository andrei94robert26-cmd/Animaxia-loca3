/**
 * Metrics store — registru de familii Prometheus:
 *  - familii PROPRII (generate din scrape-uri, ingest OTLP, synthetics, alerte)
 *  - familii RE-EXPUSE din sursele scrape-uite (FAZA 9 :4000/api/metrics,
 *    viitoarele :4040/metrics și :4000/api/observability/metrics de la 23-b),
 *    cu label `job` adăugat (exact cum face Prometheus real la scrape).
 *  - istoric de puncte [tsSec, value] per serie (dashboard-uri live),
 *    cu retention 30 zile și cap HISTORY_POINTS_MAX.
 */
import { HISTORY_POINTS_MAX, RETENTION_MS, RETENTION_DAYS } from '../config.ts';
import { type MetricType, parsePrometheusText, renderSample, seriesKey } from './prometheus.ts';

export interface StoredSeries {
  labels: Record<string, string>;
  value: number;
  tsMs: number;
}

export interface StoredFamily {
  name: string;
  type: MetricType;
  help: string;
  /** key = seriesKey(labels) */
  series: Map<string, StoredSeries>;
}

export interface HistoryPoint {
  tsSec: number;
  value: number;
}

/** fam|seriesKey → puncte (push la fiecare update) */
type HistoryMap = Map<string, HistoryPoint[]>;

export class MetricsStore {
  private own = new Map<string, StoredFamily>();
  private scraped = new Map<string, StoredFamily>();
  private history: HistoryMap = new Map();
  private ingestCounters = new Map<string, number>(); // service → spans/metrics primite
  private scrapeErrors: Map<string, number> = new Map(); // job → erori cumulate

  // ── familii proprii ─────────────────────────────────────────────────────

  private ownFamily(name: string, type: MetricType, help: string): StoredFamily {
    let fam = this.own.get(name);
    if (!fam) {
      fam = { name, type, help, series: new Map() };
      this.own.set(name, fam);
    }
    if (!fam.help) fam.help = help;
    return fam;
  }

  set(
    name: string,
    labels: Record<string, string>,
    value: number,
    type: MetricType = 'gauge',
    help = '',
    recordHistory = true,
  ): void {
    const fam = this.ownFamily(name, type, help);
    const key = seriesKey(labels);
    fam.series.set(key, { labels, value, tsMs: Date.now() });
    if (recordHistory) this.pushHistory(name, key, value);
  }

  /** Counter care poate fi setat absolut (din surse externe cumulative). */
  setCounter(name: string, labels: Record<string, string>, value: number, help = ''): void {
    this.set(name, labels, value, 'counter', help, true);
  }

  inc(name: string, labels: Record<string, string>, delta = 1, help = ''): void {
    const fam = this.ownFamily(name, 'counter', help);
    const key = seriesKey(labels);
    const prev = fam.series.get(key);
    const value = (prev?.value ?? 0) + delta;
    fam.series.set(key, { labels, value, tsMs: Date.now() });
    this.pushHistory(name, key, value);
  }

  private pushHistory(name: string, key: string, value: number): void {
    const hkey = `${name}|${key}`;
    let points = this.history.get(hkey);
    if (!points) {
      points = [];
      this.history.set(hkey, points);
    }
    points.push({ tsSec: Math.floor(Date.now() / 1000), value });
    if (points.length > HISTORY_POINTS_MAX) points.splice(0, points.length - HISTORY_POINTS_MAX);
  }

  /** Ultima valoare a unei serii proprii (null dacă nu există). */
  get(name: string, labels: Record<string, string>): number | null {
    const fam = this.own.get(name);
    if (!fam) return null;
    const s = fam.series.get(seriesKey(labels));
    return s ? s.value : null;
  }

  /** Toate seriile unei familii proprii. */
  ownSeries(name: string): StoredSeries[] {
    return [...(this.own.get(name)?.series.values() ?? [])];
  }

  /** Familii proprii (nume). */
  ownFamilyNames(): string[] {
    return [...this.own.keys()];
  }

  // ── istoric pentru dashboard-uri live ───────────────────────────────────

  historyFor(name: string, labels: Record<string, string>, maxPoints: number): HistoryPoint[] {
    const hkey = `${name}|${seriesKey(labels)}`;
    const points = this.history.get(hkey) ?? [];
    const cutoff = Date.now() / 1000 - RETENTION_MS / 1000;
    const fresh = points.filter((p) => p.tsSec >= cutoff);
    return fresh.slice(-maxPoints);
  }

  // ── ingest OTLP (/v1/metrics) ───────────────────────────────────────────

  ingestOtelMetric(m: {
    name: string;
    kind?: string;
    value?: number;
    labels?: Record<string, unknown>;
  }): boolean {
    if (!m || typeof m.name !== 'string' || !/^[\w:]+$/.test(m.name)) return false;
    const value = Number(m.value);
    if (!Number.isFinite(value)) return false;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.labels ?? {})) {
      if (v === null || v === undefined) continue;
      labels[k] = String(v);
    }
    const kind = m.kind === 'counter' || m.kind === 'histogram' ? m.kind : 'gauge';
    this.set(m.name, labels, value, kind, `OTLP metric ingest /v1/metrics (${m.name})`);
    return true;
  }

  countIngest(kind: 'spans' | 'metrics', service: string, delta = 1): void {
    const key = `${kind}:${service}`;
    this.ingestCounters.set(key, (this.ingestCounters.get(key) ?? 0) + delta);
  }

  ingestCounterValue(kind: 'spans' | 'metrics', service: string): number {
    return this.ingestCounters.get(`${kind}:${service}`) ?? 0;
  }

  ingestServices(): string[] {
    return [...new Set([...this.ingestCounters.keys()].map((k) => k.split(':').slice(1).join(':')))].sort();
  }

  // ── scrape ──────────────────────────────────────────────────────────────

  /** Înlocuiește toate seriile unui job scrape-uit (label job adăugat). */
  replaceScraped(job: string, text: string): { families: number; series: number } {
    // șterge seriile vechi ale jobului
    for (const fam of this.scraped.values()) {
      for (const [key, s] of [...fam.series]) {
        if (s.labels.job === job) fam.series.delete(key);
      }
    }
    const parsed = parsePrometheusText(text);
    let seriesCount = 0;
    const famNames = new Set<string>();
    for (const s of parsed.series) {
      let fam = this.scraped.get(s.name);
      if (!fam) {
        const meta = parsed.families.get(s.name);
        fam = {
          name: s.name,
          type: meta?.type ?? 'untyped',
          help: meta?.help ?? '',
          series: new Map(),
        };
        this.scraped.set(s.name, fam);
      }
      const labels = { ...s.labels, job };
      fam.series.set(seriesKey(labels), { labels, value: s.value, tsMs: s.tsMs });
      famNames.add(s.name);
      seriesCount++;
    }
    return { families: famNames.size, series: seriesCount };
  }

  scrapeError(job: string): void {
    this.scrapeErrors.set(job, (this.scrapeErrors.get(job) ?? 0) + 1);
  }

  scrapeErrorCount(job: string): number {
    return this.scrapeErrors.get(job) ?? 0;
  }

  /** Ultima valoare a unei serii scrape-uite, filtrată pe label-uri exacte (subset match). */
  scrapedValue(name: string, filter: Record<string, string>): number | null {
    const fam = this.scraped.get(name);
    if (!fam) return null;
    for (const s of fam.series.values()) {
      let match = true;
      for (const [k, v] of Object.entries(filter)) {
        if (s.labels[k] !== v) {
          match = false;
          break;
        }
      }
      if (match) return s.value;
    }
    return null;
  }

  /** Toate seriile scrape-uite ale familiei (cu label-uri complete). */
  scrapedSeries(name: string): StoredSeries[] {
    return [...(this.scraped.get(name)?.series.values() ?? [])];
  }

  /** Familiile scrape-uite care au cel puțin o serie. */
  scrapedFamilyNames(): string[] {
    const names: string[] = [];
    for (const [name, fam] of this.scraped) {
      if (fam.series.size > 0) names.push(name);
    }
    return names;
  }

  /** Suma seriilor scrape-uite care match-uiesc un filtru subset. */
  scrapedSum(name: string, filter: Record<string, string>): number {
    const fam = this.scraped.get(name);
    if (!fam) return 0;
    let sum = 0;
    for (const s of fam.series.values()) {
      let match = true;
      for (const [k, v] of Object.entries(filter)) {
        if (s.labels[k] !== v) {
          match = false;
          break;
        }
      }
      if (match) sum += s.value;
    }
    return sum;
  }

  /** Familia scrape-uită întreagă (dacă există). */
  scrapedFamily(name: string): StoredFamily | undefined {
    return this.scraped.get(name);
  }

  // ── output ──────────────────────────────────────────────────────────────

  /** Numele UNICE de familii (proprii + scrape-uite), sortate. */
  allFamilyNames(): string[] {
    const names = new Set<string>([...this.own.keys()]);
    for (const [name, fam] of this.scraped) if (fam.series.size > 0) names.add(name);
    return [...names].sort();
  }

  /** Randare Prometheus text completă (familii proprii + re-expuse). */
  render(): string {
    const lines: string[] = [];
    const familyNames = this.allFamilyNames();

    for (const name of familyNames) {
      const ownFam = this.own.get(name);
      const scrapedFam = this.scraped.get(name);
      const type: MetricType = ownFam?.type ?? scrapedFam?.type ?? 'untyped';
      const help = ownFam?.help || scrapedFam?.help || '';
      lines.push(`# HELP ${name} ${help || `Animaxia metric ${name}`}`);
      lines.push(`# TYPE ${name} ${type}`);
      const seen = new Set<string>();
      if (ownFam) {
        for (const [key, s] of ownFam.series) {
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(renderSample(name, s.labels, s.value));
        }
      }
      if (scrapedFam) {
        for (const [key, s] of scrapedFam.series) {
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(renderSample(name, s.labels, s.value));
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** JSON snapshot pentru /api/metrics.json. */
  toJson(): {
    families: {
      name: string;
      type: string;
      series: { labels: Record<string, string>; value: number }[];
    }[];
    retentionDays: number;
  } {
    const families = this.allFamilyNames().map((name) => {
      const ownFam = this.own.get(name);
      const scrapedFam = this.scraped.get(name);
      const series: { labels: Record<string, string>; value: number }[] = [];
      if (ownFam) for (const s of ownFam.series.values()) series.push({ labels: s.labels, value: s.value });
      if (scrapedFam) for (const s of scrapedFam.series.values()) series.push({ labels: s.labels, value: s.value });
      return { name, type: ownFam?.type ?? scrapedFam?.type ?? 'untyped', series };
    });
    return { families, retentionDays: RETENTION_DAYS };
  }

  /** Numărul total de samples (serii) — pentru /api/summary. */
  sampleCount(): number {
    let count = 0;
    for (const fam of this.own.values()) count += fam.series.size;
    for (const fam of this.scraped.values()) count += fam.series.size;
    return count;
  }

  familyCount(): number {
    return this.allFamilyNames().length;
  }

  /** Sweep retention: șterge punctele istorice mai vechi de 30 zile. */
  retentionSweep(nowMs = Date.now()): { droppedPoints: number } {
    const cutoffSec = (nowMs - RETENTION_MS) / 1000;
    let dropped = 0;
    for (const points of this.history.values()) {
      const before = points.length;
      const fresh = points.filter((p) => p.tsSec >= cutoffSec);
      if (fresh.length !== before) {
        points.splice(0, points.length, ...fresh);
        dropped += before - fresh.length;
      }
    }
    return { droppedPoints: dropped };
  }
}
