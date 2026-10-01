#!/usr/bin/env node
/**
 * scripts/lint.mjs — Guard lint for animaxia-desktop (no ESLint install needed).
 *
 * Rules (they mirror the conventions every FAZA 7 file was written against):
 *   1. No `console.log(` / `console.debug(` / `debugger` anywhere in src/
 *      (main may use console.error/warn for crash reporting — those pass).
 *   2. No TODO / FIXME / XXX markers left in shipped sources.
 *   3. No `@ts-ignore` (fix the type or use a narrowing guard instead).
 *   4. Electron security posture: src/main/electron.js must hard-require
 *      sandbox: true, contextIsolation: true, nodeIntegration: false,
 *      webSecurity: true (defense in depth — smoke-test re-asserts it too).
 *
 * Exit code 0 = clean, 1 = violations found.
 * Run: `bun run lint` (or `node scripts/lint.mjs`).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist-renderer', 'release', 'build']);

/** Recursively collect source files under a directory. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(extOf(entry))) out.push(full);
  }
  return out;
}

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

const violations = [];

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const rel = relative(ROOT, file);

  lines.forEach((line, i) => {
    const at = (rule, detail) => violations.push(`${rel}:${i + 1}  [${rule}]  ${detail}`);

    if (/\bconsole\.log\s*\(/.test(line)) at('no-console-log', line.trim());
    if (/\bconsole\.debug\s*\(/.test(line)) at('no-console-debug', line.trim());
    if (/\bdebugger\b/.test(line)) at('no-debugger', line.trim());
    if (/\b(TODO|FIXME|XXX)\b/.test(line)) at('no-todo', line.trim());
    if (/@ts-ignore/.test(line)) at('no-ts-ignore', line.trim());
  });
}

/* --------------------------------- run ------------------------------------- */

const files = walk(SRC);
for (const file of files) scanFile(file);

/* Security posture — asserted on the exact main-process file that creates windows. */
const electronPath = join(SRC, 'main', 'electron.js');
if (!existsSync(electronPath)) {
  violations.push('src/main/electron.js  [missing]  main process entry not found');
} else {
  const text = readFileSync(electronPath, 'utf8');
  const requireFlag = (pattern, label) => {
    if (!pattern.test(text)) violations.push(`src/main/electron.js  [security]  missing ${label}`);
  };
  requireFlag(/sandbox:\s*true/, 'sandbox: true');
  requireFlag(/contextIsolation:\s*true/, 'contextIsolation: true');
  requireFlag(/nodeIntegration:\s*false/, 'nodeIntegration: false');
  requireFlag(/webSecurity:\s*true/, 'webSecurity: true');
}

if (violations.length > 0) {
  console.error(`lint: ${violations.length} violation(s) in ${files.length} scanned files\n`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`lint: clean — ${files.length} source files scanned, 0 violations`);
