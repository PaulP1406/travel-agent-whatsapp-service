import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { logger, errInfo } from './logger.js';
import { forwardToBrain, reportWhatsAppSession } from './brain.js';
import { buildPayload, buildPollVotePayload, listChatMembers, stripOutboundTags } from './payload.js';

const { Client, LocalAuth, Poll, MessageMedia } = pkg;

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

const TYPING_PULSE_MS = 8000;
const TYPING_MAX_MS = 120000;
const typingByChat = new Map();

async function pulseTyping(chatId) {
  if (!state.ready || !state.client) return;
  try {
    const chat = await state.client.getChatById(chatId);
    await chat.sendStateTyping();
  } catch (err) {
    logger.warn({ err: errInfo(err), chatId }, 'failed to set typing indicator');
  }
}

function startTyping(chatId, maxMs = TYPING_MAX_MS) {
  if (!config.showTyping || !chatId) return;
  stopTypingTimer(chatId);
  pulseTyping(chatId);
  const interval = setInterval(() => pulseTyping(chatId), TYPING_PULSE_MS);
  const timeout = setTimeout(() => stopTyping(chatId), maxMs);
  typingByChat.set(chatId, { interval, timeout });
}

function stopTypingTimer(chatId) {
  const t = typingByChat.get(chatId);
  if (!t) return;
  clearInterval(t.interval);
  clearTimeout(t.timeout);
  typingByChat.delete(chatId);
}

async function stopTyping(chatId) {
  stopTypingTimer(chatId);
  if (!state.ready || !state.client || !chatId) return;
  try {
    const chat = await state.client.getChatById(chatId);
    await chat.clearState();
  } catch (err) {
    logger.warn({ err: errInfo(err), chatId }, 'failed to clear typing indicator');
  }
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

async function doSend({ chatId, text, poll, replyToMessageId, mentions, media }) {
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

  if (typeof text === 'string' && text && !poll) {
    try {
      const members = await listChatMembers(chat, state.selfId);
      text = stripOutboundTags(text, members);
    } catch {
      text = stripOutboundTags(text, []);
    }
  }

  let content;
  if (poll) {
    content = new Poll(poll.name, poll.options, { allowMultipleAnswers: !!poll.allowMultipleAnswers });
    markOwnSending(chatId, poll.name);
  } else if (media?.url || media?.data_base64) {
    if (media.url) {
      content = await MessageMedia.fromUrl(media.url, { unsafeMime: true });
    } else {
      content = new MessageMedia(
        media.mimetype || 'image/jpeg',
        media.data_base64,
        media.filename || 'photo.jpg',
      );
    }
    if (text) options.caption = text;
    markOwnSending(chatId, text || media.filename || 'photo');
  } else {
    content = text;
    markOwnSending(chatId, text);
  }

  const sentMsg = await chat.sendMessage(content, options);
  await stopTyping(chatId);
  if (!sentMsg) {
    const err = new Error('WhatsApp did not confirm the message was sent');
    err.statusCode = 502;
    throw err;
  }
  if (poll) {
    await openChatForPollVotes(chatId);
    const pollId = sentMsg.id?._serialized || sentMsg.id?.$1;
    if (pollId) watchPollVotes(pollId);
  }
  state.sent += 1;
  return { ok: true, message_id: sentMsg.id._serialized, timestamp: sentMsg.timestamp };
}

export function sendMessage(job) {
  return enqueueSend(job);
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
  const members = await listChatMembers(chat, state.selfId);
  return {
    id: chat.id._serialized,
    name: chat.name,
    description: chat.description ?? '',
    participants: members,
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
  if (msg.type === 'poll_creation') return;

  let payload;
  try {
    payload = await buildPayload(msg, chat, state.selfId, { forwardMedia: config.forwardMedia });
  } catch (err) {
    logger.error({ err: errInfo(err), msgId }, 'failed to build payload for incoming message');
    return;
  }
  state.relayed += 1;
  logger.info(
    { group: payload.group_id, sender: payload.sender_id, text: truncate(payload.text), tagged: payload.tagged },
    'relaying message to brain',
  );
  logger.debug({ payload }, 'full payload');

  const chatId = chat.id._serialized;
  if (config.showTyping && payload.tagged) {
    startTyping(chatId);
  }

  const result = await forwardToBrain(payload);
  await sendBrainReply(chatId, msgId, result);
}

// The brain's webhook response can carry either `reply` (plain text) or
// `poll` (a new WhatsApp poll) — never both. Shared by the message and
// poll-vote handlers so either inbound event can trigger either kind of reply.
async function sendBrainReply(chatId, quoteMessageId, result) {
  if (!result?.reply && !result?.poll) return;
  try {
    await enqueueSend({
      chatId,
      text: result.poll ? undefined : result.reply,
      poll: result.poll,
      replyToMessageId: result.quote ? quoteMessageId : undefined,
    });
  } catch (err) {
    logger.error({ err: errInfo(err) }, 'failed to send brain reply');
  }
}

async function handlePollVote(vote) {
  const chat = await chatForVote(vote);
  if (!chat) return;
  if (config.groupsOnly && !chat.isGroup) return;
  if (chat.isGroup && config.allowedGroupIds.length && !config.allowedGroupIds.includes(chat.id._serialized)) {
    return;
  }

  const payload = await buildPollVotePayload(vote, chat, state.selfId);
  const dedupe = `pollvote:${payload.poll_message_id}:${payload.voter_id}:${payload.selected_options.join('|')}`;
  if (markSeen(dedupe)) return;

  state.relayed += 1;
  logger.info(
    { group: payload.group_id, voter: payload.voter_id, poll: payload.poll_name, selected: payload.selected_options },
    'relaying poll vote to brain',
  );
  logger.debug({ payload }, 'full poll vote payload');

  if (config.showTyping) startTyping(chat.id._serialized);
  const result = await forwardToBrain(payload);

  await sendBrainReply(chat.id._serialized, payload.poll_message_id, result);
}

async function chatForVote(vote) {
  if (vote?.parentMessage) {
    try {
      return await safeGetChat(vote.parentMessage);
    } catch (err) {
      logger.warn({ err: errInfo(err) }, 'poll parent getChat failed');
    }
  }
  const remote =
    vote?.parentMsgKey?.remote ||
    vote?.parentMessage?.id?.remote ||
    vote?.parentMsgKey?._serialized ||
    vote?.parentMsgKey?.$1;
  if (!remote || !state.client) return null;
  const id = typeof remote === 'string' ? remote : remote._serialized || remote.$1;
  try {
    return await state.client.getChatById(id);
  } catch (err) {
    logger.warn({ err: errInfo(err), id }, 'could not resolve chat for poll vote');
    return null;
  }
}

async function openChatForPollVotes(chatId) {
  if (!state.client?.interface || !chatId) return;
  try {
    await state.client.interface.openChatWindow(chatId);
    logger.info({ chatId }, 'opened chat to receive poll votes');
  } catch (err) {
    logger.warn({ err: errInfo(err), chatId }, 'could not open chat for poll votes');
  }
}

const POLL_WATCH_MS = 30 * 60 * 1000;
const POLL_WATCH_EVERY_MS = 2500;
const watchedPolls = new Map();

function watchPollVotes(messageId) {
  if (!messageId || watchedPolls.has(messageId)) return;
  const started = Date.now();
  const tick = async () => {
    if (!state.ready || Date.now() - started > POLL_WATCH_MS) {
      clearInterval(interval);
      watchedPolls.delete(messageId);
      return;
    }
    try {
      const votes = await state.client.getPollVotes(messageId);
      for (const vote of votes || []) {
        try {
          await handlePollVote(vote);
        } catch (err) {
          logger.error({ err: errInfo(err) }, 'error handling watched poll vote');
        }
      }
    } catch (err) {
      logger.debug({ err: errInfo(err), messageId }, 'poll vote check failed');
    }
  };
  const interval = setInterval(tick, POLL_WATCH_EVERY_MS);
  watchedPolls.set(messageId, interval);
  setTimeout(tick, 1200);
}

async function watchAllowedGroups() {
  const ids = config.allowedGroupIds;
  if (!ids.length) return;
  for (const id of ids) {
    await openChatForPollVotes(id);
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
    watchAllowedGroups().catch(() => {});
    reportWhatsAppSession({
      agent_id: state.selfId,
      status: 'ready',
      ready_at: state.readyAt,
      auth_path: config.authDataPath,
    }).catch(() => {});
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

  client.on('vote_update', async (vote) => {
    try {
      await handlePollVote(vote);
    } catch (err) {
      logger.error({ err: errInfo(err) }, 'error handling poll vote');
    }
  });

  state.client = client;
  return client;
}
