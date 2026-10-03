import express from 'express';
import { config } from './config.js';
import { bearerAuthMiddleware } from './auth.js';
import { state, sendMessage, sendBatch, listGroups, getGroup, getGroupHistory } from './whatsapp.js';
import { logger, errInfo } from './logger.js';

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
    const { chat_id: chatId, text, reply_to_message_id: replyToMessageId, mentions } = req.body ?? {};
    if (!chatId || !text) {
      return res.status(400).json({ error: 'chat_id and text are required' });
    }
    try {
      const result = await sendMessage({ chatId, text, replyToMessageId, mentions });
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
    const results = await sendBatch(
      messages.map((m) => ({
        chatId: m.chat_id,
        text: m.text,
        replyToMessageId: m.reply_to_message_id,
        mentions: m.mentions,
      })),
    );
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
