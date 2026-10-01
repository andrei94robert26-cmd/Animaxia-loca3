/**
 * domain/player/player.js — Player resolution: policy-filtered direct sources,
 * automatic YouTube trailer search fallback when no direct sources exist.
 */

import { fetchProviderJson } from '@animaxia/common/fetcher.js';
import { logger } from '@animaxia/common/logger.js';

function policyAllows() {
  return {
    mp4: process.env.PLAYERALLOWMP4 !== 'false',
    m3u8: process.env.PLAYERALLOWM3U8 !== 'false',
    iframe: process.env.PLAYERALLOWIFRAME !== 'false',
    youtube: process.env.PLAYERALLOWYOUTUBE !== 'false',
  };
}

export function playerAllowedTypes() {
  const policy = policyAllows();
  return Object.entries(policy)
    .filter(([, enabled]) => enabled)
    .map(([type]) => type);
}

function inferType(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.mp4')) return 'mp4';
  if (u.includes('.m3u8')) return 'm3u8';
  if (/youtube\.com|youtu\.be|youtube-nocookie\.com/.test(u)) return 'youtube';
  return 'iframe';
}

function normalizeSources(rawSources) {
  if (!Array.isArray(rawSources)) return [];
  return rawSources
    .filter((s) => s && typeof s === 'object' && (s.url || s.src))
    .map((s) => ({
      type: s.type || inferType(s.url || s.src),
      url: s.url || s.src,
      label: s.label || s.type || 'Source',
    }));
}

async function searchYouTubeTrailer(title) {
  const key = process.env.YOUTUBEAPIKEY;
  const base = process.env.YOUTUBEBASEURL || 'https://www.googleapis.com/youtube/v3';
  if (!key || !title) return null;
  try {
    const data = await fetchProviderJson('youtube', `${base}/search`, {
      params: {
        part: 'snippet',
        q: `${title} official trailer`,
        type: 'video',
        maxResults: 1,
        videoEmbeddable: 'true',
        key,
      },
      timeoutMs: 10000,
      retries: 1,
    });
    const videoId = data?.items?.[0]?.id?.videoId;
    if (!videoId) return null;
    return {
      type: 'youtube',
      url: `https://www.youtube.com/embed/${videoId}`,
      label: 'Official trailer · YouTube',
    };
  } catch (err) {
    logger.warn(`[player] YouTube trailer search failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolve playable sources for a content row.
 * @param {object} content - DB content row (with metadata.player.sources).
 * @returns {Promise<{ content: object, mode: string, allowedTypes: string[], sources: object[], primary?: object, note?: string }>}
 */
export async function resolvePlayer(content) {
  const policy = policyAllows();
  const allowedTypes = playerAllowedTypes();

  const rawSources = content?.metadata?.player?.sources || content?.metadata?.sources || [];
  const normalized = normalizeSources(rawSources);
  const hasAnyRaw = normalized.length > 0;
  const sources = normalized.filter((s) => policy[s.type]);

  if (hasAnyRaw && sources.length === 0) {
    return {
      content,
      mode: 'none',
      allowedTypes,
      sources: [],
      note: 'All sources are disabled by player policy',
    };
  }

  if (sources.length > 0) {
    const primary =
      sources.find((s) => s.type === 'mp4') ||
      sources.find((s) => s.type === 'm3u8') ||
      sources.find((s) => s.type === 'youtube') ||
      sources.find((s) => s.type === 'iframe') ||
      null;
    return { content, mode: 'direct', allowedTypes, sources, primary };
  }

  // No direct sources — try to find an official trailer on YouTube.
  if (process.env.YOUTUBEAPIKEY && policy.youtube) {
    const trailer = await searchYouTubeTrailer(content?.title);
    if (trailer) {
      return {
        content,
        mode: 'trailer',
        allowedTypes,
        sources: [trailer],
        primary: trailer,
      };
    }
  }

  return {
    content,
    mode: 'none',
    allowedTypes,
    sources: [],
    note: 'No stream sources available for this title yet. Use the Miner to attach one.',
  };
}
