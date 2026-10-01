#!/usr/bin/env bun
/**
 * scripts/lint.mjs — guard lint for the Animaxia edge layer (FAZA 8).
 *
 *   bun run lint        (from animaxia-edge/)
 *
 * Checks:
 *   1. Source hygiene — no console.log/console.debug, no debugger, no
 *      TODO/FIXME markers, no @ts-ignore/@ts-nocheck, no 'use client'
 *      (Workers are never React) across shared/, every worker src/ and the
 *      test harness. Worker sources may not exist yet during incremental
 *      development — missing folders are reported, never failed.
 *   2. wrangler.toml sanity — every module dir that exists must declare
 *      name = "animaxia-edge-*" and main = "src/index.ts"; the gateway must
 *      bind all five sub-workers + the RATE_LIMITER Durable Object +
 *      migrations; the cron worker must carry [triggers] with ≥ 5 crons.
 *   3. package.json script matrix — typecheck/lint/test:smoke/test:e2e/
 *      deploy:all must exist.
 *   4. Test kit presence — local-harness.ts + smoke-edge.mjs + e2e-edge.mjs.
 *
 * Exits 1 with a violation list when anything fails.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const violations = [];
const notes = [];

function rel(path) {
  return relative(ROOT, path) || '.';
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------ 1. source hygiene ------ */

const SOURCE_DIRS = [
  'shared',
  'worker/src',
  'search/src',
  'ai/src',
  'auth/src',
  'player/src',
  'analytics/src',
  'cron/src',
  'tests',
];

const HYGIENE_RULES = [
  { re: /console\.(log|debug)\(/, label: 'console.log/debug' },
  { re: /\bdebugger\b/, label: 'debugger statement' },
  { re: /\b(TODO|FIXME)\b/, label: 'TODO/FIXME marker' },
  { re: /@ts-ignore/, label: '@ts-ignore' },
  { re: /@ts-nocheck/, label: '@ts-nocheck' },
  { re: /['"]use client['"]/, label: "'use client' (Workers are never React)" },
];

let scanned = 0;
for (const dir of SOURCE_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) {
    notes.push(`folder ${dir}/ does not exist yet (skipped)`);
    continue;
  }
  for (const file of walk(abs)) {
    if (!file.endsWith('.ts')) continue; // .mjs test runners report via console on purpose
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const rule of HYGIENE_RULES) {
      if (rule.re.test(text)) violations.push(`${rel(file)}: ${rule.label}`);
    }
  }
}

/* ------------------------------------------------ 2. wrangler sanity ----- */

const MODULES = ['worker', 'search', 'ai', 'auth', 'player', 'analytics', 'cron'];
let tomlChecked = 0;

for (const mod of MODULES) {
  const tomlPath = join(ROOT, mod, 'wrangler.toml');
  if (!existsSync(tomlPath)) {
    notes.push(`${mod}/wrangler.toml missing (skipped)`);
    continue;
  }
  const toml = readFileSync(tomlPath, 'utf8');
  tomlChecked += 1;

  if (!/name = "animaxia-edge-/.test(toml)) violations.push(`${mod}/wrangler.toml: name must start with "animaxia-edge-"`);
  if (!/main = "src\/index\.ts"/.test(toml)) violations.push(`${mod}/wrangler.toml: main must be "src/index.ts"`);

  if (mod === 'worker') {
    for (const binding of ['SVC_SEARCH', 'SVC_AI', 'SVC_AUTH', 'SVC_PLAYER', 'SVC_ANALYTICS']) {
      if (!new RegExp(`binding = "${binding}"`).test(toml)) {
        violations.push(`worker/wrangler.toml: missing service binding ${binding}`);
      }
    }
    if (!/durable_objects/.test(toml) || !/RATE_LIMITER/.test(toml)) {
      violations.push('worker/wrangler.toml: missing durable_objects RATE_LIMITER binding');
    }
    if (!/\[\[migrations\]\]/.test(toml)) {
      violations.push('worker/wrangler.toml: missing [[migrations]] block for the Durable Object');
    }
  }

  if (mod === 'cron') {
    if (!/\[triggers\]/.test(toml)) violations.push('cron/wrangler.toml: missing [triggers]');
    const crons = (toml.match(/"[\d*/,-]+\s[\d*/,-]+\s\*\s\*\s\*"/g) || []).length
      + (toml.match(/"0 6 \* \* 1"/g) || []).length;
    if (crons < 5) violations.push(`cron/wrangler.toml: expected ≥ 5 cron expressions, found ${crons}`);
  }
}

const kvPlaceholders = [];
for (const mod of MODULES) {
  const tomlPath = join(ROOT, mod, 'wrangler.toml');
  if (!existsSync(tomlPath)) continue;
  const toml = readFileSync(tomlPath, 'utf8');
  const count = (toml.match(/REPLACE_WITH_KV_ID/g) || []).length;
  if (count > 0) kvPlaceholders.push(`${mod}: ${count}`);
}
if (kvPlaceholders.length) {
  notes.push(`KV ids still placeholders (fine for local dev, required before deploy): ${kvPlaceholders.join(', ')}`);
}

/* ---------------------------------------------- 3. package scripts ------- */

const pkgPath = join(ROOT, 'package.json');
if (!existsSync(pkgPath)) {
  violations.push('package.json missing');
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const script of ['typecheck', 'lint', 'test:smoke', 'test:e2e', 'deploy:all', 'deploy:gateway']) {
    if (!pkg.scripts?.[script]) violations.push(`package.json: missing script "${script}"`);
  }
}

/* ---------------------------------------------- 4. test kit presence ----- */

for (const file of ['tests/local-harness.ts', 'tests/smoke-edge.mjs', 'tests/e2e-edge.mjs']) {
  if (!existsSync(join(ROOT, file))) violations.push(`${file} missing`);
}

/* ------------------------------------------------------------ summary ---- */

console.log(`animaxia-edge lint — ${scanned} TS files scanned, ${tomlChecked} wrangler.toml checked`);
for (const note of notes) console.log(`  · ${note}`);

if (violations.length) {
  console.error(`\n${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}

console.log('  ✓ no console.log/debug/debugger/TODO/@ts-ignore in sources');
console.log('  ✓ wrangler.toml contracts hold (names, mains, gateway bindings, cron triggers)');
console.log('  ✓ package.json script matrix complete');
console.log('  ✓ test kit present (harness + smoke + e2e)');
console.log('lint: PASS');
