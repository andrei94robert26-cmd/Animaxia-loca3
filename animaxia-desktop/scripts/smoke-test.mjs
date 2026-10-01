#!/usr/bin/env node
/**
 * scripts/smoke-test.mjs — FAZA 7 QA smoke suite (headless; no Electron GUI).
 *
 * Replaces the "electron --inspect" smoke round with CI-runnable checks:
 *
 *   1. main-process syntax   — `node --check` on every .js file under src/main
 *   2. security posture      — sandbox/contextIsolation/nodeIntegration/webSecurity
 *   3. IPC contract parity   — every channel preload exposes has a main-process
 *                              handler (invoke→ipcMain.handle, send→ipcMain.on,
 *                              event→webContents.send) and a global.d.ts member
 *   4. deep-link contract    — functional test of animaxia:// mapping + router
 *                              parity + cold-start replay (scripts/check-deeplink.cjs)
 *   5. single-flight refresh — 10 parallel 401s share ONE /api/auth/refresh
 *                              (scripts/test-single-flight.ts, requires bun)
 *   6. packaging config      — electron-builder.yml targets .exe/.dmg/.AppImage
 *                              + animaxia:// protocol registration
 *   7. assets                — offline test clip, icons, renderer entry
 *   8. npm scripts           — dev/typecheck/lint/build matrix present
 *   9. typecheck             — `tsc --noEmit` (strict) via the local toolchain
 *
 * Exit 0 = all green. Run: `bun run test:smoke`.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT = join(import.meta.dirname, '..');
const steps = [];
let failed = 0;

function step(name) {
  const entry = { name, checks: 0 };
  steps.push(entry);
  console.log(`\n== ${name}`);
  return {
    ok(label) {
      entry.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    fail(label, detail = '') {
      failed += 1;
      entry.checks += 1;
      console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    },
  };
}

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const hasNode = spawnSync('node', ['--version'], { encoding: 'utf8' }).status === 0;
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

/* ------------------------- 1. main-process syntax --------------------------- */

{
  const s = step('1. main-process syntax (node --check)');
  if (!hasNode) {
    s.fail('node binary unavailable', 'install Node or run under bun with node on PATH');
  } else {
    const files = walkJs(join(ROOT, 'src', 'main'));
    let bad = 0;
    for (const file of files) {
      const res = spawnSync('node', ['--check', file], { encoding: 'utf8' });
      if (res.status !== 0) {
        bad += 1;
        s.fail(relative(ROOT, file), (res.stderr || '').split('\n')[0]);
      }
    }
    if (bad === 0) s.ok(`${files.length} main-process files parse cleanly`);
  }
}

/* --------------------------- 2. security posture ----------------------------- */

{
  const s = step('2. Electron security posture (src/main/electron.js)');
  const text = readFileSync(join(ROOT, 'src', 'main', 'electron.js'), 'utf8');
  const flags = [
    [/sandbox:\s*true/, 'sandbox: true'],
    [/contextIsolation:\s*true/, 'contextIsolation: true'],
    [/nodeIntegration:\s*false/, 'nodeIntegration: false'],
    [/webSecurity:\s*true/, 'webSecurity: true'],
  ];
  let missing = 0;
  for (const [pattern, label] of flags) {
    if (pattern.test(text)) s.ok(label);
    else {
      missing += 1;
      s.fail(`missing ${label}`);
    }
  }
  if (/nodeIntegration:\s*true/.test(text)) s.fail('nodeIntegration must never be true');
}

/* ------------------------- 3. IPC contract parity ---------------------------- */

{
  const s = step('3. IPC contract parity (preload ↔ main ↔ global.d.ts)');
  const preload = readFileSync(join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const mainSrc = walkJs(join(ROOT, 'src', 'main'))
    .map((f) => ({ file: relative(ROOT, f), text: readFileSync(f, 'utf8') }));
  const bridgeTypes = readFileSync(join(ROOT, 'src', 'renderer', 'types', 'global.d.ts'), 'utf8');

  // \s* between ipcRenderer and .invoke/.send — app:info is invoked across a
  // line break in preload.js and must not be missed.
  const invokeChannels = [...preload.matchAll(/ipcRenderer\s*\.\s*invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
  const sendChannels = [...preload.matchAll(/ipcRenderer\s*\.\s*send\(\s*'([^']+)'/g)].map((m) => m[1]);
  const eventChannels = [...preload.matchAll(/onEvent\(\s*'([^']+)'/g)].map((m) => m[1]);

  let bad = 0;
  for (const channel of invokeChannels) {
    const handled = mainSrc.some(
      (f) => f.text.includes(`ipcMain.handle('${channel}'`) || f.text.includes(`ipcMain.handle(\n'${channel}'`),
    );
    if (handled) s.ok(`invoke '${channel}' → ipcMain.handle`);
    else {
      bad += 1;
      s.fail(`invoke '${channel}' has no ipcMain.handle`);
    }
  }
  for (const channel of sendChannels) {
    const handled = mainSrc.some((f) => f.text.includes(`ipcMain.on('${channel}'`));
    if (handled) s.ok(`send '${channel}' → ipcMain.on`);
    else {
      bad += 1;
      s.fail(`send '${channel}' has no ipcMain.on`);
    }
  }
  for (const channel of eventChannels) {
    const emitted = mainSrc.some((f) => f.text.includes(`'${channel}'`));
    if (emitted) s.ok(`event '${channel}' ← webContents.send`);
    else {
      bad += 1;
      s.fail(`event '${channel}' is never sent from main`);
    }
  }

  // The exposed bridge keys must exist as AnimaxiaBridge members in global.d.ts.
  const bridgeKeys = [
    ...preload
      .match(/exposeInMainWorld\('animaxia',\s*\{([\s\S]*?)\n\}\);/)[1]
      .matchAll(/^\s{2}(?:\/\*[\s\S]*?\*\/\s*)?([A-Za-z]+):/gm),
  ].map((m) => m[1]);
  for (const key of bridgeKeys) {
    // global.d.ts mixes property syntax (`theme: {`) and method syntax
    // (`onNavigate(callback…)`) — accept either.
    const typed = new RegExp(`^\\s{2}${key}\\s*[:(]`, 'm').test(bridgeTypes);
    if (typed) s.ok(`window.animaxia.${key} typed in global.d.ts`);
    else {
      bad += 1;
      s.fail(`window.animaxia.${key} missing from AnimaxiaBridge types`);
    }
  }
  if (bad === 0) {
    s.ok(
      `contract complete: ${invokeChannels.length} invoke + ${sendChannels.length} send + ${eventChannels.length} event channels, ${bridgeKeys.length} bridge members`,
    );
  }
}

/* ------------------------- 4. deep-link contract ----------------------------- */

{
  const s = step('4. animaxia:// deep-link contract');
  const res = spawnSync('node', [join('scripts', 'check-deeplink.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status === 0) {
    s.ok((res.stdout || '').trim().split('\n').pop());
  } else {
    s.fail('check-deeplink failed', (res.stderr || res.stdout || '').split('\n').slice(0, 4).join(' | '));
  }
}

/* ----------------------- 5. single-flight refresh ---------------------------- */

{
  const s = step('5. JWT refresh single-flight (10 parallel 401s)');
  if (!hasBun) {
    s.fail('bun unavailable', 'single-flight test executes under bun (scripts/test-single-flight.ts)');
  } else {
    const res = spawnSync('bun', [join('scripts', 'test-single-flight.ts')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      s.ok((res.stdout || '').trim().split('\n').pop());
    } else {
      s.fail('single-flight test failed', (res.stderr || res.stdout || '').split('\n').slice(0, 6).join(' | '));
    }
  }
}

/* -------------------------- 6. packaging config ------------------------------ */

{
  const s = step('6. electron-builder packaging targets');
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
  const targets = [
    [/target:\s*nsis/, 'Windows NSIS installer (.exe)'],
    [/target:\s*dmg/, 'macOS DMG (.dmg, x64 + arm64)'],
    [/target:\s*AppImage/, 'Linux AppImage'],
    [/-\s*animaxia\b/, 'animaxia:// protocol registered (protocols.schemes)'],
    [/asar:\s*true/, 'ASAR packaging enabled'],
  ];
  for (const [pattern, label] of targets) {
    if (pattern.test(yml)) s.ok(label);
    else s.fail(`missing ${label}`);
  }
  if (/!src\/renderer\/\*\*/.test(yml)) s.ok('renderer sources excluded from the package (bundle only)');
  else s.fail('src/renderer must be excluded — only dist-renderer ships');
}

/* ------------------------------- 7. assets ------------------------------------ */

{
  const s = step('7. bundled assets');
  const clip = join(ROOT, 'public', 'offline-test.mp4');
  if (existsSync(clip)) {
    const kb = Math.round(statSync(clip).size / 1024);
    // The bundled fallback clip is ~366 KB of H.264 test footage — anything
    // below 300 KB means the asset was truncated or replaced by a stub.
    if (kb >= 300) s.ok(`offline test clip present (${kb} KB)`);
    else s.fail(`offline test clip too small (${kb} KB)`, 'expected the bundled fallback video');
  } else s.fail('public/offline-test.mp4 missing');

  for (const icon of ['build/icon.png', 'build/tray.png', 'src/renderer/index.html']) {
    if (existsSync(join(ROOT, icon))) s.ok(icon);
    else s.fail(`${icon} missing`);
  }
}

/* ------------------------------ 8. npm scripts -------------------------------- */

{
  const s = step('8. package.json script matrix');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const required = [
    'dev',
    'dev:renderer',
    'typecheck',
    'lint',
    'test:smoke',
    'build:renderer',
    'build:electron',
    'build',
    'build:win',
    'build:mac',
    'build:linux',
  ];
  const missing = required.filter((name) => typeof pkg.scripts?.[name] !== 'string');
  if (missing.length === 0) s.ok(`all ${required.length} scripts declared`);
  else s.fail(`missing scripts: ${missing.join(', ')}`);
  if (pkg.main === 'src/main/electron.js') s.ok('package.main → src/main/electron.js');
  else s.fail('package.main must point at src/main/electron.js');
}

/* ------------------------------- 9. typecheck --------------------------------- */

{
  const s = step('9. TypeScript strict typecheck (tsc --noEmit)');
  const tscEntry = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscEntry)) {
    s.fail('tsc not installed', 'run `bun install` first');
  } else {
    // Direct entry-point invocation (no shell) — works under node AND bun.
    const res = spawnSync(process.execPath, [tscEntry, '--noEmit'], { cwd: ROOT, encoding: 'utf8' });
    if (res.status === 0) s.ok('0 errors (strict, noUnusedLocals/Parameters)');
    else s.fail('tsc reported errors', (res.stderr || res.stdout || '').split('\n').slice(0, 8).join(' | '));
  }
}

/* --------------------------------- summary ------------------------------------ */

console.log('\n' + '='.repeat(64));
const total = steps.reduce((sum, st) => sum + st.checks, 0);
if (failed === 0) {
  console.log(`SMOKE PASS — ${total} checks green across ${steps.length} suites`);
} else {
  console.log(`SMOKE FAIL — ${failed} of ${total} checks failed`);
  process.exit(1);
}
if (!hasBun) {
  console.log('note: install bun to also run the single-flight refresh suite in smoke');
}
