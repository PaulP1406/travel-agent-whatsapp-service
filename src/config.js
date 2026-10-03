function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === 'true';
}

function int(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function list(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  brainWebhookUrl: process.env.BRAIN_WEBHOOK_URL || 'http://localhost:8000/webhook/whatsapp',
  brainSharedSecret: process.env.BRAIN_SHARED_SECRET || '',
  brainTimeoutMs: int(process.env.BRAIN_TIMEOUT_MS, 15000),
  port: int(process.env.PORT, 3000),
  serviceToken: process.env.SERVICE_TOKEN || '',
  groupsOnly: bool(process.env.GROUPS_ONLY, true),
  allowedGroupIds: list(process.env.ALLOWED_GROUP_IDS),
  sendMinGapMs: int(process.env.SEND_MIN_GAP_MS, 1500),
  showTyping: bool(process.env.SHOW_TYPING, true),
  forwardMedia: bool(process.env.FORWARD_MEDIA, false),
  allowSelfMessages: bool(process.env.ALLOW_SELF_MESSAGES, false),
  authDataPath: process.env.AUTH_DATA_PATH || '.wwebjs_auth',
  chromePath: process.env.CHROME_PATH || '',
  headless: bool(process.env.HEADLESS, true),
  logLevel: process.env.LOG_LEVEL || 'info',
};
