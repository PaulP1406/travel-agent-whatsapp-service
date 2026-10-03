import { config } from './config.js';
import { logger, errInfo } from './logger.js';
import { signPayload } from './auth.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function forwardToBrain(payload) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = { 'Content-Type': 'application/json', 'X-Timestamp': String(timestamp) };
  if (config.brainSharedSecret) {
    headers['X-Signature'] = signPayload(config.brainSharedSecret, timestamp, body);
  }

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.brainTimeoutMs);
    try {
      const res = await fetch(config.brainWebhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status >= 500) {
        throw new Error(`brain responded ${res.status}`);
      }
      if (!res.ok) {
        logger.warn({ status: res.status }, 'brain rejected payload');
        return null;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      logger.warn({ attempt, err: errInfo(err) }, 'forwardToBrain attempt failed');
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  logger.error({ err: errInfo(lastErr) }, 'forwardToBrain: all attempts failed');
  return null;
}

export async function reportWhatsAppSession(data) {
  let origin;
  try {
    origin = new URL(config.brainWebhookUrl).origin;
  } catch {
    origin = 'http://localhost:8000';
  }
  try {
    await fetch(`${origin}/sessions/whatsapp`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    logger.warn({ err: errInfo(err) }, 'could not persist WhatsApp session metadata');
  }
}
