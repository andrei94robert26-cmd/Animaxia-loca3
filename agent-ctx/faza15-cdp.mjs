/** FAZA 15 E2E verification over CDP with a clean Chrome (real desktop pointer). */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:81';
const shot = (name) => `/home/z/my-project/agent-ctx/faza15-${name}.png`;

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const report = {};

  await page.goto(`${BASE}/#/home`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  report.mediaQueries = await page.evaluate(() => ({
    pointerFine: matchMedia('(pointer: fine)').matches,
    hover: matchMedia('(hover: hover)').matches,
  }));

  /* 1. AI cursor aura over a poster */
  const poster = page.locator('[data-ai-feed-page="1"] [data-ai-poster]').first();
  await poster.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await poster.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(900);
    report.aiCursor = await page.evaluate(() => {
      const aura = [...document.querySelectorAll('div')].find(
        (d) => typeof d.className === 'string' && d.className.includes('z-[90]') && d.hasAttribute('aria-hidden'),
      );
      const label = aura ? aura.querySelector('span') : null;
      return {
        auraVisible: Boolean(aura) && aura.getBoundingClientRect().width > 0,
        opacity: aura ? aura.style.opacity : null,
        transform: aura ? aura.style.transform : null,
        labelText: label ? label.textContent : null,
        labelOpacity: label ? label.style.opacity : null,
      };
    });
    await page.screenshot({ path: shot('ai-cursor') });
  }

  /* 2. Hover trailer */
  await page.waitForTimeout(2600);
  report.hoverTrailer = await page.evaluate(() => {
    const page1 = document.querySelector('[data-ai-feed-page="1"]');
    const iframe = page1 ? page1.querySelector('iframe') : null;
    const card = page1 ? page1.querySelector('[data-ai-poster]') : null;
    return {
      iframeSrc: iframe ? iframe.src : null,
      trailerAttr: card ? card.getAttribute('data-ai-trailer') : null,
      badge: [...(page1 ? page1.querySelectorAll('span') : [])].some((s) => s.textContent === 'AI · Trailer'),
    };
  });
  if (report.hoverTrailer && report.hoverTrailer.iframeSrc) {
    await page.screenshot({ path: shot('hover-trailer') });
  }

  /* 3. Click-through still navigates */
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1500);
    report.clickThrough = { hash: await page.evaluate(() => location.hash) };
    await page.goBack();
    await page.waitForTimeout(2200);
  }

  /* 4. Sidebar AI Metadata collapsibles */
  report.sidebarMeta = await page.evaluate(() => {
    const groupLabel = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === 'AI Metadata');
    if (!groupLabel) return { group: false };
    const triggers = [...groupLabel.parentElement.querySelectorAll('button')];
    const genres = triggers.find((b) => (b.textContent || '').includes('Genuri'));
    if (!genres) return { group: true, genresTrigger: false };
    genres.click();
    return { group: true, genresTrigger: true, badge: (genres.textContent.match(/\d+/) || [null])[0] };
  });
  await page.waitForTimeout(900);
  report.genreValues = await page.evaluate(() => {
    const groupLabel = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === 'AI Metadata');
    const rows = [...(groupLabel ? groupLabel.parentElement.querySelectorAll('button') : [])].filter((b) =>
      (b.textContent || '').includes('Drama'),
    );
    return rows.slice(0, 6).map((r) => r.textContent.trim());
  });
  await page.screenshot({ path: shot('sidebar-metadata') });

  /* 5. Click a genre value -> meta view */
  await page.evaluate(() => {
    const groupLabel = [...document.querySelectorAll('p')].find((p) => (p.textContent || '').trim() === 'AI Metadata');
    const rows = [...(groupLabel ? groupLabel.parentElement.querySelectorAll('button') : [])].filter((b) =>
      (b.textContent || '').includes('Drama'),
    );
    if (rows[0]) rows[0].click();
  });
  await page.waitForTimeout(3500);
  report.metaView = await page.evaluate(() => {
    const header = document.querySelector('h1') ? document.querySelector('h1').textContent : null;
    return {
      header,
      cards: document.querySelectorAll('[data-ai-poster]').length,
      chips: document.querySelectorAll('[aria-label^="Alte valori"] button').length,
      paginationButtons: [...document.querySelectorAll('nav[aria-label="Pagination"] button')].length,
      hash: location.hash,
    };
  });
  await page.screenshot({ path: shot('meta-view') });

  /* 6. Home panels */
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2500);
  report.panels = await page.evaluate(() => {
    const h2s = [...document.querySelectorAll('h2')].map((h) => (h.textContent || '').trim());
    return {
      externalAnalysis: h2s.some((t) => t && t.includes('AI Analiză Externă')),
      taxonomyAuto: h2s.some((t) => t && t.includes('generate automat de AI din posterele externe')),
      metadataPanel: h2s.some((t) => t && t.includes('AI Extractor Metadata')),
      narration: [...document.querySelectorAll('p')].some((p) => (p.textContent || '').includes('AI-ul a clasificat')),
    };
  });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('h2')].find((h) => (h.textContent || '').includes('AI Analiză Externă'));
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot('panels') });

  /* 7. Infinite scroll */
  report.infiniteScroll = await page.evaluate(async () => {
    const before = document.querySelectorAll('[data-ai-feed-page]').length;
    const holder = document.querySelector('[data-ai-feed-page="1"]');
    if (holder) holder.scrollIntoView({ block: 'start' });
    await new Promise((r) => setTimeout(r, 3500));
    const pages = [...document.querySelectorAll('[data-ai-feed-page]')].map((p) => p.getAttribute('data-ai-feed-page'));
    const info = [...document.querySelectorAll('p')].find((p) => /Pagina.*din.*postere afișate/.test(p.textContent || ''));
    return { before, pages, info: info ? info.textContent.trim() : null };
  });

  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
  await page.close();
  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
