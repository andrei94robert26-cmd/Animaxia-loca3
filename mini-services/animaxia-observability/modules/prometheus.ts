/**
 * Prometheus text format — parser (sursă: FAZA 9 :4000/api/metrics, viitorul
 * :4040/metrics și :4000/api/observability/metrics de la 23-b) + renderer
 * (output-ul propriu /metrics). Zero dependențe.
 *
 * Format suportat:
 *   # HELP name text...        (ignorat la parsare, regenerat la output)
 *   # TYPE name counter|gauge|histogram|summary
 *   name{label="v",...} value [timestampMs]
 *   name value [timestampMs]
 * Escape label values: \\, \", \n.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

export interface ParsedSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
  tsMs: number;
}

export interface ParsedFamily {
  name: string;
  type: MetricType;
  help: string;
}

export interface ParseResult {
  families: Map<string, ParsedFamily>;
  series: ParsedSeries[];
}

const LABEL_RE = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/** Parsează un document Prometheus text. Tolerant: liniile invalide sar. */
export function parsePrometheusText(text: string, nowMs = Date.now()): ParseResult {
  const families = new Map<string, ParsedFamily>();
  const series: ParsedSeries[] = [];
  let currentType: MetricType | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const helpMatch = /^#\s+HELP\s+(\S+)\s+(.*)$/.exec(line);
      if (helpMatch) {
        const fam = families.get(helpMatch[1]) ?? {
          name: helpMatch[1],
          type: 'untyped',
          help: helpMatch[2],
        };
        fam.help = helpMatch[2];
        families.set(helpMatch[1], fam);
        continue;
      }
      const typeMatch = /^#\s+TYPE\s+(\S+)\s+(\S+)/.exec(line);
      if (typeMatch) {
        const t = typeMatch[2].toLowerCase();
        const type: MetricType =
          t === 'counter' || t === 'gauge' || t === 'histogram' || t === 'summary'
            ? (t as MetricType)
            : 'untyped';
        const fam = families.get(typeMatch[1]) ?? {
          name: typeMatch[1],
          type,
          help: '',
        };
        fam.type = type;
        families.set(typeMatch[1], fam);
        currentType = type;
      }
      continue;
    }

    // name{...} value [ts]  |  name value [ts]
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    const brace = line.indexOf('{');
    if (brace === -1) {
      const m = /^(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      name = m[1];
      rest = m[2];
    } else {
      const close = line.indexOf('}', brace);
      if (close === -1) continue;
      name = line.slice(0, brace);
      const labelPart = line.slice(brace + 1, close);
      rest = line.slice(close + 1).trim();
      LABEL_RE.lastIndex = 0;
      let lm: RegExpExecArray | null;
      labels = {};
      while ((lm = LABEL_RE.exec(labelPart)) !== null) {
        labels[lm[1]] = unescapeLabel(lm[2]);
      }
    }
    const parts = rest.split(/\s+/);
    const value = Number.parseFloat(parts[0]);
    if (!Number.isFinite(value)) continue;
    const ts = parts[1] ? Number.parseFloat(parts[1]) : NaN;
    const tsMs = Number.isFinite(ts) ? ts : nowMs;
    if (!families.has(name)) {
      families.set(name, { name, type: currentType ?? 'untyped', help: '' });
    }
    series.push({ name, labels, value, tsMs });
  }
  return { families, series };
}

function unescapeLabel(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Sortează cheile label-urilor pentru o identitate stabilă a seriei. */
export function seriesKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',');
}

/** Randare Prometheus text: o linie sample. */
export function renderSample(
  name: string,
  labels: Record<string, string>,
  value: number,
): string {
  const key = seriesKey(labels);
  const num = Number.isFinite(value) ? String(value) : 'NaN';
  return key ? `${name}{${key}} ${num}` : `${name} ${num}`;
}

/** histogram_quantile minimal peste bucket-ele `{le="..."}` (le poate fi
 *  "+Inf"). Intoarce null dacă nu există bucket-uri. */
export function histogramQuantile(
  buckets: { le: number; count: number }[],
  quantile: number,
): number | null {
  if (buckets.length === 0) return null;
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted[sorted.length - 1].count;
  if (total <= 0) return null;
  const rank = quantile * total;
  let prevCount = 0;
  let prevLe = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      if (b.count === prevCount) return b.le === Infinity ? prevLe : b.le;
      const scale = (rank - prevCount) / (b.count - prevCount);
      const le = b.le === Infinity ? prevLe * 2 || 1 : b.le;
      return prevLe + (le - prevLe) * scale;
    }
    prevCount = b.count;
    prevLe = b.le === Infinity ? prevLe : b.le;
  }
  return sorted[sorted.length - 1].le === Infinity ? prevLe : sorted[sorted.length - 1].le;
}
