#!/usr/bin/env node
/**
 * scripts/verify-syntax.mjs — CI/dev syntax gate for Animaxia Cloud.
 *
 *   node scripts/verify-syntax.mjs          (or: bun run verify)
 *
 * What it checks:
 *   1. Every .js / .mjs file under common/, domain/ and services/*-service/
 *      (skipping node_modules) parses cleanly via `bun build --no-bundle`.
 *   2. Every services/*-service folder has package.json + server.js +
 *      Dockerfile — missing folders are reported as WARN (Phase-3 mid-build
 *      friendliness, mirroring scripts/dev-up.sh) but do not fail the run;
 *      missing files INSIDE an existing folder are a FAIL.
 *
 * Exit code: 0 = all files parse (warnings allowed) · 1 = any syntax failure.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'dist']);

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const failures = [];
const warnings = [];
let checked = 0;

/* ------------------------------- JS syntax -------------------------------- */

const jsRoots = [path.join(ROOT, 'common'), path.join(ROOT, 'domain')];
const servicesDir = path.join(ROOT, 'services');
if (fs.existsSync(servicesDir)) {
  for (const entry of fs.readdirSync(servicesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('-service')) {
      jsRoots.push(path.join(servicesDir, entry.name));
    }
  }
}

for (const root of jsRoots) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    checked += 1;
    const res = spawnSync('bun', ['build', '--no-bundle', file], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30000,
    });
    if (res.status !== 0) {
      failures.push({ file: path.relative(ROOT, file), error: (res.stderr || res.stdout || 'unknown error').split('\n').slice(0, 6).join('\n') });
    }
  }
}

/* --------------------------- service completeness -------------------------- */

const EXPECTED_SERVICES = [
  'gateway-service',
  'auth-service',
  'content-service',
  'ai-service',
  'analytics-service',
  'search-service',
  'premium-service',
  'social-service',
  'mobile-service',
  'queue-service',
];

for (const name of EXPECTED_SERVICES) {
  const dir = path.join(servicesDir, name);
  if (!fs.existsSync(dir)) {
    warnings.push(`service folder missing: services/${name} (skipped — mid-build)`);
    continue;
  }
  for (const required of ['package.json', 'server.js', 'Dockerfile']) {
    if (!fs.existsSync(path.join(dir, required))) {
      failures.push({ file: `services/${name}/${required}`, error: 'required file missing' });
    }
  }
}

/* --------------------------------- report ---------------------------------- */

for (const warn of warnings) console.log(`WARN  ${warn}`);
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s) after checking ${checked} files:`);
  for (const failure of failures) {
    console.error(`\n  ✗ ${failure.file}\n${failure.error.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }
  process.exit(1);
} else {
  console.log(`PASS — ${checked} files parse cleanly (${warnings.length} warning(s))`);
  process.exit(0);
}
