import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});

// Normalizes thrown values (Errors, strings, Puppeteer page errors, ...) into
// a loggable shape — a bare `err.message` on a non-Error can collapse to a
// single minified character and hide the real cause.
export function errInfo(err) {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}
