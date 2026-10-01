/**
 * modules/users/mailer.js — TS3: real SMTP transport for transactional email
 * (account verification, password reset codes).
 *
 * Transport is created LAZILY from SMTPURL (smtp://user:pass@host:port) and
 * verified on the first send; every failure degrades to `false` + logger.warn —
 * mail must never be able to break an auth flow (registration/login keep
 * working when SMTP is down). No transport, no crash: when SMTPURL is unset the
 * module reports smtpConfigured() === false and callers take their sandbox
 * fallback paths.
 *
 * Env:
 *   SMTPURL   smtp://user:pass@host:port  (required for any real sending)
 *   SMTPFROM  optional "From" header      (default: Animaxia <no-reply@animaxia.local>)
 */

import nodemailer from 'nodemailer';
import { logger } from '../../utils/logger.js';

let transport = null; // lazy singleton
let verified = false; // transport.verify() succeeded at least once

/** True when a real SMTP endpoint is configured (SMTPURL set). */
export function smtpConfigured() {
  return Boolean(process.env.SMTPURL && String(process.env.SMTPURL).trim());
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport(String(process.env.SMTPURL));
  }
  return transport;
}

/**
 * Send one transactional email. NEVER throws — resolves false on any problem
 * (missing config, verify failure, network error) after logging a warning.
 * @param {{ to: string, subject: string, text?: string, html?: string }} mail
 * @returns {Promise<boolean>} true when the message was accepted by the server.
 */
export async function sendMail({ to, subject, text, html } = {}) {
  if (!smtpConfigured()) {
    logger.warn(`[mailer] sendMail skipped (SMTPURL unset) — would have mailed: ${subject}`);
    return false;
  }
  if (!to || !subject) {
    logger.warn('[mailer] sendMail called without to/subject — skipped');
    return false;
  }
  try {
    const t = getTransport();
    if (!verified) {
      await t.verify(); // one-time handshake check (lazy init + verify)
      verified = true;
    }
    await t.sendMail({
      from: process.env.SMTPFROM || 'Animaxia <no-reply@animaxia.local>',
      to,
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    logger.warn(`[mailer] sendMail failed (to=${to}, subject=${subject}): ${err?.message || err}`);
    return false;
  }
}

export default { sendMail, smtpConfigured };
