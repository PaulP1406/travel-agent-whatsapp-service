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

### Inbound: service → brain

`POST {BRAIN_WEBHOOK_URL}` with headers:
- `Content-Type: application/json`
- `X-Timestamp: <unix seconds>`
- `X-Signature: sha256=<hex>` where hex = `HMAC-SHA256(secret, "<timestamp>.<raw body>")`

Body:

```jsonc
{
  "event": "message",
  "channel": "whatsapp",
  "message_id": "false_1203…@g.us_3EB0…",
  "timestamp": 1759400000,
  "chat":   { "id": "1203…@g.us", "name": "Lisbon trip", "is_group": true, "participant_count": 5 },
  "sender": { "id": "14165551234@c.us", "name": "Priya", "phone": "14165551234" },
  "text": "@Yate figure this out",
  "type": "chat",
  "tagged": true,
  "mentioned_ids": ["1555…@c.us"],
  "quoted": { "id": "…", "sender_id": "…", "text": "…", "from_me": false } | null,
  "media":  { "type": "image", "mimetype": "image/jpeg", "filename": null, "data_base64": "…" } | { "type": "image" } | null,
  "agent_id": "1555…@c.us"
}
```

A second inbound event, `poll_vote`, fires whenever someone taps an option on
a WhatsApp poll (whether the poll was created by the brain via `/send` or by
anyone else in the chat):

```jsonc
{
  "event": "poll_vote",
  "channel": "whatsapp",
  "chat":   { "id": "1203…@g.us", "name": "Lisbon trip", "is_group": true, "participant_count": 5 },
  "voter":  { "id": "14165551234@c.us", "name": "Priya", "phone": "14165551234" },
  "poll_message_id": "true_1203…@g.us_3EB0…",
  "poll_name": "Which vibe should this trip be?",
  "selected_options": ["Chill beach town"],
  "agent_id": "1555…@c.us",
  "timestamp": 1759400000
}
```

`selected_options` is `[]` when the voter deselects everything (WhatsApp
allows withdrawing a vote). For both event types, the brain may respond `200`
with `{ "reply": "text", "quote": true }` for an immediate text reply, **or**
`{ "poll": { "name", "options", "allow_multiple_answers" }, "quote": true }`
to send a new poll instead, or `{}` to stay silent — never both `reply` and
`poll` in the same response. The service retries on network error or 5xx (3
attempts, backoff 500ms × attempt) and never crashes on brain failure.

### Outbound: brain → service

All routes except `/health` require `Authorization: Bearer {SERVICE_TOKEN}`.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, status, ready_at, agent_id, relayed, sent, needs_qr }` |
| POST | `/send` | `{ chat_id, text? \| poll?, reply_to_message_id?, mentions? }` | `{ ok, message_id, timestamp }` |
| POST | `/send/batch` | `{ messages: [ {chat_id, text? \| poll?, …} ] }` | `{ results: [...] }` |
| GET | `/groups` | — | `{ groups: [ {id, name, participant_count, unread} ] }` |
| GET | `/groups/:id` | — | `{ id, name, description, participants: [ {id, is_admin, is_agent} ] }` |
| GET | `/groups/:id/history` | `?limit=50` (max 200) | `{ chat_id, messages: [...] }` |

`poll` is `{ "name": "...", "options": ["A", "B"], "allow_multiple_answers": false }`
(`options` needs at least 2 entries). Exactly one of `text` or `poll` is
required per message. Status codes: `400` bad input, `401` bad token, `404`
unknown chat, `503` client not ready.

### Verifying the signature from the brain (FastAPI)

```python
import hashlib, hmac
from fastapi import FastAPI, Request, HTTPException

BRAIN_SHARED_SECRET = "..."  # same value as this service's BRAIN_SHARED_SECRET

app = FastAPI()

@app.post("/webhook/whatsapp")
async def webhook(request: Request):
    raw_body = await request.body()
    timestamp = request.headers.get("x-timestamp", "")
    signature = request.headers.get("x-signature", "")

    if BRAIN_SHARED_SECRET:
        expected = "sha256=" + hmac.new(
            BRAIN_SHARED_SECRET.encode(),
            f"{timestamp}.{raw_body.decode()}".encode(),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise HTTPException(status_code=401, detail="bad signature")

    payload = await request.json()
    if payload.get("tagged"):
        return {"reply": "got it!", "quote": True}
    return {}
```

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
