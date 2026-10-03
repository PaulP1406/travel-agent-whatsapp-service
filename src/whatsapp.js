import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { logger, errInfo } from './logger.js';
import { forwardToBrain } from './brain.js';
import { buildPayload } from './payload.js';

const { Client, LocalAuth } = pkg;

export const state = {
  client: null,
  ready: false,
  readyAt: null,
  selfId: null,
  relayed: 0,
  sent: 0,
  needsQr: false,
};

const SEEN_MAX = 5000;
const seen = new Set();

function markSeen(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > SEEN_MAX) {
    seen.delete(seen.values().next().value);
  }
  return false;
}

// Outbound (chatId, text) signatures this service is sending, so that — when
// ALLOW_SELF_MESSAGES is on for solo testing — our own outbound replies never
// get reprocessed as a new inbound message (which would otherwise loop
// forever). Marked *before* chat.sendMessage() is called, since message_create
// can fire before that call's promise resolves — matching on message id
// afterwards loses that race.
const OWN_SENT_MAX = 500;
const ownSentSignatures = new Map();

function ownSentKey(chatId, text) {
  return `${chatId}\u0000${text}`;
}

function markOwnSending(chatId, text) {
  const key = ownSentKey(chatId, text);
  ownSentSignatures.set(key, Date.now());
  if (ownSentSignatures.size > OWN_SENT_MAX) {
    ownSentSignatures.delete(ownSentSignatures.keys().next().value);
  }
}

function consumeOwnSent(chatId, text) {
  const key = ownSentKey(chatId, text);
  if (!ownSentSignatures.has(key)) return false;
  ownSentSignatures.delete(key);
  return true;
}

function truncate(text, n = 80) {
  if (!text) return text;
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// msg.getChat() resolves the chat id internally as `fromMe ? msg.to : msg.from`
// (whatsapp-web.js Message.js _getChatId). For some self-sent messages that
// `to` field doesn't come through from WhatsApp Web, making the lookup throw
// a cryptic/minified internal error. msg.id.remote is the chat id WhatsApp
// embeds directly in the message id itself and doesn't depend on to/from, so
// fall back to resolving through that instead.
async function safeGetChat(msg) {
  try {
    return await msg.getChat();
  } catch (err) {
    const remote = msg.id?.remote;
    if (!remote) throw err;
    logger.warn({ err: errInfo(err), remote }, 'msg.getChat() failed, falling back to msg.id.remote');
    const chat = await state.client.getChatById(remote);
    if (!chat) throw err;
    return chat;
  }
}

// --- outbound rate-limited queue ---

const queue = [];
let processing = false;
let lastSendAt = 0;

function enqueueSend(job) {
  return new Promise((resolve, reject) => {
    queue.push({ ...job, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const job = queue.shift();
    const wait = Math.max(0, config.sendMinGapMs - (Date.now() - lastSendAt));
    if (wait > 0) await sleep(wait);
    lastSendAt = Date.now();
    try {
      job.resolve(await doSend(job));
    } catch (err) {
      job.reject(err);
    }
  }
  processing = false;
}

async function doSend({ chatId, text, replyToMessageId, mentions }) {
  if (!state.ready) {
    const err = new Error('client not ready');
    err.statusCode = 503;
    throw err;
  }

  let chat;
  try {
    chat = await state.client.getChatById(chatId);
  } catch {
    const err = new Error('unknown chat');
    err.statusCode = 404;
    throw err;
  }
  if (!chat) {
    const err = new Error('unknown chat');
    err.statusCode = 404;
    throw err;
  }

  const options = {};
  if (mentions?.length) options.mentions = mentions;
  if (replyToMessageId) options.quotedMessageId = replyToMessageId;

  markOwnSending(chatId, text);
  const sentMsg = await chat.sendMessage(text, options);
  if (!sentMsg) {
    const err = new Error('WhatsApp did not confirm the message was sent');
    err.statusCode = 502;
    throw err;
  }
  state.sent += 1;
  return { ok: true, message_id: sentMsg.id._serialized, timestamp: sentMsg.timestamp };
}

export function sendMessage(job) {
  return enqueueSend(job);
}

export async function sendBatch(messages) {
  const results = [];
  for (const m of messages) {
    try {
      const r = await sendMessage(m);
      results.push(r);
    } catch (err) {
      results.push({ ok: false, error: err.message, statusCode: err.statusCode ?? 500 });
    }
  }
  return results;
}

// --- queries ---

function assertReady() {
  if (!state.ready) {
    const err = new Error('client not ready');
    err.statusCode = 503;
    throw err;
  }
}

export async function listGroups() {
  assertReady();
  const chats = await state.client.getChats();
  return chats
    .filter((c) => c.isGroup)
    .map((c) => ({
      id: c.id._serialized,
      name: c.name,
      participant_count: c.participants?.length ?? 0,
      unread: c.unreadCount ?? 0,
    }));
}

export async function getGroup(id) {
  assertReady();
  const chat = await state.client.getChatById(id);
  if (!chat || !chat.isGroup) {
    const err = new Error('unknown chat');
    err.statusCode = 404;
    throw err;
  }
  return {
    id: chat.id._serialized,
    name: chat.name,
    description: chat.description ?? '',
    participants: (chat.participants ?? []).map((p) => ({
      id: p.id._serialized,
      is_admin: !!p.isAdmin,
      is_agent: p.id._serialized === state.selfId,
    })),
  };
}

export async function getGroupHistory(id, limit = 50) {
  assertReady();
  const chat = await state.client.getChatById(id);
  if (!chat) {
    const err = new Error('unknown chat');
    err.statusCode = 404;
    throw err;
  }
  const capped = Math.min(Math.max(limit || 50, 1), 200);
  const msgs = await chat.fetchMessages({ limit: capped });

  const messages = [];
  for (const msg of msgs) {
    try {
      messages.push(await buildPayload(msg, chat, state.selfId, { forwardMedia: false }));
    } catch (err) {
      logger.warn({ err: errInfo(err) }, 'failed to build payload for history message');
    }
  }
  return { chat_id: id, messages };
}

// --- client lifecycle ---

const RECONNECT_DELAYS_MS = [5000, 10000, 20000, 60000];
let reconnectAttempt = 0;

function scheduleReconnect(client) {
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  logger.info({ delayMs: delay }, 'scheduling reconnect');
  setTimeout(async () => {
    try {
      await client.initialize();
    } catch (err) {
      logger.error({ err: errInfo(err) }, 'reconnect attempt failed');
      scheduleReconnect(client);
    }
  }, delay);
}

async function handleIncomingMessage(msg) {
  if (msg.fromMe) {
    const remote = msg.id?.remote;
    if (remote && consumeOwnSent(remote, msg.body)) {
      return; // our own outbound reply — never reprocess it
    }
    if (!config.allowSelfMessages) return; // default: ignore messages sent from this account
    // ALLOW_SELF_MESSAGES is on (solo testing) — fall through and treat this
    // self-sent message like any other inbound one, including @self tags.
  }

  const chat = await safeGetChat(msg);
  if (config.groupsOnly && !chat.isGroup) return;
  if (chat.isGroup && config.allowedGroupIds.length && !config.allowedGroupIds.includes(chat.id._serialized)) {
    return;
  }

  const msgId = msg.id?._serialized ?? `${msg.from}:${msg.timestamp}`;
  if (markSeen(msgId)) return; // duplicate delivery from WhatsApp

  let payload;
  try {
    payload = await buildPayload(msg, chat, state.selfId, { forwardMedia: config.forwardMedia });
  } catch (err) {
    logger.error({ err: errInfo(err), msgId }, 'failed to build payload for incoming message');
    return;
  }
  state.relayed += 1;
  logger.info(
    { chat: payload.chat.id, sender: payload.sender.id, text: truncate(payload.text), tagged: payload.tagged },
    'relaying message to brain',
  );
  logger.debug({ payload }, 'full payload');

  let typingStarted = false;
  if (config.showTyping && payload.tagged) {
    try {
      await chat.sendStateTyping();
      typingStarted = true;
    } catch (err) {
      logger.warn({ err: errInfo(err) }, 'failed to set typing indicator');
    }
  }

  const result = await forwardToBrain(payload);

  if (typingStarted) {
    try {
      await chat.clearState();
    } catch (err) {
      logger.warn({ err: errInfo(err) }, 'failed to clear typing indicator');
    }
  }

  if (result?.reply) {
    try {
      await enqueueSend({
        chatId: chat.id._serialized,
        text: result.reply,
        replyToMessageId: result.quote ? msgId : undefined,
      });
    } catch (err) {
      logger.error({ err: errInfo(err) }, 'failed to send brain reply');
    }
  }
}

export function createClient() {
  const puppeteer = {
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (config.chromePath) puppeteer.executablePath = config.chromePath;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authDataPath }),
    puppeteer,
  });

  client.on('qr', (qr) => {
    state.needsQr = true;
    logger.info('scan this QR code with WhatsApp (Linked devices → Link a device):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    state.needsQr = false;
    logger.info('authenticated');
  });

  client.on('auth_failure', (msg) => {
    logger.error({ msg }, 'auth_failure — session invalid, reset AUTH_DATA_PATH and rescan');
  });

  client.on('ready', () => {
    state.ready = true;
    state.readyAt = new Date().toISOString();
    state.selfId = client.info?.wid?._serialized ?? null;
    state.needsQr = false;
    reconnectAttempt = 0;
    logger.info({ agent_id: state.selfId }, 'WhatsApp client ready');
  });

  client.on('disconnected', (reason) => {
    state.ready = false;
    logger.warn({ reason }, 'WhatsApp client disconnected');
    scheduleReconnect(client);
  });

  // whatsapp-web.js's 'message' event is filtered internally to exclude
  // anything sent by this account, so it never fires for self-sent messages
  // (see ALLOW_SELF_MESSAGES). 'message_create' fires for all messages in
  // both directions; our own fromMe/ownSentIds/allowSelfMessages checks in
  // handleIncomingMessage are what keep replies from looping back on themselves.
  client.on('message_create', async (msg) => {
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      logger.error({ err: errInfo(err) }, 'error handling incoming message');
    }
  });

  state.client = client;
  return client;
}
