/**
 * shared/waf.ts — Web Application Firewall rules for the edge gateway:
 *   • bot blocking (known crawler/tool user-agents)
 *   • SQL injection patterns (conservative regexes; benign titles like
 *     "O'Reilly" or "one or two" must pass — verified in smoke tests)
 *   • XSS payloads (script tags, event handlers, javascript: URIs)
 *   • path traversal (../ and ..%2f sequences)
 *   • oversized query strings + encoded null bytes
 *
 * Blocked requests are logged to EDGE_CACHE KV (waf:{ts}:{id}, TTL from
 * config) so the cloud security module can audit them.
 */

import type { EdgeEnv, EdgeCtx, WafVerdict } from './types';
import type { EdgeConfig } from './config';
import { clientIpOf, requestIdOf } from './http';

/* ---------------------------------------------------------------- rules ---- */

// Known bots / scripted clients. Legitimate API consumers (browsers, the
// mobile app, the desktop app) send identifying product UAs.
const BOT_UA_RE = new RegExp(
  '(' + [
    'curl', 'wget', 'python-requests', 'python-httpx', 'aiohttp', 'httpclient',
    'go-http-client', 'java/', 'apache-httpclient', 'libwww', 'scrapy', 'bytespider',
    'semrushbot', 'ahrefsbot', 'mj12bot', 'dotbot', 'petalbot', 'dataforseo',
    'gridsystems', 'zgrab', 'masscan', 'nmap', 'sqlmap', 'nikto', 'hydra',
  ].join('|') + ')',
  'i',
);

// SQLi fingerprints — all require SQL keywords in attack-shaped context.
const SQLI_RES: RegExp[] = [
  /(\bunion\b[\s\S]{0,40}?\bselect\b)/i,
  /(\bselect\b[\s\S]{0,40}?\bfrom\b[\s\S]{0,40}?\bwhere\b)/i,
  /('\s*or\s*'?\d+'?\s*=\s*'??\d)/i,            // ' or '1'='1
  /(\bor\b\s+\d+\s*=\s*\d+\s*--)/i,             // or 1=1 --
  /(;)\s*(drop|alter|truncate|delete|insert|update)\s+(table|database|schema|into|from)\b/i,
  /(\bexec\b|\bexecute\b)\s*\(\s*@?\w+\s*\)/i,  // exec(@x)
  /(benchmark\s*\(\s*\d+\s*,)/i,
  /(sleep\s*\(\s*\d+\s*\))/i,
  /(load_file\s*\()/i,
  /(information_schema\b|pg_sleep\b|xp_cmdshell\b)/i,
];

// XSS fingerprints.
const XSS_RES: RegExp[] = [
  /<\s*script\b/i,
  /<\s*\/\s*script\s*>/i,
  /javascript\s*:/i,
  /\bon(error|load|click|mouseover|focus|animationstart)\s*=/i,
  /<\s*img\b[^>]*\bsrc\s*=\s*[x"'`]/i,
  /<\s*(iframe|embed|object)\b/i,
  /(document\.cookie|window\.location\s*=)/i,
  /(<\s*svg\b[^>]*\bon\w+\s*=)/i,
];

// Path traversal: ../, ..\, ..%2f, %2e%2e%2f (case-insensitive).
const TRAVERSAL_RES: RegExp[] = [
  /(\.\.\/|\.\.\\)/,
  /(%2e%2e(%2f|%5c|\/|\\))/i,
  /(\.\.%2f|\.\.%5c)/i,
];

/* ------------------------------------------------------------- inspect ----- */

function decodeCandidates(input: string): string[] {
  const out = [input];
  try {
    const once = decodeURIComponent(input);
    out.push(once);
    const twice = decodeURIComponent(once);
    if (twice !== once) out.push(twice);
  } catch { /* malformed encoding — raw form is still checked */ }
  return out;
}

/**
 * Inspect a request against WAF rules. Checks URL path + query (all
 * decode passes), the raw query size and the User-Agent.
 */
export function wafInspect(request: Request, url: URL, cfg: EdgeConfig): WafVerdict {
  if (!cfg.waf.enabled) return { blocked: false, rule: null, reason: 'waf disabled' };

  const target = `${url.pathname}${url.search}`;
  const candidates = decodeCandidates(target);

  // Bot blocking.
  if (cfg.waf.blockBots) {
    const ua = request.headers.get('user-agent') || '';
    if (ua && BOT_UA_RE.test(ua)) {
      return { blocked: true, rule: 'bot', reason: `blocked user-agent: ${ua.slice(0, 80)}` };
    }
  }

  // Oversized query.
  if (cfg.waf.maxQueryBytes > 0 && url.search.length > cfg.waf.maxQueryBytes) {
    return { blocked: true, rule: 'query-size', reason: `query exceeds ${cfg.waf.maxQueryBytes} bytes` };
  }

  // Encoded null byte anywhere in path/query.
  if (/%00/i.test(url.search) || /%00/i.test(url.pathname)) {
    return { blocked: true, rule: 'null-byte', reason: 'encoded null byte in URL' };
  }

  for (const candidate of candidates) {
    if (cfg.waf.sql) {
      for (const re of SQLI_RES) {
        if (re.test(candidate)) {
          return { blocked: true, rule: 'sqli', reason: `SQLi pattern matched: ${re.source.slice(0, 60)}` };
        }
      }
    }
    if (cfg.waf.xss) {
      for (const re of XSS_RES) {
        if (re.test(candidate)) {
          return { blocked: true, rule: 'xss', reason: `XSS pattern matched: ${re.source.slice(0, 60)}` };
        }
      }
    }
    if (cfg.waf.traversal) {
      for (const re of TRAVERSAL_RES) {
        if (re.test(candidate)) {
          return { blocked: true, rule: 'traversal', reason: 'path traversal pattern matched' };
        }
      }
    }
  }

  return { blocked: false, rule: null, reason: 'clean' };
}

/* ---------------------------------------------------------------- log ------ */

/**
 * Persist a blocked-event record (best-effort, via waitUntil).
 * Key: waf:{epochMs}:{requestId} with TTL cfg.waf.logTtlSec.
 */
export async function wafLog(
  env: EdgeEnv,
  ctx: EdgeCtx,
  request: Request,
  url: URL,
  verdict: WafVerdict,
): Promise<void> {
  if (!env.EDGE_CACHE) return;
  const record = {
    v: 1,
    at: new Date().toISOString(),
    rule: verdict.rule,
    reason: verdict.reason,
    method: request.method,
    path: url.pathname,
    query: url.search.slice(0, 256),
    ip: clientIpOf(request),
    ua: (request.headers.get('user-agent') || '').slice(0, 160),
    requestId: requestIdOf(request),
  };
  const ttl = Math.max(60, cfgTtlDefault);
  try {
    await env.EDGE_CACHE.put(
      `waf:${Date.now()}:${record.requestId}`,
      JSON.stringify(record),
      { expirationTtl: ttl },
    );
  } catch { /* best-effort */ }
}

const cfgTtlDefault = 86_400;

/** Read recent WAF events (admin endpoint on the gateway). */
export async function wafRecent(env: EdgeEnv, limit = 25): Promise<unknown[]> {
  if (!env.EDGE_CACHE) return [];
  try {
    const list = await env.EDGE_CACHE.list({ prefix: 'waf:', limit: Math.min(100, limit * 2) });
    const events: Array<{ key: string; record: unknown }> = [];
    for (const key of list.keys.slice(0, limit)) {
      const raw = await env.EDGE_CACHE.get(key.name);
      if (raw) {
        try { events.push({ key: key.name, record: JSON.parse(raw) }); } catch { /* skip */ }
      }
    }
    return events;
  } catch {
    return [];
  }
}
