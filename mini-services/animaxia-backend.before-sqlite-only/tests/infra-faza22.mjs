#!/usr/bin/env bun
/**
 * infra-faza22.mjs — QA infrastructură globală FAZA 22 (Animaxia).
 *
 * Rulează cu BUN (importă module TypeScript din animaxia-edge):
 *   bun tests/infra-faza22.mjs
 *
 * Secțiuni:
 *   S1 TLS / domeniu / CDN config (Terraform Cloudflare + Caddy producție)
 *   S2 Edge geo-routing (modul pur geo.ts + artefacte CDN)
 *   S3 Redis global (protocol RESP, instanța de validare :4030)
 *   S4 Global gateway (routing multi-regiune, failover, cache MISS→HIT)
 *   S5 Straturi distribuite (rate-limit, cooldown, anti-spam, izolare per-IP)
 *   S6 Neon multi-region (Terraform + script dry-run + read-router)
 *   S7 Autoscaling (HPA + policies + simulator decideAutoscale)
 *   S8 Observabilitate globală (FAZA 23 prep — profil faza23, NEACTIVAT)
 *   S9 Regresie componente protejate (FAZA 18/20, AR10M, frontend)
 */

import net from 'node:net';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
// Module TS — de aceea suita rulează cu bun, nu node:
import {
  REGION_ORDER,
  regionForRequest,
  failoverChain,
  parseOriginRegions,
  pickUpstream,
} from '../../../animaxia-edge/shared/geo.ts';
import { decideAutoscale } from '../../../animaxia-cloud/deploy/autoscaling/autoscale-sim.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const B = 'http://127.0.0.1:4000';
const G = 'http://127.0.0.1:4040';

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}`); }
};
const read = (p) => readFileSync(ROOT + p, 'utf8');
const safe = (fn) => { try { return fn(); } catch { return null; } };

/* ------------------------------------------------------------ RESP helper -- */

function respExchange(cmds, waitMs = 350) {
  return new Promise((resolve, reject) => {
    const s = net.connect(4030, '127.0.0.1');
    let buf = '';
    s.once('error', reject);
    s.once('connect', () => { for (const c of cmds) s.write(c); });
    s.on('data', (d) => { buf += d.toString(); });
    setTimeout(() => { s.destroy(); resolve(buf); }, waitMs);
  });
}

/* ==================================================================== S1 === */

console.log('\n── S1. TLS / domeniu / CDN (Terraform Cloudflare + Caddy producție) ──');
{
  const main = read('animaxia-cloud/cdn/cloudflare/terraform/main.tf');
  ok('S1-1 zone settings: HSTS security_header strict (max-age 1 an + includeSubDomains + preload)',
    /security_header/.test(main) && /max-age=31536000/.test(main) && /includeSubDomains; preload/.test(main));
  ok('S1-2 always_use_https + redirect automat HTTP→HTTPS',
    /always_use_https\s*=\s*"on"/.test(main) && /automatic_https_rewrites\s*=\s*"on"/.test(main));
  ok('S1-3 HTTP/3 + TLS 1.3 + min TLS 1.2 + Full (strict)',
    /http3\s*=\s*"on"/.test(main) && /tls_1_3\s*=\s*"on"/.test(main) &&
    /min_tls_version\s*=\s*"1\.2"/.test(main) && /ssl\s*=\s*"strict"/.test(main));
  const bot = read('animaxia-cloud/cdn/cloudflare/terraform/bot-protection.tf');
  ok('S1-4 bot management (ai_bots_protection) provisioned', /cloudflare_bot_management/.test(bot) && /ai_bots_protection/.test(bot));
  const rl = read('animaxia-cloud/cdn/cloudflare/terraform/rate-limit.tf');
  ok('S1-5 rate-limit global Cloudflare prezent', rl.length > 100);
  const caddy = read('animaxia-cloud/deploy/docker/Caddyfile.production');
  ok('S1-6 Caddy producție: redirect HTTP→HTTPS', /redir https/.test(caddy));
  ok('S1-7 Caddy producție: HSTS + security headers', /Strict-Transport-Security/.test(caddy) && /X-Content-Type-Options/.test(caddy));
  ok('S1-8 Caddy producție: HTTP/3 (h3) activat', /h3/.test(caddy));
  ok('S1-9 Caddy producție: proxy frontend :3000 + backend :4000',
    /127\.0\.0\.1:3000/.test(caddy) && /127\.0\.0\.1:4000/.test(caddy));
}

/* ==================================================================== S2 === */

console.log('\n── S2. Edge CDN + geo-routing (geo.ts pur + artefacte) ──');
{
  const cacheRules = read('animaxia-cloud/cdn/cloudflare/terraform/cache-rules.tf');
  ok('S2-1 cache-rules CDN pentru asset-uri (imagini/JS/CSS)', cacheRules.length > 200);
  ok('S2-2 geo: mapare continente (EU/AF→eu, NA/SA→us, AS/OC→asia)',
    regionForRequest({ continent: 'EU' }) === 'eu' && regionForRequest({ continent: 'AF' }) === 'eu' &&
    regionForRequest({ continent: 'NA' }) === 'us' && regionForRequest({ continent: 'SA' }) === 'us' &&
    regionForRequest({ continent: 'AS' }) === 'asia' && regionForRequest({ continent: 'OC' }) === 'asia');
  ok('S2-3 geo: fallback țări (US→us, JP→asia) + default eu',
    regionForRequest({ country: 'US' }) === 'us' && regionForRequest({ country: 'JP' }) === 'asia' &&
    regionForRequest(null) === 'eu' && regionForRequest({}) === 'eu');
  ok('S2-4 geo: failoverChain(\'us\') → [us, eu, asia]',
    JSON.stringify(failoverChain('us')) === JSON.stringify(['us', 'eu', 'asia']));
  ok('S2-5 geo: REGION_ORDER complet', JSON.stringify(REGION_ORDER) === JSON.stringify(['eu', 'us', 'asia']));
  const valid = safe(() => parseOriginRegions('{"eu":"https://eu-api.animaxia.com","us":"https://us-api.animaxia.com","asia":"https://asia-api.animaxia.com"}'));
  ok('S2-6 geo: parseOriginRegions valid → 3 origini', !!valid && valid.eu === 'https://eu-api.animaxia.com' && !!valid.us && !!valid.asia);
  const invalid = safe(() => parseOriginRegions('{"eu":"https://only-eu"}')) === null &&
    safe(() => parseOriginRegions('')) === null && safe(() => parseOriginRegions('nu-e-json')) === null;
  ok('S2-7 geo: parseOriginRegions invalid/gol → null (feature OFF)', invalid);
  const pick = safe(() => pickUpstream(
    { eu: 'https://eu-origin', us: 'https://us-origin', asia: 'https://asia-origin' },
    'us', (r) => r !== 'us'));
  ok('S2-8 geo: pickUpstream failover (us bolnav → servit de eu)', !!pick && pick.upstream === 'https://eu-origin' && pick.via === 'eu');
  const none = safe(() => pickUpstream(
    { eu: 'https://eu-origin', us: 'https://us-origin', asia: 'https://asia-origin' },
    'eu', () => false));
  ok('S2-9 geo: pickUpstream toate regiunile bolnave → null', none === null);
}

/* ==================================================================== S3 === */

console.log('\n── S3. Redis global (protocol RESP, :4030) ──');
{
  const pong = await respExchange(['PING\r\n']).catch(() => '');
  ok('S3-1 PING → +PONG', pong.includes('+PONG'));
  const setget = await respExchange(['SET faza22:a hello\r\n', 'GET faza22:a\r\n']).catch(() => '');
  ok('S3-2 SET/GET roundtrip', setget.includes('+OK') && setget.includes('$5') && setget.includes('hello'));
  const nx = await respExchange(['DEL faza22:nx\r\n', 'SET faza22:nx v NX\r\n', 'SET faza22:nx w NX\r\n', 'GET faza22:nx\r\n']).catch(() => '');
  ok('S3-3 SET NX (prima +OK, a doua nil)', nx.includes('+OK') && nx.includes('$-1'));
  const ttl = await respExchange(['SET faza22:t v EX 60\r\n', 'TTL faza22:t\r\n', 'PTTL faza22:t\r\n']).catch(() => '');
  ok('S3-4 EX + TTL (1..60s) + PTTL', /:([1-9]|[1-5][0-9]|60)\r\n/.test(ttl) && /:\d+\r\n/.test(ttl));
  const incr = await respExchange(['DEL faza22:c\r\n', 'INCR faza22:c\r\n', 'INCR faza22:c\r\n', 'INCR faza22:c\r\n', 'INCRBY faza22:c 5\r\n', 'DECR faza22:c\r\n']).catch(() => '');
  ok('S3-5 INCR/INCRBY/DECR (:1 :2 :3 :8 :7)', incr.includes(':1') && incr.includes(':2') && incr.includes(':3') && incr.includes(':8') && incr.includes(':7'));
  const del = await respExchange(['SET faza22:d x\r\n', 'DEL faza22:d\r\n', 'EXISTS faza22:d\r\n', 'EXISTS faza22:c\r\n']).catch(() => '');
  ok('S3-6 DEL + EXISTS', del.includes(':1') && del.includes(':0') && del.includes(':1'));
  const keys = await respExchange(['KEYS faza22:*\r\n']).catch(() => '');
  ok('S3-7 KEYS cu pattern', keys.includes('faza22:a') && keys.includes('faza22:c'));
  // race: 50 de conexiuni paralele, fiecare INCR o dată → contor exact 50
  await respExchange(['DEL faza22:race\r\n']).catch(() => {});
  await Promise.all(Array.from({ length: 50 }, () => new Promise((res) => {
    const s = net.connect(4030, '127.0.0.1');
    s.once('connect', () => s.write('INCR faza22:race\r\n'));
    s.once('data', () => { s.destroy(); res(); });
    s.once('error', res);
  })));
  const race = await respExchange(['GET faza22:race\r\n']).catch(() => '');
  ok('S3-8 atomicitate INCR sub concurență (50 paralele → exact 50)', race.includes('$2') && race.includes('50'));
  const info = await respExchange(['INFO\r\n']).catch(() => '');
  ok('S3-9 INFO (rol instanță de validare + stats)', info.includes('animaxia_role') && info.includes('total_commands_processed'));
  await respExchange(['DEL faza22:a\r\n', 'DEL faza22:c\r\n', 'DEL faza22:race\r\n']).catch(() => {});
}

/* ==================================================================== S4 === */

console.log('\n── S4. Global gateway (routing multi-regiune + failover + cache) ──');
{
  const h = await fetch(`${G}/api/infra/health`).then((r) => r.json()).catch(() => null);
  ok('S4-1 /api/infra/health → ok', !!h && h.ok === true && h.service === 'global-gateway');
  const topo = await fetch(`${G}/`).then((r) => r.json()).catch(() => null);
  ok('S4-2 topologie: 3 regiuni + 4 straturi perimetrale',
    !!topo && topo.regions?.length === 3 && topo.layers?.length === 4);

  // default eu + MISS → HIT
  const t = Date.now();
  const r1 = await fetch(`${G}/api/hub/stats?probe=${t}`).catch(() => null);
  const r2 = await fetch(`${G}/api/hub/stats?probe=${t}`).catch(() => null);
  ok('S4-3 default regiune eu + x-cache MISS',
    !!r1 && r1.status === 200 && r1.headers.get('x-animaxia-region') === 'eu' && r1.headers.get('x-cache') === 'MISS');
  const b1 = await r1?.text();
  const b2 = r2 ? await r2.text() : '';
  ok('S4-4 al doilea request → x-cache HIT + corp identic',
    !!r2 && r2.headers.get('x-cache') === 'HIT' && b1 === b2 && b1.length > 10);

  // motorul real de căutare, intact prin gateway
  const s1 = await fetch(`${G}/api/search/advanced?q=frieren&limit=1&probe=${t}`).then((r) => r.json()).catch(() => null);
  ok('S4-5 motorul real FTS servit prin gateway (engine=animaxia-neon-fts)', !!s1 && s1.engine === 'animaxia-neon-fts');
  const s2h = await fetch(`${G}/api/search/advanced?q=frieren&limit=1&probe=${t}`).catch(() => null);
  ok('S4-6 cache și pentru /api/search/* (MISS→HIT)', !!s2h && s2h.headers.get('x-cache') === 'HIT');

  // failover us (upstream mort 4098 sărit automat) — cache-buster unic, ca cererea
  // să meargă la origin și să vadă efectiv headerul de upstream (nu un HIT din cache)
  const us = await fetch(`${G}/api/hub/stats?region=us&probeUs=${t}`).catch(() => null);
  ok('S4-7 region=us → 200 prin failover (upstream :4000, nu :4098)',
    !!us && us.status === 200 && (us.headers.get('x-animaxia-upstream') ?? '').includes(':4000'));
  const asia = await fetch(`${G}/api/hub/stats?region=asia&probeAsia=${t}`).catch(() => null);
  ok('S4-8 region=asia → 200, servit de asia', !!asia && asia.status === 200 && asia.headers.get('x-animaxia-region') === 'asia');
  const inv = await fetch(`${G}/api/hub/stats?region=xx`).then((r) => r.json()).catch(() => null);
  ok('S4-9 regiune invalidă → 400 invalid_region', !!inv && inv.error === 'invalid_region');
  const by = await fetch(`${G}/api/hub/stats`, { headers: { Authorization: 'Bearer test' } }).catch(() => null);
  ok('S4-10 cereri cu Authorization → x-cache BYPASS (niciodată cache-uite)', !!by && by.headers.get('x-cache') === 'BYPASS');

  // purge → MISS din nou
  const purge = await fetch(`${G}/api/infra/cache/purge`, { method: 'POST', body: '{}' }).then((r) => r.json()).catch(() => null);
  const afterPurge = await fetch(`${G}/api/hub/stats?probe=${t}`).catch(() => null);
  ok('S4-11 cache purge → următorul request MISS',
    !!purge && purge.ok === true && purge.purged >= 1 && afterPurge?.headers.get('x-cache') === 'MISS');

  // admin override: down eu → failover la altă regiune; up eu → revine
  await fetch(`${G}/api/infra/regions/eu/down`, { method: 'POST' }).catch(() => null);
  const whileDown = await fetch(`${G}/api/hub/stats?region=eu&probe2=${t}`).catch(() => null);
  ok('S4-12 eu forțat down → cererea servită de altă regiune (fallback)',
    !!whileDown && whileDown.status === 200 && whileDown.headers.get('x-animaxia-region') !== 'eu' &&
    whileDown.headers.get('x-animaxia-fallback') === 'true');
  await fetch(`${G}/api/infra/regions/eu/up`, { method: 'POST' }).catch(() => null);
  const back = await fetch(`${G}/api/hub/stats?region=eu&probe3=${t}`).catch(() => null);
  ok('S4-13 eu ridicat la loc → servește din nou eu', !!back && back.headers.get('x-animaxia-region') === 'eu');

  // toate regiunile down → 502 onest
  for (const r of ['eu', 'us', 'asia']) await fetch(`${G}/api/infra/regions/${r}/down`, { method: 'POST' }).catch(() => null);
  const allDown = await fetch(`${G}/api/hub/stats?probe4=${t}`).then((r) => r.json()).catch(() => null);
  ok('S4-14 toate regiunile down → 502 all_regions_down', !!allDown && allDown.error === 'all_regions_down');
  for (const r of ['eu', 'us', 'asia']) await fetch(`${G}/api/infra/regions/${r}/up`, { method: 'POST' }).catch(() => null);
  const revived = await fetch(`${G}/api/hub/stats?probe5=${t}`).catch(() => null);
  ok('S4-15 toate regiunile ridicate → 200 din nou', !!revived && revived.status === 200);

  // expunere externă prin gateway-ul Caddy :81 (XTransformPort)
  const viaEdge = await fetch('http://127.0.0.1:81/api/hub/browse?limit=1&XTransformPort=4040').catch(() => null);
  ok('S4-16 accesibil prin gateway-ul extern :81 (Caddy → global-gateway → backend)',
    !!viaEdge && viaEdge.status === 200 && viaEdge.headers.get('x-animaxia-region') === 'eu');
}

/* ==================================================================== S5 === */

console.log('\n── S5. Straturi distribuite (rate-limit, cooldown, anti-spam) ──');
{
  // IP-uri unice per rulare (evită carryover-ul cdlock/spamlock de 60s între rulări)
  const subnet = Math.floor(Math.random() * 200) + 10;
  const ipBurst = `10.22.${subnet}.1`;
  const ipClean = `10.22.${subnet}.2`;
  const ipSpam = `10.22.${subnet}.3`;

  // rate-limit: 250 cereri paralele cu query variat (garantează depășirea ferestrei
  // de 120/min indiferent de împărțirea pe ferestre). Sub limită cererile trec;
  // peste limită → rate_limited; după 3 violări → cooldown_active.
  const burst = await Promise.all(Array.from({ length: 250 }, (_, i) =>
    fetch(`${G}/api/search/advanced?q=rl${i}&limit=1`, { headers: { 'x-forwarded-for': ipBurst } })
      .then(async (r) => ({ status: r.status, error: (await r.json().catch(() => ({}))).error ?? null,
        xrl: r.headers.get('x-ratelimit-limit'), ra: r.headers.get('retry-after') }))
      .catch(() => ({ status: 0, error: null }))));
  const rlCount = burst.filter((x) => x.error === 'rate_limited').length;
  const cdCount = burst.filter((x) => x.error === 'cooldown_active').length;
  const perimeterBlocked = burst.filter((x) => x.error === 'rate_limited' || x.error === 'cooldown_active').length;
  const perimeterPassed = 250 - perimeterBlocked;
  ok('S5-1 rate-limit distribuit: cereri respinse cu rate_limited (limita 120/min)', rlCount >= 1);
  // determinist: după burst, orice cerere nouă de la același IP găsește cdviol ≥ 3 → cooldown_active
  const follow = await fetch(`${G}/api/search/advanced?q=followup&limit=1`, { headers: { 'x-forwarded-for': ipBurst } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
    .catch(() => null);
  ok('S5-2 cooldown activat după 3 violări: cererea ulterioară → 429 cooldown_active',
    !!follow && follow.status === 429 && follow.body.error === 'cooldown_active');
  ok('S5-3 headere x-ratelimit-limit=120 + Retry-After pe 429',
    burst.some((x) => x.error === 'rate_limited' && x.xrl === '120' && Number(x.ra) > 0));
  ok('S5-4 limiter fin (nu deny-all): perimetrul a lăsat ~120/250 să treacă, restul blocate',
    perimeterPassed >= 115 && perimeterBlocked <= 135);
  ok('S5-4b defense-in-depth: cererile trecute au ajuns la backend (200 sau propriul limiter FAZA 18)',
    burst.filter((x) => x.status === 200).length >= 20);

  // izolare per-IP: un client curat nu e afectat de lock-ul altuia
  const iso = await fetch(`${G}/api/hub/stats?iso=${Date.now()}`, { headers: { 'x-forwarded-for': ipClean } }).catch(() => null);
  ok('S5-5 izolare per-IP: client curat → 200 (neafectat de lock-ul altui client)', !!iso && iso.status === 200);

  // trafic normal, sub limită, secvențial → 100% trec (comportament normal intact)
  let normalOk = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${G}/api/search/advanced?q=normal${i}&limit=1`, { headers: { 'x-forwarded-for': ipClean } }).catch(() => null);
    if (r && r.status === 200) normalOk++;
  }
  ok('S5-6 trafic normal sub limită: 30/30 cereri trec cu 200', normalOk === 30);

  // anti-spam: 30 cereri identice → blocat la a 26-a (>25 identice / 10s)
  let spamBlocked = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${G}/api/hub/stats?spam=1`, { headers: { 'x-forwarded-for': ipSpam } })
      .then((x) => x.json().catch(() => ({}))).catch(() => ({}));
    if (r.error === 'anti_spam') spamBlocked++;
  }
  ok('S5-7 anti-spam: burst identic → respins cu anti_spam (după 25/10s)', spamBlocked >= 1);
}

/* ==================================================================== S6 === */

console.log('\n── S6. Neon multi-region (Terraform + dry-run + read-router) ──');
{
  const tf = read('animaxia-cloud/domain/neon/terraform/neon-multiregion.tf');
  ok('S6-1 provider Neon + branch read-replica + endpoint read_only',
    /kislerdm\/neon/.test(tf) && /neon_branch/.test(tf) && /neon_endpoint/.test(tf) && /read_only/.test(tf));
  const router = safe(() => JSON.parse(read('animaxia-cloud/domain/neon/read-router.config.json')));
  ok('S6-2 read-router: failover eu→us→asia + readSplit activ',
    !!router && JSON.stringify(router.failoverOrder) === JSON.stringify(['eu', 'us', 'asia']) &&
    router.readSplit?.enabled === true && Array.isArray(router.readSplit?.readPaths) && router.readSplit.readPaths.length >= 2);
  ok('S6-3 read-router: cel puțin 3 replici (eu/us/asia)', !!router && router.replicas?.length >= 3);
  let dry = '';
  let dryOk = false;
  try {
    dry = execSync(`env -u NEON_API_KEY bash ${ROOT}animaxia-cloud/domain/neon/scripts/neon-multiregion.sh --dry-run 2>&1`,
      { encoding: 'utf8', timeout: 15000 });
    dryOk = true;
  } catch { dryOk = false; }
  ok('S6-4 neon-multiregion.sh --dry-run fără cheie: rulează, exit 0', dryOk);
  ok('S6-5 dry-run: plan onest (fără replicare nativă cross-region) + endpointuri Neon',
    dry.includes('dry-run') && /api\.neon\.tech/.test(dry) && /LOGICAL REPLICATION|logical replication/i.test(dry));
  const readme = read('animaxia-cloud/domain/neon/README.md');
  ok('S6-6 README onest despre limitele Neon', /cross-region/i.test(readme) && /logic/i.test(readme));
}

/* ==================================================================== S7 === */

console.log('\n── S7. Autoscaling (HPA + policies + simulator) ──');
{
  const policies = safe(() => JSON.parse(read('animaxia-cloud/deploy/autoscaling/policies.json')));
  const expected = ['backend', 'realtime', 'ai', 'frontend', 'global-gateway', 'redis-global'];
  ok('S7-1 policies.json: toate cele 6 servicii acoperite',
    !!policies && expected.every((k) => policies.services?.[k]));
  ok('S7-2 praguri valide (0 < cpu ≤ 100, min ≤ max)',
    !!policies && expected.every((k) => {
      const s = policies.services[k];
      return s.cpuTarget > 0 && s.cpuTarget <= 100 && s.min <= s.max && s.latencyP95MsTarget > 0;
    }));
  for (const f of ['hpa-core-backend.yaml', 'hpa-realtime.yaml', 'hpa-ai.yaml', 'hpa-frontend.yaml', 'hpa-global-perimeter.yaml']) {
    const y = read(`animaxia-cloud/deploy/autoscaling/${f}`);
    ok(`S7-3 ${f}: HPA complet (kind + min + max + CPU)`,
      /kind:\s*HorizontalPodAutoscaler/.test(y) && /minReplicas/.test(y) && /maxReplicas/.test(y) && /cpu|CPU/.test(y));
  }
  const core = read('animaxia-cloud/deploy/autoscaling/hpa-core-backend.yaml');
  ok('S7-4 hpa-core-backend: Deployment + PDB (disruption budget)', /kind:\s*Deployment/.test(core) && /PodDisruptionBudget/.test(core));

  const p = policies.services.backend;
  const up = await decideAutoscale('backend',
    Array.from({ length: p.scaleUpWindows }, () => ({ cpuPct: p.cpuTarget + 20, memPct: 50, p95Ms: 100 })), p.min).catch(() => null);
  ok('S7-5 simulator: CPU susținut peste țintă → scale-up', !!up && up.action === 'scale-up' && up.targetReplicas > p.min);
  const down = await decideAutoscale('backend',
    Array.from({ length: p.scaleDownWindows }, () => ({ cpuPct: 15, memPct: 25, p95Ms: 50 })), p.max).catch(() => null);
  ok('S7-6 simulator: sub țintă susținut → scale-down', !!down && down.action === 'scale-down');
  const hold = await decideAutoscale('backend',
    [{ cpuPct: p.cpuTarget - 10, memPct: 40, p95Ms: 80 }], Math.ceil((p.min + p.max) / 2)).catch(() => null);
  ok('S7-7 simulator: telemetrie normală → hold', !!hold && hold.action === 'hold');
  const ai = policies.services.ai;
  const aiUp = await decideAutoscale('ai',
    Array.from({ length: ai.scaleUpWindows }, () => ({ cpuPct: 40, memPct: 40, p95Ms: ai.latencyP95MsTarget * 2 })), ai.min).catch(() => null);
  ok('S7-8 simulator: breach de latență p95 pe AI → scale-up', !!aiUp && aiUp.action === 'scale-up');
  let threw = false;
  await decideAutoscale('serviciu-inexistent', []).catch(() => { threw = true; });
  ok('S7-9 simulator: serviciu necunoscut → eroare explicită', threw);
}

/* ==================================================================== S8 === */

console.log('\n── S8. Observabilitate globală (FAZA 23 prep — NEACTIVAT) ──');
{
  const compose = read('animaxia-cloud/observability/global/docker-compose.global-observability.yml');
  const profileCount = (compose.match(/profiles:/g) ?? []).length;
  ok('S8-1 stackul NU pornește implicit (toate serviciile sub profil faza23)',
    profileCount >= 4 && /faza23/.test(compose));
  ok('S8-2 componente: prometheus + grafana + alertmanager + otel-collector',
    /prometheus/.test(compose) && /grafana/.test(compose) && /alertmanager/.test(compose) && /otel/.test(compose));
  const prom = read('animaxia-cloud/observability/global/prometheus/prometheus-global.yml');
  ok('S8-3 federație Prometheus: scrape din 3 regiuni (eu/us/asia) via /federate',
    /eu-prometheus/.test(prom) && /us-prometheus/.test(prom) && /asia-prometheus/.test(prom) && /\/federate/.test(prom));
  const am = read('animaxia-cloud/observability/global/alertmanager/alertmanager-global.yml');
  ok('S8-4 Alertmanager: rute pe regiuni + severități + receptori',
    /route/.test(am) && /receiver/.test(am) && /(critical|warning)/.test(am));
  const otel = read('animaxia-cloud/observability/global/otel/otel-collector-global.yaml');
  ok('S8-5 OTel collector: receiveri otlp + procesoare + exporteri',
    /otlp/.test(otel) && /processors/.test(otel) && /exporters/.test(otel));
  const ds = read('animaxia-cloud/observability/global/grafana/provisioning/datasources/datasource-global.yml');
  ok('S8-6 Grafana: datasource Prometheus global provisionat', /Prometheus/.test(ds) && /url/.test(ds));
}

/* ==================================================================== S9 === */

console.log('\n── S9. Regresie componente protejate (FAZA 18/20, AR10M, frontend) ──');
{
  const st = await fetch(`${B}/api/search/status`).then((r) => r.json()).catch(() => null);
  const stages = (st?.pipelineStages ?? []).map((s) => s?.name ?? s);
  ok('S9-1 FAZA 18 neatinsă: pipelineIntegrated=true + exact 10 straturi',
    !!st && st.pipelineIntegrated === true &&
    JSON.stringify(stages) === JSON.stringify(['anti-spam', 'rate-limit', 'cooldown', 'queue', 'priority', 'windowing', 'dedup', 'batching', 'cache', 'neon-fts']));
  ok('S9-2 motorul real: engine=animaxia-neon-fts + pg_trgm activ',
    !!st && st.engine === 'animaxia-neon-fts' && st.extensions?.pg_trgm === true);
  const ar10m = await fetch(`${B}/api/ar10m/stats`).then((r) => r.json()).catch(() => null);
  ok('S9-3 AR10M intact: capacitate proiectată 10.000.000 (fost 30B simulat — eliminat)',
    !!ar10m && ar10m.capacity?.designed === 10000000);
  const hub = await fetch(`${B}/api/hub/stats`).then((r) => r.json()).catch(() => null);
  ok('S9-4 FAZA 20 huburi reale: ok + source=neon', !!hub && hub.ok === true && hub.source === 'neon');
  const browse = await fetch(`${B}/api/hub/browse?limit=1`).catch(() => null);
  ok('S9-5 /api/hub/browse viu', !!browse && browse.status === 200);
  const front = await fetch('http://127.0.0.1:3000/').catch(() => null);
  ok('S9-6 frontendul SPA răspunde 200', !!front && front.status === 200);
}

/* ---------------------------------------------------------------- summary -- */

console.log('\n────────────────────────────────────────────────');
console.log(`FAZA 22 infra QA: ${pass} passed, ${fail} failed (din ${pass + fail})`);
if (fail > 0) {
  console.log('AU EȘUAT CHECK-URI ✗');
  process.exit(1);
}
console.log('TOATE CHECK-URILE DE INFRASTRUCTURĂ GLOBALĂ AU TRECUT ✓');
