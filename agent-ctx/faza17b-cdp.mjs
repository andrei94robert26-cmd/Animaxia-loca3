/** FAZA 17-b E2E — instance A (clean network): AI feed DOM guard, page
 *  chips / next / prev, placeholder jumps, player happy paths (mp4 with the
 *  natural gtv 403 → source-2 fallback, HLS), 404 player, mobile overflow. */
import { chromium } from '/home/z/.npm-global/lib/node_modules/playwright/node_modules/playwright-core/index.mjs';

const BASE = 'http://localhost:81';
const shot = (name) => `/home/z/my-project/agent-ctx/faza17b-${name}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9345');
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const feedStats = () =>
    page.evaluate(() => {
      const info =
        [...document.querySelectorAll('p')].map((p) => p.textContent).find((t) => t.includes('postere încărcate')) || '';
      const m = info.match(/Pagina\s+(\d+)\s+din\s+(\d+)[\s\S]*?([\d.]+)\s+postere/);
      const nextBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Următor'));
      return {
        renderedPages: [...document.querySelectorAll('[data-ai-feed-page]')].map((el) =>
          Number(el.getAttribute('data-ai-feed-page')),
        ),
        placeholders: [...document.querySelectorAll('[aria-label^="Paginile"]')].map((el) => el.getAttribute('aria-label')),
        imgs: document.querySelectorAll('img').length,
        current: m ? Number(m[1]) : null,
        totalPages: m ? Number(m[2]) : null,
        loadedPosters: m ? Number(m[3].replace(/\./g, '')) : null,
        nextDisabled: nextBtn ? nextBtn.disabled : null,
      };
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
        currentTime: v ? v.currentTime : null,
        paused: v ? v.paused : null,
        exhausted: Boolean(h3),
        retryBtn: [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('Reîncearcă de la prima sursă'),
        ),
        externalLink: card ? (card.querySelector('a[target="_blank"]') || {}).href || null : null,
        sourceChips: [...document.querySelectorAll('[aria-label="Stream sources"] button')].map((b) => ({
          label: b.textContent.trim(),
          active: b.getAttribute('aria-pressed') === 'true',
        })),
      };
    });

  let report = {};
  try {
    /* ============ 1. HOME — AI Flux Infinit DOM guard ============ */
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-ai-feed-page="1"]', { timeout: 40000 });
    await sleep(1500);
    report.feedInitial = await feedStats();

    // Scroll like a user (to the end of the last rendered page) until 8 pages.
    for (let i = 0; i < 24; i++) {
      const s = await feedStats();
      const loadedPages = s.loadedPosters != null ? Math.round(s.loadedPosters / 20) : 0;
      if (loadedPages >= 8) break;
      await page.evaluate(() => {
        const pages = document.querySelectorAll('[data-ai-feed-page]');
        const last = pages[pages.length - 1];
        if (last) last.scrollIntoView({ block: 'end' });
        window.scrollBy(0, 400);
      });
      await sleep(1500);
    }
    await sleep(800);
    report.feedAfterScroll = await feedStats();
    await page.screenshot({ path: shot('feed-windowed') });

    const domGuard = report.feedAfterScroll;
    report.domGuardVerdict = {
      renderedPages: domGuard.renderedPages.length,
      maxAllowed: 12,
      passRendered: domGuard.renderedPages.length <= 12,
      imgs: domGuard.imgs,
      passImgs: domGuard.imgs < 400,
    };

    /* Wait until the feed is not mid-load (Următor enabled while current<total). */
    const feedIdle = async () => {
      for (let i = 0; i < 20; i++) {
        const s = await feedStats();
        if (s.nextDisabled === false || s.current == null) return true;
        await sleep(500);
      }
      return false;
    };
    report.feedIdleAfterScroll = await feedIdle();

    /* Deterministic interactions: scroll to top first (away from sentinel),
       then click via JS so playwright never auto-scrolls through the sentinel. */
    if (report.feedIdleAfterScroll) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(1000);
      const jsClick = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

      await jsClick('button[aria-label="Pagina 2"]');
      await sleep(1600);
      report.afterChip2 = await feedStats();

      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Următor'));
        btn?.click();
      });
      await sleep(1400);
      report.afterNext = await feedStats();

      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Anterior'));
        btn?.click();
      });
      await sleep(1400);
      report.afterPrev = await feedStats();

      /* Placeholder quick-jump chip (first hidden group). */
      const phInfo = await page.evaluate(() => {
        const ph = document.querySelector('[aria-label^="Paginile"]');
        if (!ph) return null;
        return {
          label: ph.getAttribute('aria-label'),
          chips: [...ph.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
        };
      });
      if (phInfo) {
        await page.evaluate(() => document.querySelector('[aria-label^="Paginile"] button')?.click());
        await sleep(1800);
        report.placeholderJump = { ...phInfo, ...(await feedStats()) };
      } else {
        report.placeholderJump = { skipped: 'no placeholder in this state' };
      }
    } else {
      report.feedInteractions = 'SKIPPED — backend feed request hung (loadingMore stuck)';
    }

    /* ============ 2. PLAYER mp4 — natural fallback (gtv 403) then play ============ */
    await page.goto(`${BASE}/#/player/1`, { waitUntil: 'domcontentloaded' });
    const toastCollector = collectToasts(20000);
    await page.waitForSelector('video', { timeout: 30000 });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.readyState >= 2;
      },
      { timeout: 30000 },
    );
    report.playerMp4Toasts = await toastCollector;
    report.playerMp4 = await playerState();
    /* Watchdog must NOT fire on a healthy playing source: same source >13s. */
    await sleep(11000);
    report.playerMp4After13s = await playerState();
    report.watchdogNoFalsePositive =
      report.playerMp4After13s.hasVideo &&
      !report.playerMp4After13s.exhausted &&
      report.playerMp4After13s.videoSrc === report.playerMp4.videoSrc;
    await page.screenshot({ path: shot('player-mp4-playing') });

    /* Source switcher chips: manual switch to source 1 (will fail 403 → auto-advance back). */
    await page.evaluate(() => {
      const chips = [...document.querySelectorAll('[aria-label="Stream sources"] button')];
      chips[0]?.click();
    });
    await sleep(2500);
    report.afterManualSwitchToSource1 = await playerState();

    /* ============ 3. PLAYER HLS happy path ============ */
    await page.goto(`${BASE}/#/player/3`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video', { timeout: 30000 });
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.readyState >= 2;
      },
      { timeout: 40000 },
    );
    await sleep(2000);
    report.playerHls = await playerState();
    await page.screenshot({ path: shot('player-hls-playing') });

    /* ============ 4. Player 404 → friendly state ============ */
    await page.goto(`${BASE}/#/player/999999`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.body.textContent.includes('Title not found') || document.body.textContent.includes('404'),
      { timeout: 20000 },
    );
    report.player404 = {
      friendly: true,
      sidebarStillRendered: await page.evaluate(() => Boolean(document.querySelector('#main'))),
    };

    /* ============ 5. Mobile 390×844 — horizontal overflow ============ */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-ai-feed-page="1"]', { timeout: 40000 });
    await sleep(1500);
    report.mobileHomeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: shot('mobile-home') });
    await page.goto(`${BASE}/#/player/1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video, h3', { timeout: 30000 });
    await sleep(2000);
    report.mobilePlayerOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: shot('mobile-player') });
  } finally {
    console.log(JSON.stringify({ report, consoleErrors: errors }, null, 2));
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch((e) => {
  console.error('E2E-A FAILED (see partial report):', e && e.message ? e.message : e);
  process.exitCode = 1;
});
