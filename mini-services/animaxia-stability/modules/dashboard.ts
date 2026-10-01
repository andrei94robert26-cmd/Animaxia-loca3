/**
 * dashboard.ts — FAZA 24 — dashboard HTML self-contained (fără dependențe).
 * Servit la GET / — arată live: autoscaling (8 ținte), load balancing global,
 * failover, deploy zero-downtime, traffic shaping. NEON FREE PLAN: fără
 * auto-refresh — refresh on-demand (buton „Refresh” + la încărcarea paginii).
 * Acces prin gateway: http://localhost:81/?XTransformPort=4060
 */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Animaxia · FAZA 24 — Stabilitate Globală</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background:#0a0a10; color:#e4e4e7; font: 14px/1.5 ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif; padding: 20px; }
  a { color:#fda4af; text-decoration:none; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display:flex; flex-wrap:wrap; align-items:baseline; gap:10px; margin-bottom:14px; }
  h1 { font-size:22px; color:#fafafa; letter-spacing:.3px; }
  h1 .tag { color:#f43f5e; }
  .sub { color:#a1a1aa; font-size:13px; }
  .pill { font-size:11px; padding:3px 10px; border-radius:999px; border:1px solid; white-space:nowrap; }
  .ok { color:#6ee7b7; border-color:#065f46; background:#052e2b; }
  .warn { color:#fcd34d; border-color:#78350f; background:#422006; }
  .err { color:#fda4af; border-color:#7f1d1d; background:#450a0a; }
  .grid { display:grid; gap:12px; }
  .cols-2 { grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); }
  .cols-3 { grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }
  .cols-4 { grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); }
  section { margin-bottom:18px; }
  h2 { font-size:15px; color:#fafafa; margin-bottom:8px; border-left:3px solid #f43f5e; padding-left:8px; }
  h2 small { color:#71717a; font-weight:400; }
  .card { background:#111118; border:1px solid #27272a; border-radius:12px; padding:12px 14px; }
  .card .label { color:#a1a1aa; font-size:11px; text-transform:uppercase; letter-spacing:.6px; }
  .big { font-size:24px; font-weight:700; color:#fafafa; margin:2px 0; }
  .big .minmax { font-size:12px; color:#71717a; font-weight:400; }
  .kv { display:flex; justify-content:space-between; gap:8px; font-size:12.5px; padding:2px 0; border-bottom:1px dashed #27272a; }
  .kv:last-child { border-bottom:0; }
  .kv .k { color:#a1a1aa; }
  .m { font-size:12px; color:#d4d4d8; }
  .m b { color:#fafafa; font-weight:600; }
  .rule { display:flex; justify-content:space-between; font-size:11.5px; color:#71717a; padding:1px 0; }
  .rule .live { color:#6ee7b7; }
  .rule .hold { color:#fcd34d; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { text-align:left; color:#71717a; font-weight:500; font-size:11px; text-transform:uppercase; padding:4px 6px; border-bottom:1px solid #27272a; }
  td { padding:4px 6px; border-bottom:1px solid #1c1c22; }
  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px; }
  .ev { font-size:12px; padding:4px 0; border-bottom:1px dashed #1c1c22; }
  .ev:last-child { border-bottom:0; }
  .t { color:#71717a; font-size:11px; }
  .chain { color:#71717a; font-size:11.5px; }
  .arrow { color:#f43f5e; }
  .bar { height:5px; border-radius:4px; background:#27272a; overflow:hidden; margin-top:6px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#f43f5e,#fb7185); }
  .bar.g > i { background:linear-gradient(90deg,#059669,#34d399); }
  footer { margin-top:22px; color:#52525b; font-size:12px; text-align:center; }
  .empty { color:#52525b; font-style:italic; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Animaxia <span class="tag">· FAZA 24 — Stabilitate Globală</span></h1>
    <span class="pill ok" id="health-pill">…</span>
    <button id="refresh-btn" type="button" style="cursor:pointer;font:inherit;padding:6px 14px;border:1px solid #888;border-radius:8px;background:#111;color:#eee">↻ Refresh</button>
    <span class="sub" id="sub">autoscaling · load balancing EU/US/ASIA · failover · zero-downtime · traffic shaping · refresh manual (NEON FREE PLAN)</span>
  </header>

  <section>
    <h2>Health-check global <small>— backend · gateway · observability (obligatorii) + servicii urmărite</small></h2>
    <div class="grid cols-4" id="health"></div>
  </section>

  <section>
    <h2>Autoscaling <small>— 8 ținte, reguli exacte FAZA 24 (metrici reale de pe platformă)</small></h2>
    <div class="grid cols-4" id="autoscaling"></div>
  </section>

  <section>
    <h2>Load balancing global <small>— geo-routing + fallback automat</small></h2>
    <div class="grid cols-3" id="regions"></div>
  </section>

  <section>
    <div class="grid cols-2">
      <div class="card">
        <h2 style="border:0;padding:0;margin-bottom:8px">Failover <small>— evenimente recente</small></h2>
        <div id="failover"><div class="empty">se încarcă…</div></div>
      </div>
      <div class="card">
        <h2 style="border:0;padding:0;margin-bottom:8px">Zero-downtime deploy <small>— rolling + rollback automat</small></h2>
        <div id="deploy"><div class="empty">se încarcă…</div></div>
      </div>
    </div>
  </section>

  <section>
    <h2>Traffic shaping <small>— priorități + limite per regiune + praguri overload</small></h2>
    <div class="grid cols-3" id="shaping"></div>
  </section>

  <footer>
    animaxia-stability :4060 — plan de control FAZA 24 · platforma protejată (FAZA 18/20/21/23, Neon FTS, 30B, FAZA 13/17, AI 15/16) este doar observată și susținută
  </footer>
</div>

<script>
  const QP = new URLSearchParams(location.search).get('XTransformPort');
  const API = (p) => QP ? p + '?XTransformPort=' + QP : p;
  const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const num = (v, d=1) => v == null ? '—' : (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(d)) : v);
  const pct = (v) => v == null ? '—' : num(v,1) + '%';

  function pill(up, txt) { return '<span class="pill ' + (up ? 'ok' : 'err') + '">' + (up ? '✓ ' : '✗ ') + esc(txt) + '</span>'; }

  function healthCard(name, st) {
    const lat = st.latencyMs != null ? st.latencyMs + 'ms' : '—';
    return '<div class="card">' +
      '<div class="label">' + esc(name) + '</div>' +
      '<div class="big" style="font-size:17px">' + (st.up ? '🟢 UP' : '🔴 DOWN') + '</div>' +
      '<div class="m">latență <b>' + lat + '</b>' + (st.error ? ' · <span style="color:#fda4af">' + esc(st.error.slice(0,40)) + '</span>' : '') + '</div>' +
    '</div>';
  }

  function targetCard(t) {
    const rules = (t.ruleStates || []).map(r => {
      const v = r.lastValue != null ? ' · acum ' + num(r.lastValue,1) : '';
      const state = r.fired ? '<span class="live">declanșată</span>'
        : (r.active ? '<span class="hold">menținută ' + Math.max(0, Math.round(r.satisfiedFor)) + 's/' + r.windowSec + 's' + v + '</span>' : 'inactivă' + v);
      return '<div class="rule"><span>' + esc(r.id) + '</span><span>' + state + '</span></div>';
    }).join('');
    const last = (t.decisions && t.decisions.length)
      ? t.decisions[t.decisions.length-1] : null;
    return '<div class="card">' +
      '<div class="label">' + esc(t.policy.label) + '</div>' +
      '<div class="big">' + t.replicas + ' <span class="minmax">/ ' + t.policy.minReplicas + '–' + t.policy.maxReplicas + ' replici</span></div>' +
      '<div class="m">' + (t.lastMetrics || '') + '</div>' +
      (last ? '<div class="m" style="color:#fda4af">ultima decizie: ' + (last.direction === 'out' ? 'scale-OUT' : 'scale-IN') + ' → ' + last.to + ' (' + esc(last.rule) + ')</div>' : '<div class="m" style="color:#71717a">fără decizii (ferestrele nu s-au saturat)</div>') +
      '<div style="margin-top:6px">' + rules + '</div>' +
    '</div>';
  }

  function regionCard(r, rt) {
    return '<div class="card">' +
      '<div class="label">' + esc(r.label) + ' · ' + (r.healthy ? 'sănătoasă' : 'DOWN') + '</div>' +
      '<div class="big" style="font-size:17px">' + (r.healthy ? '🟢' : '🔴') + ' ' + esc(r.reason) + '</div>' +
      '<div class="m">fallback: ' + r.chain.map(c => '<b>' + c.toUpperCase() + '</b>').join(' <span class="arrow">→</span> ') + '</div>' +
      (rt ? '<div class="m">RPS real <b>' + num(rt.rps,2) + '</b> · latență upstream <b>' + num(rt.latencyMs,0) + 'ms</b> · upstream-uri <b>' + rt.upstreamsHealthy + '/' + rt.upstreamsTotal + '</b></div>' : '') +
    '</div>';
  }

  function failoverHtml(f) {
    if (!f.events || !f.events.length) return '<div class="empty">niciun eveniment — platformă stabilă</div>';
    return f.events.slice(0,8).map(e =>
      '<div class="ev"><span class="t">' + new Date(e.t).toLocaleTimeString('ro-RO') + '</span> · <b>' + esc(e.target) + '</b> → ' + esc(e.action) + (e.simulated ? ' <span class="t">(QA)</span>' : '') + '<br><span class="t">' + esc(e.detail) + '</span></div>'
    ).join('');
  }

  function deployHtml(d) {
    let html = '';
    if (d.active) {
      const done = d.active.steps.filter(s => s.action === 'retire-old').length;
      html += '<div class="ev"><b>' + esc(d.active.target) + '</b> ' + esc(d.active.fromVersion) + ' <span class="arrow">→</span> ' + esc(d.active.toVersion) +
        ' · rollout ACTIV ' + done + '/' + d.active.replicas + ' replici · unavailable 0</div>';
    }
    const hist = (d.history || []).slice(0,6).map(h =>
      '<div class="ev"><span class="t">' + new Date(h.startedAt).toLocaleTimeString('ro-RO') + '</span> · <b>' + esc(h.target) + '</b> → ' + esc(h.toVersion) +
      ' · <span class="' + (h.status === 'success' ? 'live' : '') + '" style="' + (h.status === 'success' ? 'color:#6ee7b7' : 'color:#fcd34d') + '">' + (h.status === 'success' ? 'SUCCES' : 'ROLLBACK') + '</span>' +
      (h.reason ? '<br><span class="t">' + esc(h.reason) + '</span>' : '') + '</div>'
    ).join('');
    return html + (hist || '<div class="empty">niciun rollout în istoric</div>');
  }

  function shapingCard(s) {
    if (s.regions) {
      const r = s.regions;
      const ratio = r.loadRatio != null ? Math.min(100, r.loadRatio * 100 / 2) : 0;
      return '<div class="card">' +
        '<div class="label">' + r.region.toUpperCase() + ' · limită ' + r.limitRps + ' RPS</div>' +
        '<div class="big" style="font-size:17px">' + num(r.currentRps,2) + ' <span class="minmax">RPS real · raport ' + num(r.loadRatio,2) + '×</span></div>' +
        '<div class="bar' + (r.loadRatio != null && r.loadRatio < 1 ? ' g' : '') + '"><i style="width:' + ratio + '%"></i></div>' +
      '</div>';
    }
    if (s.classes) {
      return '<div class="card">' +
        '<div class="label">priorități</div>' +
        s.classes.map(c => '<div class="m"><b>' + c.clazz + '</b> — ' + esc(c.label.split('—')[1] || c.label) + '</div>').join('') +
        '<div class="m" style="margin-top:4px">praguri: shed ≥' + s.thresholds.shedSheddable + '× · throttle ≥' + s.thresholds.throttleNormal + '× · shed normal ≥' + s.thresholds.shedNormal + '× · throttle critical ≥' + s.thresholds.throttleCritical + '×</div>' +
        '<div class="m">decizii: <b style="color:#6ee7b7">' + s.counters.allow + '</b> allow · <b style="color:#fcd34d">' + s.counters.throttle + '</b> throttle · <b style="color:#fda4af">' + s.counters.shed + '</b> shed</div>' +
      '</div>';
    }
    return '<div class="card"><div class="empty">—</div></div>';
  }

  async function refresh() {
    try {
      const res = await fetch(API('/api/status'));
      const d = await res.json();
      document.getElementById('health-pill').className = 'pill ' + (d.ok ? 'ok' : 'err');
      document.getElementById('health-pill').textContent = (d.ok ? '✓ control plane activ · ' : '✗ degradat · ') + 'uptime ' + Math.floor(d.uptimeSec/60) + 'm';
      document.getElementById('health').innerHTML =
        Object.entries(d.lb.healthChecks).map(([n, s]) => healthCard(n, s)).join('');
      const metricsLine = {
        backend: 'CPU <b>' + pct(d.metrics.backend.cpuPct) + '</b> · p95 <b>' + num(d.metrics.backend.latencyP95Ms,0) + 'ms</b> · coadă <b>' + num(d.metrics.backend.queueLength,0) + '</b> · RSS <b>' + (d.metrics.backend.rssBytes ? Math.round(d.metrics.backend.rssBytes/1048576) + 'MB' : '—') + '</b>',
      };
      document.getElementById('autoscaling').innerHTML = d.autoscaling.targets.map(t => {
        t.lastMetrics = metricsLine[t.policy.id] || '';
        return targetCard(t);
      }).join('');
      document.getElementById('regions').innerHTML = d.lb.regions.map(r =>
        regionCard(r, d.metrics.gateway[r.name])).join('');
      document.getElementById('failover').innerHTML = failoverHtml(d.failover);
      document.getElementById('deploy').innerHTML = deployHtml(d.deploy);
      document.getElementById('shaping').innerHTML =
        d.shaping.regions.map(r => shapingCard({ regions: r })).join('') +
        shapingCard({ classes: d.shaping.classes, thresholds: d.shaping.thresholds, counters: d.shaping.counters });
    } catch (e) {
      document.getElementById('health-pill').className = 'pill err';
      document.getElementById('health-pill').textContent = '✗ indisponibil: ' + e.message;
    }
  }
  /* NEON FREE PLAN: fără auto-refresh (fost setInterval 5s care ținea
   *  backendul/Neon agitat fără niciun utilizator). Refresh on-demand:
   *   · la încărcarea paginii (o singură citire)
   *   · butonul „↻ Refresh” (acțiune explicită a utilizatorului)
   *   · revenirea pe tab (visibilitychange) — doar dacă utilizatorul e activ */
  refresh();
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
</script>
</body>
</html>`;
}
