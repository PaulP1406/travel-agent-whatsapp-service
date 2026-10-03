# whatsapp-service

The agent's WhatsApp "body". It logs in as a normal WhatsApp user (a burner
number), joins group chats, forwards every group message to a separate
FastAPI service (the **brain**), and sends messages back when the brain asks.
It holds no product logic — no LLM calls, no trip state, no booking. It is a
dumb, reliable relay.

```
Friends in group ──► WhatsApp ──► whatsapp-service ──POST (signed)──► brain /webhook/whatsapp
Friends in group ◄── WhatsApp ◄── whatsapp-service ◄──POST /send (Bearer)── brain
```

See `CLAUDE.md` for the full build spec and task-by-task verification steps.

## Setup

```bash
node --version            # needs >= 20.6 (uses node's built-in --env-file flag)
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # run twice:
# once for BRAIN_SHARED_SECRET, once for SERVICE_TOKEN — paste into .env
```

On Linux also install Chromium and point `CHROME_PATH` at it:

```bash
sudo apt install chromium
echo 'CHROME_PATH=/usr/bin/chromium' >> .env
```

On macOS, if `npm install` skipped Puppeteer's postinstall step (common under
corporate npm security policies — check for an `npm warn install-scripts`
line), point `CHROME_PATH` at your existing Chrome install instead of
downloading Puppeteer's bundled Chromium:

```bash
echo 'CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' >> .env
```

This only affects local dev — the Docker image always installs its own
Chromium via `apt`.

Start it:

```bash
npm start
```

A QR code prints in the terminal. On the burner phone: **WhatsApp → Linked
devices → Link a device** → scan. Once `WhatsApp client ready` appears in the
logs, `curl localhost:3000/health` should show `"status":"ready"`.

For local testing without the real brain, run `npm run fake-brain` in another
terminal — it's a stub FastAPI-shaped Express server that verifies the HMAC
signature, logs every payload, and echoes back tagged messages.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `BRAIN_WEBHOOK_URL` | `http://localhost:8000/webhook/whatsapp` | Where inbound messages are POSTed |
| `BRAIN_SHARED_SECRET` | *(empty → unsigned, warn)* | HMAC secret shared with the brain |
| `BRAIN_TIMEOUT_MS` | `15000` | Per-attempt timeout to the brain |
| `PORT` | `3000` | This service's HTTP port |
| `SERVICE_TOKEN` | *(empty → unprotected, warn)* | Bearer token the brain must present |
| `GROUPS_ONLY` | `true` | Ignore DMs |
| `ALLOWED_GROUP_IDS` | *(empty → all groups)* | Comma-separated `…@g.us` allow-list |
| `SEND_MIN_GAP_MS` | `1500` | Minimum spacing between outbound messages |
| `SHOW_TYPING` | `true` | Typing indicator while the brain thinks (only when tagged) |
| `FORWARD_MEDIA` | `false` | Base64 attachments into the payload |
| `ALLOW_SELF_MESSAGES` | `false` | Solo testing only — lets you `@tag` yourself from your own linked phone and have it relay like a normal message. Keep `false` on a real deployment |
| `AUTH_DATA_PATH` | `.wwebjs_auth` | Session folder (persist this!) |
| `CHROME_PATH` | *(empty → bundled)* | `/usr/bin/chromium` on Linux servers |
| `HEADLESS` | `true` | Headless Chromium |
| `LOG_LEVEL` | `info` | pino level |

## Contracts

Field names here match the orchestrator's own `CONTRACTS.md` (flat
`group_id`/`sender_id`, not nested objects) — this service conforms to the
brain's established contract. See `docs/whatsapp-poll-integration.md` in the
orchestrator repo for what the brain side needs to implement for polls, the
one genuinely new piece on both sides.

### Inbound: service → brain

`POST {BRAIN_WEBHOOK_URL}` with headers:
- `Content-Type: application/json`
- `X-Timestamp: <unix seconds>`
- `X-Signature: sha256=<hex>` where hex = `HMAC-SHA256(secret, "<timestamp>.<raw body>")` — only sent when `BRAIN_SHARED_SECRET` is set. Leave it unset if the brain doesn't verify it (it doesn't, today).

Body:

```jsonc
{
  "event": "message",
  "channel": "whatsapp",
  "message_id": "false_1203…@g.us_3EB0…",
  "group_id": "1203…@g.us",
  "group_name": "Lisbon trip",
  "sender_id": "14165551234@c.us",
  "sender_name": "Priya",
  "sender_phone": "14165551234",
  "text": "@Yate figure this out",
  "tagged": true,
  "timestamp": 1759400000,
  "type": "chat",
  "is_group": true,
  "participant_count": 5,
  "mentioned_ids": ["1555…@c.us"],
  "quoted": { "id": "…", "sender_id": "…", "text": "…", "from_me": false } | null,
  "media":  { "type": "image", "mimetype": "image/jpeg", "filename": null, "data_base64": "…" } | { "type": "image" } | null,
  "agent_id": "1555…@c.us"
}
```

`event`, `channel`, `type`, `is_group`, `participant_count`, `mentioned_ids`,
`quoted`, `media`, and `agent_id` are extra fields beyond the orchestrator's
documented `IncomingMessage` shape — safe to ignore (Go's JSON decoder drops
unknown fields), there if the brain wants richer signal later.

A second inbound event, `poll_vote`, fires whenever someone taps an option on
a WhatsApp poll (whether the poll was created by the brain via `/send` or by
anyone else in the chat). **This event type doesn't exist in the brain's
current contract yet** — these are this service's proposed field names:

```jsonc
{
  "event": "poll_vote",
  "channel": "whatsapp",
  "group_id": "1203…@g.us",
  "group_name": "Lisbon trip",
  "voter_id": "14165551234@c.us",
  "voter_name": "Priya",
  "voter_phone": "14165551234",
  "poll_message_id": "true_1203…@g.us_3EB0…",
  "poll_name": "Which vibe should this trip be?",
  "selected_options": ["Chill beach town"],
  "agent_id": "1555…@c.us",
  "timestamp": 1759400000
}
```

`selected_options` is `[]` when the voter deselects everything (WhatsApp
allows withdrawing a vote).

For both event types, this service's HTTP response body is only read by
simple test stubs like `scripts/fake-brain.js` — the brain may respond `200`
with `{ "reply": "text", "quote": true }` for an immediate text reply, **or**
`{ "poll": { "name", "options", "allow_multiple_answers" }, "quote": true }`
for a new poll, or `{}`/anything else to stay silent in-band. **The
orchestrator's actual pattern is asynchronous**: it always acks the webhook
instantly (`{"reply": null, "accepted": true}`) and delivers real replies
later via a separate call to `POST /send` below — both patterns work against
this service without any code change here. The service retries forwarding on
network error or 5xx (3 attempts, backoff 500ms × attempt) and never crashes
on brain failure.

### Outbound: brain → service

`/send` and `/send/batch` accept `group_id` (the orchestrator's field name)
or `chat_id` interchangeably. All routes except `/health` require
`Authorization: Bearer {SERVICE_TOKEN}` **if `SERVICE_TOKEN` is set** — leave
it unset for now since the orchestrator's `RobotMessenger` doesn't send an
Authorization header yet.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, status, ready_at, agent_id, relayed, sent, needs_qr }` |
| POST | `/send` | `{ group_id, text? \| poll?, reply_to_message_id?, mentions? }` | `{ ok, message_id, timestamp }` |
| POST | `/send/batch` | `{ messages: [ {group_id, text? \| poll?, …} ] }` | `{ results: [...] }` |
| GET | `/groups` | — | `{ groups: [ {id, name, participant_count, unread} ] }` |
| GET | `/groups/:id` | — | `{ id, name, description, participants: [ {id, is_admin, is_agent} ] }` |
| GET | `/groups/:id/history` | `?limit=50` (max 200) | `{ chat_id, messages: [...] }` |

`poll` is `{ "name": "...", "options": ["A", "B"], "allow_multiple_answers": false }`
(`options` needs at least 2 entries) — new, not yet used by the orchestrator's
`Messenger` interface. Exactly one of `text` or `poll` is required per
message. Status codes: `400` bad input, `401` bad token, `404` unknown chat,
`503` client not ready.

## Testing

```bash
npm test                 # node:test unit tests (auth, payload)
bash scripts/smoke.sh     # hits a running instance's /health, /groups, /send
```

## Docker

```bash
docker compose up -d --build
docker compose logs -f whatsapp   # QR appears here on first boot
```

The WhatsApp session is stored in the `wwebjs_auth` named volume, so
`docker compose down && docker compose up -d` does not require rescanning.

## Deploying

Pick one:
- **Railway / Render (paid)**: persistent disk mounted at `/data`, env vars
  from `.env.example` with `AUTH_DATA_PATH=/data/.wwebjs_auth`,
  `CHROME_PATH=/usr/bin/chromium`, `HEADLESS=true`, ≥1 GB RAM. Scan the QR
  from the deploy logs on first boot.
- **VM (Oracle Always Free / any Ubuntu)**: `docker compose up -d`, expose
  with Cloudflare Tunnel or Caddy.
- **Laptop**: run locally; only tunnel the *brain*, not this service, if the
  brain needs to be reachable from elsewhere.

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR never appears / `ready` never fires | `npm run reset-auth`, upgrade `whatsapp-web.js` to latest, restart |
| `auth_failure` | Session revoked on the phone. Reset auth, rescan |
| Works locally, nothing in Docker | Missing `CHROME_PATH=/usr/bin/chromium` or sandbox args |
| Chromium OOM / container restarts | Give ≥1 GB RAM; keep `HEADLESS=true` |
| Agent replies to its own messages | Check `msg.fromMe` filtering in `src/whatsapp.js` |
| `tagged` is always false | `state.selfId` not set yet (client not ready), or mention IDs are objects — see `src/payload.js` |
| Messages relayed twice | Dedupe set missing or too small — see `seen` in `src/whatsapp.js` |
| `/send` returns 503 | Client not ready; check `/health.status` |
| Number banned | Switch to spare SIM, new `AUTH_DATA_PATH`, rescan; slow down sends |

## Coding rules for this repo

- Never put LLM calls, trip logic, or DB access in this service — it belongs in the brain.
- Never crash on a single bad message. Every event handler is wrapped; log and continue.
- Never send more than one outbound message per inbound message without going through the rate-limited queue.
- Keep `.env`, `.wwebjs_auth/`, `.wwebjs_cache/` out of git.
- Don't log full message bodies at `info` in production; truncated to ~80 chars. Full bodies at `debug` only.
- Keep the contracts above stable. If a field must change, bump `"event"` to `"message.v2"` and tell the brain owner.
