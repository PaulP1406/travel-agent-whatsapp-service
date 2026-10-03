import express from 'express';
import crypto from 'node:crypto';

const PORT = process.env.FAKE_BRAIN_PORT || 8000;
const SECRET = process.env.BRAIN_SHARED_SECRET || '';

const app = express();
app.use(express.text({ type: '*/*' }));

// Stands in for what the real brain will eventually persist in its own DB,
// keyed by chat.id — the session the brain creates lazily the first time it
// sees `tagged: true` for a given group, per the chat_id-as-session-key plan.
// Purely a local demo scaffold for the planning → confirm → booking loop;
// none of this logic belongs in the actual service.
const sessions = new Map();

const RESET_WORDS = ['start over', 'new trip', 'restart'];
const CONFIRM_WORDS = ['yes', 'confirm', 'sounds good', 'looks good', 'perfect', 'great', 'love it', '👍'];
const BOOK_WORDS = ['book', 'go ahead', 'do it', "let's book", 'lock it in'];
const CHANGE_WORDS = ['change', 'no', 'redo', 'different', 'swap', 'tweak', 'adjust'];

function matchesAny(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function reply(chatId, text, senderName) {
  let session = sessions.get(chatId);
  if (!session || matchesAny(text, RESET_WORDS)) {
    session = { stage: 'start' };
    sessions.set(chatId, session);
  }

  switch (session.stage) {
    case 'start':
      session.stage = 'drafting';
      return pick([
        `Hey ${senderName}! I'm in 🙌 Where are we thinking, roughly when, and how many people?`,
        `Ooh, a trip! Give me a destination, rough dates, and a headcount and I'll start putting something together.`,
      ]);

    case 'drafting':
      session.stage = 'drafted';
      return "Okay, here's a rough first draft:\n• Day 1 — arrive, settle in, easy dinner nearby\n• Day 2 — the big must-see thing + a local food crawl\n• Day 3 — something more chill, maybe a day trip\n\nDoes this feel right, or want me to switch things up?";

    case 'drafted':
      if (matchesAny(text, CHANGE_WORDS)) {
        return "Got it, tweaking it now — give me a sec and I'll have an updated version.";
      }
      session.stage = 'confirmed';
      return pick([
        'Love it, locking that in ✅ Want me to go ahead and hold the bookings, or are you all still deciding?',
        "Great, I'll treat that as the plan. Say the word whenever you want me to actually book it.",
      ]);

    case 'confirmed':
      if (matchesAny(text, BOOK_WORDS) || matchesAny(text, CONFIRM_WORDS)) {
        session.stage = 'booked';
        return "Booked! 🎉 You're all set — I'll post details here as they come through.";
      }
      return 'No rush — just tag me whenever you want me to go ahead and book it.';

    case 'booked':
    default:
      return 'This trip is already booked! Want to plan another one? Just say "new trip" and I\'ll start fresh.';
  }
}

app.post('/webhook/whatsapp', (req, res) => {
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];
  const rawBody = req.body ?? '';

  if (SECRET) {
    const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex')}`;
    if (!timestamp || !signature || signature !== expected) {
      return res.status(401).json({ error: 'bad signature' });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    payload = {};
  }

  console.log('--- incoming message ---');
  console.log(JSON.stringify(payload, null, 2));

  if (payload.tagged) {
    const text = reply(payload.chat?.id, payload.text ?? '', payload.sender?.name ?? 'there');
    return res.json({ reply: text, quote: true });
  }
  return res.json({});
});

app.listen(PORT, () => {
  console.log(`fake-brain listening on ${PORT} (signature check ${SECRET ? 'ON' : 'OFF'})`);
});
