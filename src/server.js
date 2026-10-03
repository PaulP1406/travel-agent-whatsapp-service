import express from 'express';
import { config } from './config.js';
import { bearerAuthMiddleware } from './auth.js';
import { state, sendMessage, listGroups, getGroup, getGroupHistory } from './whatsapp.js';
import { logger, errInfo } from './logger.js';

// Shared by /send and /send/batch: validates a single message spec and
// normalizes it into the job shape sendMessage()/doSend() expect. Exactly one
// of `text` or `poll` must be present. Accepts `group_id` (the orchestrator's
// existing field name, per its CONTRACTS.md) or `chat_id` (this service's
// own naming elsewhere, e.g. /groups/:id) — whichever the caller sends.
function parseSendBody(body) {
  const { group_id: groupId, chat_id: chatId, text, poll, reply_to_message_id: replyToMessageId, mentions } =
    body ?? {};
  const id = groupId ?? chatId;
  if (!id) return { error: 'group_id is required' };

  const hasText = typeof text === 'string' && text.length > 0;
  const hasPoll = poll && typeof poll === 'object';
  if (hasText === hasPoll) {
    return { error: 'exactly one of text or poll is required' };
  }
  if (hasPoll) {
    if (typeof poll.name !== 'string' || !poll.name) {
      return { error: 'poll.name is required' };
    }
    if (!Array.isArray(poll.options) || poll.options.length < 2) {
      return { error: 'poll.options must be an array of at least 2 strings' };
    }
  }

  return {
    job: {
      chatId: id,
      text: hasText ? text : undefined,
      poll: hasPoll
        ? { name: poll.name, options: poll.options, allowMultipleAnswers: !!poll.allow_multiple_answers }
        : undefined,
      replyToMessageId,
      mentions,
    },
  };
}

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: state.ready ? 'ready' : state.needsQr ? 'needs_qr' : 'starting',
      ready_at: state.readyAt,
      agent_id: state.selfId,
      relayed: state.relayed,
      sent: state.sent,
      needs_qr: state.needsQr,
    });
  });

  app.use(bearerAuthMiddleware(config.serviceToken));

  app.post('/send', async (req, res) => {
    const { job, error } = parseSendBody(req.body);
    if (error) return res.status(400).json({ error });
    try {
      const result = await sendMessage(job);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.post('/send/batch', async (req, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const results = [];
    for (const m of messages) {
      const { job, error } = parseSendBody(m);
      if (error) {
        results.push({ ok: false, error, statusCode: 400 });
        continue;
      }
      try {
        results.push(await sendMessage(job));
      } catch (err) {
        results.push({ ok: false, error: err.message, statusCode: err.statusCode ?? 500 });
      }
    }
    res.json({ results });
  });

  app.get('/groups', async (req, res) => {
    try {
      res.json({ groups: await listGroups() });
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.get('/groups/:id', async (req, res) => {
    try {
      res.json(await getGroup(req.params.id));
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.get('/groups/:id/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit ?? '50', 10);
      res.json(await getGroupHistory(req.params.id, limit));
    } catch (err) {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid JSON' });
    }
    logger.error({ err: errInfo(err) }, 'unhandled server error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
