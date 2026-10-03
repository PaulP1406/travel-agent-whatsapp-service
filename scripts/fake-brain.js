import express from 'express';
import crypto from 'node:crypto';

const PORT = process.env.FAKE_BRAIN_PORT || 8000;
const SECRET = process.env.BRAIN_SHARED_SECRET || '';

const app = express();
app.use(express.text({ type: '*/*' }));

// Stands in for what the real brain will eventually persist in its own DB,
// keyed by chat.id — the session the brain creates lazily the first time it
// sees `tagged: true` for a given group, per the chat_id-as-session-key plan.
// Purely a local demo scaffold for the planning → poll → confirm → booking
// loop; none of this logic belongs in the actual service.
const sessions = new Map();

const RESET_WORDS = ['start over', 'new trip', 'restart'];
const CONFIRM_WORDS = ['yes', 'confirm', 'sounds good', 'looks good', 'perfect', 'great', 'love it', '👍'];
const BOOK_WORDS = ['book', 'go ahead', 'do it', "let's book", 'lock it in'];

function matchesAny(text, words) {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function getSession(chatId, resetIfText) {
  let session = sessions.get(chatId);
  if (!session || (resetIfText && matchesAny(resetIfText, RESET_WORDS))) {
    session = { stage: 'start' };
    sessions.set(chatId, session);
  }
  return session;
}

function handleMessage(payload) {
  if (!payload.tagged) return {};

  const chatId = payload.chat?.id;
  const text = payload.text ?? '';
  const senderName = payload.sender?.name ?? 'there';
  const session = getSession(chatId, text);

  switch (session.stage) {
    case 'start':
      session.stage = 'drafting';
      return {
        reply: pick([
          `Hey ${senderName}! I'm in 🙌 Where are we thinking, roughly when, and how many people?`,
          "Ooh, a trip! Give me a destination, rough dates, and a headcount and I'll start putting something together.",
        ]),
        quote: true,
      };

    case 'drafting':
      session.stage = 'voting';
      return {
        poll: {
          name: 'Which vibe should this trip be?',
          options: ['Chill beach town', 'Packed city adventure', 'Mix of both'],
          allow_multiple_answers: false,
        },
      };

    case 'voting':
      return { reply: 'Still waiting on votes — tap an option on the poll above! 👆', quote: true };

    case 'confirmed':
      if (matchesAny(text, BOOK_WORDS) || matchesAny(text, CONFIRM_WORDS)) {
        session.stage = 'booked';
        return { reply: "Booked! 🎉 You're all set — I'll post details here as they come through.", quote: true };
      }
      return { reply: 'No rush — just tag me whenever you want me to go ahead and book it.', quote: true };

    case 'booked':
    default:
      return {
        reply: 'This trip is already booked! Want to plan another one? Just say "new trip" and I\'ll start fresh.',
        quote: true,
      };
  }
}

function handlePollVote(payload) {
  const chatId = payload.chat?.id;
  const session = sessions.get(chatId);
  if (!session || session.stage !== 'voting') return {}; // not a poll we're tracking right now

  const choice = payload.selected_options?.[0];
  if (!choice) return {}; // they deselected everything — stay quiet

  session.stage = 'confirmed';
  session.chosenVibe = choice;
  return {
    reply: `${payload.voter?.name ?? 'Someone'} picked "${choice}" 🎉 Locking that in as the direction — want me to go ahead and hold the bookings?`,
    quote: false,
  };
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

  console.log(`--- incoming ${payload.event ?? 'unknown'} event ---`);
  console.log(JSON.stringify(payload, null, 2));

  const result = payload.event === 'poll_vote' ? handlePollVote(payload) : handleMessage(payload);
  return res.json(result);
});

app.listen(PORT, () => {
  console.log(`fake-brain listening on ${PORT} (signature check ${SECRET ? 'ON' : 'OFF'})`);
});
