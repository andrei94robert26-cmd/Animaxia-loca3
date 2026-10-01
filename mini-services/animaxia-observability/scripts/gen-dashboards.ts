/**
 * Generator artefacte FAZA 23 — scrie:
 *  1. cele 4 dashboard-uri Grafana complete în animaxia-ops/dashboards/
 *     (format identic cu celelalte dashboards din animaxia-ops/, datasource
 *     `animaxia-prometheus` — conform specificației FAZA 23);
 *  2. provisioning-ul Grafana GLOBAL din animaxia-cloud/observability/global/
 *     grafana/provisioning/dashboards/ — aceleași 4 tablouri cu uid-ul
 *     datasource-ului global (`animaxia-prometheus-global`), ca profilul
 *     docker `faza23` să le încarce automat.
 * Sursa unică de adevăr = DEFS-urile serviciului :4050 (consistență local↔producție).
 * Rulare: bun scripts/gen-dashboards.ts (din mini-services/animaxia-observability)
 */
import { Dashboards } from '../modules/dashboards.ts';

const OPS_OUT = '../../../animaxia-ops/dashboards';
const CLOUD_OUT = '../../../animaxia-cloud/observability/global/grafana/provisioning/dashboards';

/** schelet Grafana complet (identic cu celelalte dashboards din animaxia-ops/). */
function grafanaFull(core: Record<string, unknown>): Record<string, unknown> {
  return {
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          enable: true,
          hide: true,
          iconColor: 'rgba(0, 211, 255, 1)',
          name: 'Annotations & Alerts',
          type: 'dashboard',
        },
      ],
    },
    ...core,
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    id: null,
    links: [],
    liveNow: false,
    refresh: '30s',
    tags: ['animaxia', 'faza23', 'observability'],
    templating: {
      list: [
        {
          name: 'datasource',
          label: 'Sursă de date',
          type: 'datasource',
          query: 'prometheus',
          current: { text: 'animaxia-prometheus', value: 'animaxia-prometheus' },
          hide: 0,
        },
      ],
    },
    time: { from: 'now-30m', to: 'now' },
    timepicker: {},
    timezone: 'browser',
    version: 1,
    weekStart: '',
  };
}

/** swap profund al uid-ului datasource-ului (animaxia-ops → global). */
function swapDatasource(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) return node.map((x) => swapDatasource(x, from, to));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'datasource' && v && typeof v === 'object' && (v as { uid?: string }).uid === from) {
        out[k] = { ...(v as Record<string, unknown>), uid: to };
      } else if (k === 'current' && v && typeof v === 'object') {
        // variabila template `datasource` default
        out[k] = { ...(v as Record<string, unknown>), text: to, value: to };
      } else {
        out[k] = swapDatasource(v, from, to);
      }
    }
    return out;
  }
  return node;
}

const d = new Dashboards(null as never, null as never);

let written = 0;
for (const def of Dashboards.DEFS) {
  // 1. animaxia-ops (datasource animaxia-prometheus — specificația FAZA 23)
  const opsPath = new URL(`${OPS_OUT}/${def.uid}.json`, import.meta.url).pathname;
  const opsDashboard = grafanaFull(d.grafanaJson(def.uid) as Record<string, unknown>);
  await Bun.write(opsPath, `${JSON.stringify(opsDashboard, null, 2)}\n`);
  console.log(`ops:      ${opsPath} (${(opsDashboard.panels as unknown[]).length} panels)`);
  written++;

  // 2. provisioning global (datasource animaxia-prometheus-global)
  const globalCore = swapDatasource(
    d.grafanaJson(def.uid),
    'animaxia-prometheus',
    'animaxia-prometheus-global',
  );
  const globalPath = new URL(`${CLOUD_OUT}/${def.uid}.json`, import.meta.url).pathname;
  const globalDashboard = swapDatasource(
    grafanaFull(globalCore as Record<string, unknown>),
    'animaxia-prometheus',
    'animaxia-prometheus-global',
  );
  await Bun.write(globalPath, `${JSON.stringify(globalDashboard, null, 2)}\n`);
  console.log(`global:   ${globalPath}`);
  written++;
}
console.log(`total fișiere scrise: ${written}`);
