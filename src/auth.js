import crypto from 'node:crypto';

export function signPayload(secret, timestamp, rawBody) {
  const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `sha256=${hmac}`;
}

export function verifySignature({ secret, timestamp, rawBody, signature }) {
  if (!secret) return true; // unsigned mode
  if (!timestamp || !signature) return false;
  const expected = signPayload(secret, timestamp, rawBody);
  return safeCompare(expected, signature);
}

export function bearerAuthMiddleware(token) {
  return (req, res, next) => {
    if (!token) return next(); // unprotected, warned at boot
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeCompare(match[1], token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
