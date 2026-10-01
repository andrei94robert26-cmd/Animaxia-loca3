/**
 * modules/ainew/voice.js — FAZA 35 (WS5): AI Voice — ASR (căutare/comenzi
 * vocale) + TTS (descriere audio). Contract onest: NICIODATĂ text fabricat —
 * dacă z-ai eșuează, răspunsul e 503 cu mesaj onest.
 *
 * Limită de platformă documentată: express.json are limită globală de 2MB,
 * deci un body mai mare e respins 413 de platformă ÎNAINTE de rută; validarea
 * noastră (≤ 12MB decodat) acoperă contractul pentru orice payload care
 * ajunge la rută.
 */

import { zaiAsr, zaiTts, nowIso } from './common.js';

export const VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'];
export const TTS_MAX_CHARS = 1024;
export const TTS_MIN_SPEED = 0.5;
export const TTS_MAX_SPEED = 2.0;
export const ASR_MAX_DECODED_BYTES = 12 * 1024 * 1024; // 12MB (contract)

/* --------------------------------- status ----------------------------------- */

export function voiceStatus() {
  return {
    ok: true,
    asr: { ready: true, maxDecodedBytes: ASR_MAX_DECODED_BYTES, formats: ['base64 audio'] },
    tts: { voices: [...VOICES], maxChars: TTS_MAX_CHARS, speed: [TTS_MIN_SPEED, TTS_MAX_SPEED], format: 'wav' },
    provider: 'z-ai',
    generatedAt: nowIso(),
  };
}

/* ----------------------------------- ASR ------------------------------------- */

/** voiceAsr({ audioBase64, user }) — validează, apelează z-ai, 503 onest la eșec. */
export async function voiceAsr({ audioBase64, user = null }) {
  if (typeof audioBase64 !== 'string' || audioBase64.trim().length === 0) {
    return { status: 400, error: 'audioBase64 (string) este obligatoriu' };
  }
  const cleaned = audioBase64.replace(/^data:audio\/[a-z0-9]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    return { status: 400, error: 'audioBase64 nu este un payload base64 valid' };
  }
  let decodedBytes;
  try {
    decodedBytes = Buffer.from(cleaned, 'base64').length;
  } catch {
    return { status: 400, error: 'audioBase64 nu poate fi decodat' };
  }
  if (decodedBytes === 0) return { status: 400, error: 'audioBase64 decodează la un payload gol' };
  if (decodedBytes > ASR_MAX_DECODED_BYTES) {
    return { status: 400, error: `audio-ul depășește ${ASR_MAX_DECODED_BYTES / (1024 * 1024)}MB decodați (ai trimis ${decodedBytes} bytes)` };
  }

  const text = await zaiAsr(cleaned);
  if (text === null || (typeof text === 'string' && text.length === 0)) {
    /* Fără fallback — onest: niciodată transcript fals. */
    return { status: 503, error: 'Serviciul vocal este momentan indisponibil' };
  }
  return {
    ok: true,
    text: String(text).slice(0, 2000),
    bytes: decodedBytes,
    provider: 'z-ai',
    ...(user ? { user: user.id } : {}),
    generatedAt: nowIso(),
  };
}

/* ----------------------------------- TTS ------------------------------------- */

/** voiceTts({ text, voice, speed, user }) — validare strictă, 503 onest la eșec. */
export async function voiceTts({ text, voice = 'tongtong', speed = 1.0, user = null }) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { status: 400, error: 'text (string nevid) este obligatoriu' };
  }
  if (text.length > TTS_MAX_CHARS) {
    return { status: 400, error: `text depășește limita de ${TTS_MAX_CHARS} caractere (ai trimis ${text.length}) — scurtează descrierea` };
  }
  const safeVoice = String(voice || 'tongtong');
  if (!VOICES.includes(safeVoice)) {
    return { status: 400, error: `voice trebuie unul dintre: ${VOICES.join(', ')}` };
  }
  const safeSpeed = Number(speed);
  if (!Number.isFinite(safeSpeed) || safeSpeed < TTS_MIN_SPEED || safeSpeed > TTS_MAX_SPEED) {
    return { status: 400, error: `speed trebuie un număr între ${TTS_MIN_SPEED} și ${TTS_MAX_SPEED}` };
  }

  const buffer = await zaiTts(text.trim(), { voice: safeVoice, speed: safeSpeed });
  if (!buffer) {
    return { status: 503, error: 'Serviciul vocal este momentan indisponibil' };
  }
  return {
    ok: true,
    audioBase64: buffer.toString('base64'),
    format: 'wav',
    bytes: buffer.length,
    voice: safeVoice,
    speed: safeSpeed,
    provider: 'z-ai',
    ...(user ? { user: user.id } : {}),
    generatedAt: nowIso(),
  };
}
