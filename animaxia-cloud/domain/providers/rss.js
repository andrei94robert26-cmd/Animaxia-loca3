/**
 * domain/providers/rss.js — /api/news router: parallel RSS aggregation (BBC, CNN,
 * NHK, Al Jazeera) parsed with fast-xml-parser, merged and sorted by pubDate.
 */

import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import { fetchProviderText } from '@animaxia/common/fetcher.js';
import { logger } from '@animaxia/common/logger.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SOURCES = {
  bbc: { name: 'BBC', url: process.env.BBCRSSURL || 'https://feeds.bbci.co.uk/news/rss.xml' },
  cnn: { name: 'CNN', url: process.env.CNNRSSURL || 'http://rss.cnn.com/rss/edition.rss' },
  nhk: { name: 'NHK', url: process.env.NHKRSSURL || 'https://www3.nhk.or.jp/rss/news/cat0.xml' },
  aljazeera: { name: 'Al Jazeera', url: process.env.ALJAZEERARSSURL || 'https://www.aljazeera.com/xml/rss/all.xml' },
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if ('#text' in value) return String(value['#text'] ?? '');
  }
  return '';
}

/** First '@_url' from a possibly-object/possibly-array node. */
function firstUrl(node) {
  if (!node || typeof node !== 'object') return '';
  const entries = Array.isArray(node) ? node : [node];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && entry['@_url']) return String(entry['@_url']);
  }
  return '';
}

function extractImage(item, rawDescription, encodedContent) {
  const thumb = firstUrl(item['media:thumbnail']);
  if (thumb) return thumb;
  const mediaContent = firstUrl(item['media:content']);
  if (mediaContent) return mediaContent;
  const group = item['media:group'];
  if (group && typeof group === 'object') {
    const groupContent = firstUrl(group['media:content']);
    if (groupContent) return groupContent;
  }
  const enclosure = item.enclosure;
  if (enclosure && typeof enclosure === 'object') {
    const encUrl = Array.isArray(enclosure) ? enclosure[0]?.['@_url'] : enclosure['@_url'];
    if (encUrl) return String(encUrl);
  }
  const imgMatch = `${rawDescription} ${encodedContent}`.match(/<img[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  if (imgMatch) return decodeEntities(imgMatch[1] ?? imgMatch[2] ?? '');
  return null;
}

function parseFeed(xml, sourceKey) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (!channel) {
    throw new Error(`Unexpected feed structure for ${sourceKey}`);
  }
  const rawItems = channel.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items.map((item) => {
    const rawDescription = textOf(item.description);
    const encodedContent = textOf(item['content:encoded']);
    const description = clamp(stripTags(rawDescription || encodedContent), 300);
    return {
      title: decodeEntities(textOf(item.title)) || 'Untitled',
      link: textOf(item.link),
      pubDate: textOf(item.pubDate),
      description,
      image: extractImage(item, rawDescription, encodedContent),
      source: sourceKey,
    };
  });
}

const router = express.Router();

router.get(
  '/',
  wrap(async (req, res) => {
    const sourceParam = String(req.query.source || 'all').toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    let keys;
    if (sourceParam === 'all') {
      keys = Object.keys(SOURCES);
    } else if (SOURCES[sourceParam]) {
      keys = [sourceParam];
    } else {
      return res.status(400).json({
        error: `Unknown source '${sourceParam}'. Available: ${Object.keys(SOURCES).join(', ')}, all`,
      });
    }

    const results = await Promise.allSettled(
      keys.map((key) => fetchProviderText('rss', SOURCES[key].url, { timeoutMs: 10000 })),
    );

    const items = [];
    const failed = [];
    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === 'fulfilled') {
        try {
          items.push(...parseFeed(result.value, key));
        } catch (err) {
          logger.warn(`[news] Failed to parse ${key} feed: ${err.message}`);
          failed.push(key);
        }
      } else {
        logger.warn(`[news] Failed to fetch ${key} feed: ${result.reason?.message || result.reason}`);
        failed.push(key);
      }
    });

    if (items.length === 0) {
      return res.status(502).json({ error: `Failed to fetch news feeds: ${failed.join(', ') || 'unknown error'}` });
    }

    // Deduplicate by link across all merged feeds (some feeds repeat articles)
    const seen = new Set();
    const unique = [];
    for (const item of items) {
      const dedupeKey = item.link || `${item.source}:${item.title}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      unique.push(item);
    }

    unique.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
    res.json({ data: unique.slice(0, limit) });
  }),
);

export default router;
