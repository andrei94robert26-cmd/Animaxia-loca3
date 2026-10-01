/** FAZA 17-b E2E — instance B (blocked network via --host-resolver-rules):
 *  gtv-videos-bucket → 127.0.0.1:3010 (TCP hang), test-videos.co.uk +
 *  devstreaming-cdn.apple.com + test-streams.mux.dev → 127.0.0.1:9 (refused).
 *  Covers: 12s load watchdog (Sintel source 1 hangs → advance → source 2 plays),
 *  mp4 exhausted chain (BBB: hang → refused → friendly card + retry), HLS fatal
 *  chain (both m3u8 refused → friendly card). */
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/node_modules/playwright-core/index.mjs';

const BASE = 'http://localhost:81';
const shot = (name) => `/home/z/my-project/agent-ctx/faza17b-${name}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9346');
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const collectToasts = async (ms) => {
    const found = new Set();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const texts = await page.evaluate(() =>
        [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()),
      );
      texts.forEach((t) => found.add(t));
      await sleep(400);
    }
    return [...found];
  };

  const playerState = () =>
    page.evaluate(() => {
      const v = document.querySelector('video');
      const h3 = [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Nu am putut reda nicio sursă'));
      const card = h3 ? h3.closest('div[class*="rose"]') : null;
      return {
        hasVideo: Boolean(v),
        videoSrc: v ? v.currentSrc || v.src : null,
        readyState: v ? v.readyState : null,
        exhausted: Boolean(h3),
        exhaustedText: card ? card.textContent.replace(/\s+/g, ' ').slice(0, 360) : null,
        retryBtn: [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('Reîncearcă de la prima sursă'),
        ),
        externalLink: card ? (card.querySelector('a[target="_blank"]') || {}).href || null : null,
      };
    });

  const waitExhausted = (timeout = 40000) =>
    page.waitForFunction(
      () => [...document.querySelectorAll('h3')].some((h) => h.textContent.includes('Nu am putut reda nicio sursă')),
      { timeout },
    );

  let report = {};
  try {
    /* ============ 1. Sintel — 12s load watchdog ============ */
    await page.goto(`${BASE}/#/player/2`, { waitUntil: 'domcontentloaded' });
    const toasts = collectToasts(26000);
    /* Source 1 (gtv Sintel.mp4) hangs: no error, no data → watchdog at 12s. */
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && /sintel\/trailer\.mp4/.test(v.currentSrc || v.src || '');
      },
      { timeout: 45000 },
    );
    report.watchdogToasts = await toasts;
    await sleep(2500);
    report.watchdogResult = await playerState();
    await page.screenshot({ path: shot('player-watchdog-advanced') });

    /* ============ 2. Big Buck Bunny — watchdog + refused → exhausted card ============ */
    await page.goto(`${BASE}/#/player/1`, { waitUntil: 'domcontentloaded' });
    const toasts2 = collectToasts(26000);
    await waitExhausted(45000);
    report.mp4ChainToasts = await toasts2;
    await sleep(600);
    report.mp4Chain = await playerState();
    await page.screenshot({ path: shot('player-exhausted') });

    /* Retry while still blocked → chain runs again, no crash. */
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.includes('Reîncearcă de la prima sursă'),
      );
      btn?.click();
    });
    await waitExhausted(45000);
    report.mp4RetryStillBlocked = await playerState();

    /* ============ 3. HLS demo — both m3u8 refused → hls.js fatal chain ============ */
    await page.goto(`${BASE}/#/player/3`, { waitUntil: 'domcontentloaded' });
    const toasts3 = collectToasts(40000);
    await waitExhausted(60000);
    report.hlsChainToasts = await toasts3;
    await sleep(600);
    report.hlsChain = await playerState();
    await page.screenshot({ path: shot('player-hls-exhausted') });
  } finally {
    console.log(JSON.stringify({ report, consoleErrors: errors }, null, 2));
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch((e) => {
  console.error('E2E-B FAILED (see partial report):', e && e.message ? e.message : e);
  process.exitCode = 1;
});
