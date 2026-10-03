# WhatsApp Service — Build Spec for Claude Code

> Drop this file in the root of the `whatsapp-service` repo as `CLAUDE.md` (or point Claude Code at it). It tells Claude Code what to build, in what order, and how to verify each step. Work through the tasks top to bottom; do not skip the "Done when" checks.

---

## 0. What this service is

The agent's WhatsApp "body". It logs in as a normal WhatsApp user (a burner number owned by the team), joins group chats, forwards every group message to a separate FastAPI service called the **brain**, and sends messages back when the brain asks. It holds **no product logic**: no LLM calls, no trip state, no booking. It is a dumb, reliable relay.

```
Friends in group ──► WhatsApp ──► whatsapp-service ──POST (signed)──► brain /webhook/whatsapp
Friends in group ◄── WhatsApp ◄── whatsapp-service ◄──POST /send (Bearer)── brain
```

- Runtime: **Node.js 20**, ESM modules
- Core library: **whatsapp-web.js** (drives WhatsApp Web through headless Chromium via Puppeteer)
- HTTP: **Express**
- Logging: **pino**
- No database. State is in memory plus the WhatsApp session folder on disk.

Known constraints:
- This is unofficial automation of consumer WhatsApp. Use a burner SIM; expect possible bans; never send bursts.
- Needs a long-running process, ~1 GB RAM, and a persistent disk for the session folder. Serverless and sleeping free tiers will not work.

---

## 1. Repo layout (target)

```
whatsapp-service/
├── CLAUDE.md                 ← this file
├── README.md                 ← human docs (contracts, setup, gotchas)
├── package.json
├── .env.example
├── .gitignore                ← .env, .wwebjs_auth/, .wwebjs_cache/, node_modules/
├── Dockerfile                ← node:20-bookworm-slim + chromium
├── docker-compose.yml
├── src/
│   ├── index.js              ← boot: start HTTP server + WhatsApp client, signal handling
│   ├── config.js             ← env parsing with defaults (no dotenv dependency)
│   ├── logger.js             ← pino instance
│   ├── auth.js               ← HMAC signing (→ brain) and Bearer middleware (← brain)
│   ├── brain.js              ← forwardToBrain(payload): fetch with timeout + retry
│   ├── whatsapp.js           ← client, events, payload builder, outbound queue, queries
│   └── server.js             ← Express routes
├── scripts/
│   ├── fake-brain.js         ← local stub brain for testing without FastAPI
│   └── smoke.sh              ← curl checks against a running instance
└── test/
    ├── auth.test.js          ← HMAC + bearer unit tests (node:test)
    └── payload.test.js       ← buildPayload with mocked message objects
```

A first-pass implementation of `src/*`, `README.md`, `Dockerfile`, `docker-compose.yml`, `.env.example`, and `package.json` may already exist in the repo. If so, **read them first**, keep the contracts below unchanged, and extend rather than rewrite.

---

## 2. Environment variables

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
| `AUTH_DATA_PATH` | `.wwebjs_auth` | Session folder (persist this!) |
| `CHROME_PATH` | *(empty → bundled)* | `/usr/bin/chromium` on Linux servers |
| `HEADLESS` | `true` | Headless Chromium |
| `LOG_LEVEL` | `info` | pino level |

---

## 3. Contracts (do not change without updating the brain)

### 3.1 Inbound: service → brain

`POST {BRAIN_WEBHOOK_URL}` with headers:
- `Content-Type: application/json`
- `X-Timestamp: <unix seconds>`
- `X-Signature: sha256=<hex>` where hex = HMAC-SHA256(secret, `"<timestamp>.<raw body>"`)

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

Brain may respond `200` with `{ "reply": "text", "quote": true }` for an immediate reply, or `{}` to stay silent. Service retries on network error / 5xx (3 attempts, backoff 500 ms × attempt) and never crashes on brain failure.

### 3.2 Outbound: brain → service

All routes except `/health` require `Authorization: Bearer {SERVICE_TOKEN}`.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/health` | — | `{ ok, status, ready_at, agent_id, relayed, sent, needs_qr }` |
| POST | `/send` | `{ chat_id, text, reply_to_message_id?, mentions? }` | `{ ok, message_id, timestamp }` |
| POST | `/send/batch` | `{ messages: [ {chat_id, text, …} ] }` | `{ results: [...] }` |
| GET | `/groups` | — | `{ groups: [ {id, name, participant_count, unread} ] }` |
| GET | `/groups/:id` | — | `{ id, name, description, participants: [ {id, is_admin, is_agent} ] }` |
| GET | `/groups/:id/history` | `?limit=50` (max 200) | `{ chat_id, messages: [...] }` |

Status codes: `400` bad input, `401` bad token, `404` unknown chat, `503` client not ready.

---

## 4. Build tasks (in order)

Each task ends with a **Done when** check. Run it before moving on.

### Task 1 — Bootstrap and verify the toolchain
```bash
node --version            # must be ≥ 18, prefer 20
npm install
cp .env.example .env      # then set BRAIN_SHARED_SECRET and SERVICE_TOKEN to random strings:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
On Linux also: `sudo apt install chromium` and set `CHROME_PATH=/usr/bin/chromium` in `.env`.

**Done when:** `node --check src/*.js` passes and `npm start` prints `starting whatsapp-service` and `HTTP API listening`.

### Task 2 — Fake brain for local testing
Create `scripts/fake-brain.js`: an Express server on port 8000 with `POST /webhook/whatsapp` that
1. verifies `X-Timestamp` / `X-Signature` using `BRAIN_SHARED_SECRET` (reject with 401 if wrong),
2. logs the payload pretty-printed,
3. returns `{ reply: "🤖 echo: " + text, quote: true }` **only if** `tagged` is true, else `{}`.

Add `"fake-brain": "node scripts/fake-brain.js"` to package.json scripts.

**Done when:** `npm run fake-brain` starts and `curl -X POST localhost:8000/webhook/whatsapp -d '{}'` returns 401.

### Task 3 — First login and echo
1. Terminal A: `npm run fake-brain`
2. Terminal B: `npm start` → QR prints.
3. On the burner phone: WhatsApp → Linked devices → Link a device → scan.
4. Wait for `WhatsApp client ready` in logs. `curl localhost:3000/health` shows `"status":"ready"` and an `agent_id`.
5. Add the burner number to a test group with the team. Send any message → it appears in fake-brain logs. Send `@<agent name> hello` → the agent replies with the echo, quoting your message.

**Done when:** untagged messages are logged but not answered; tagged messages get an echo reply within ~3 s.

### Task 4 — Group discovery and history
```bash
export TOKEN=$(grep SERVICE_TOKEN .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/groups | jq
curl -s -H "Authorization: Bearer $TOKEN" localhost:3000/groups/<id>/history?limit=20 | jq
```
Set `ALLOWED_GROUP_IDS=<id>` in `.env`, restart, confirm other groups are now ignored.

**Done when:** both endpoints return the test group, history includes messages sent *before* the agent joined, and `401` is returned without the token.

### Task 5 — Outbound and rate limiting
```bash
curl -s -X POST localhost:3000/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"chat_id":"<id>","text":"✅ test from brain"}' | jq
```
Then `/send/batch` with 3 messages. Watch timestamps: gaps must be ≥ `SEND_MIN_GAP_MS`.

**Done when:** messages arrive in the group in order with visible spacing, and `/send` to a bogus `chat_id` returns a 4xx/5xx JSON error rather than crashing the process.

### Task 6 — Resilience
Test and fix, in this order:
1. **Brain down**: stop fake-brain, send a tagged message. Service must log 3 failed attempts and keep running. Start fake-brain; next message works.
2. **Brain slow**: make fake-brain `await sleep(20000)`. Service must time out at `BRAIN_TIMEOUT_MS`, clear the typing indicator, and not block other messages.
3. **Restart**: `Ctrl+C`, `npm start`. Must reconnect **without** a QR (session persisted in `AUTH_DATA_PATH`).
4. **Duplicate delivery**: confirm the `seen` set prevents double-forwarding when WhatsApp re-emits an event.
5. **Phone offline**: toggle airplane mode on the burner for 2 minutes. Service should log `disconnected` and recover, or at minimum not crash. If it does not auto-recover, make the reconnect loop re-run `client.initialize()` with backoff (5 s, 10 s, 20 s, cap 60 s).

**Done when:** all five scenarios behave as described.

### Task 7 — Tests
Use `node:test` (no extra dependency). Add `"test": "node --test test/"`.
- `test/auth.test.js`: signature is deterministic for same timestamp+body; wrong secret fails; bearer middleware allows correct token and rejects wrong/missing; empty `SERVICE_TOKEN` allows all (and is warned at boot).
- `test/payload.test.js`: given a mocked `msg`/`chat`/`contact`, `buildPayload` produces the §3.1 shape; `tagged` is true only when `state.selfId` is in `mentionedIds`; group messages use `msg.author` as sender id; DMs use `msg.from`.
  - To make `buildPayload` testable, export it from `whatsapp.js` (or move it to `src/payload.js` taking `(msg, chat, selfId, opts)`).

**Done when:** `npm test` is green.

### Task 8 — Smoke script
`scripts/smoke.sh`: reads `.env`, hits `/health`, `/groups`, and (if `SMOKE_CHAT_ID` is set) posts one `/send`. Exit non-zero on any failure. Used before every demo run.

**Done when:** `bash scripts/smoke.sh` prints PASS lines and exits 0 against a ready instance.

### Task 9 — Docker
```bash
docker compose up -d --build
docker compose logs -f whatsapp        # QR appears here on first boot
```
Verify the session volume survives `docker compose down && docker compose up -d` (no second QR). Confirm memory usage stays under ~800 MB (`docker stats`).

**Done when:** container reaches `ready`, `/health` works from the host, and a restart does not require rescanning.

### Task 10 — Deploy (pick one)
- **Railway**: new project from repo → add a volume mounted at `/data` → set env vars from `.env.example` (with `AUTH_DATA_PATH=/data/.wwebjs_auth`, `CHROME_PATH=/usr/bin/chromium`, `HEADLESS=true`) → give the service ≥ 1 GB RAM → deploy → scan the QR from the deploy logs → set `BRAIN_WEBHOOK_URL` to the brain's public URL.
- **Render (paid instance)**: same, with a persistent disk at `/data`. Free tier will not work (sleeps, no disk).
- **VM (Oracle Always Free / any Ubuntu)**: `docker compose up -d`, then expose with Cloudflare Tunnel or Caddy.
- **Laptop for the hackathon**: run locally; expose the *brain* (not this service) with `cloudflared tunnel --url http://localhost:8000` only if the brain is hosted elsewhere. If both run on the laptop, no tunnel is needed between them.

**Done when:** `/health` on the public URL returns `ready`, and a tagged message in the real group produces a reply from the real brain.

---

## 5. Coding rules for this repo

- Never put LLM calls, trip logic, or DB access in this service. If a task seems to need it, it belongs in the brain.
- Never crash on a single bad message. Wrap every event handler; log and continue.
- Never send more than one outbound message per inbound message without going through the rate-limited queue.
- Keep `.env`, `.wwebjs_auth/`, `.wwebjs_cache/` out of git (already in `.gitignore`).
- Do not log full message bodies at `info` in production; truncate to ~80 chars. Full bodies at `debug` only.
- Do not add dependencies beyond `whatsapp-web.js`, `express`, `pino`, `pino-pretty`, `qrcode-terminal` without a reason written in the commit message.
- Keep the §3 contracts stable. If a field must change, bump `"event"` to `"message.v2"` and tell the brain owner.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| QR never appears / `ready` never fires | `npm run reset-auth`, upgrade `whatsapp-web.js` to latest (`npm i whatsapp-web.js@latest`), restart |
| `auth_failure` | Session revoked on the phone. Reset auth, rescan |
| Works locally, nothing in Docker | Missing `CHROME_PATH=/usr/bin/chromium` or `--no-sandbox` args |
| Chromium OOM / container restarts | Give ≥ 1 GB RAM; keep `HEADLESS=true` |
| Agent replies to its own messages | You switched to `message_create`; filter `msg.fromMe` |
| `tagged` is always false | `state.selfId` not set yet (client not `ready`) or mention IDs are objects; see mapping in `buildPayload` |
| Messages relayed twice | Dedupe set missing or too small; check `seen` logic |
| `/send` returns 503 | Client not ready; check `/health.status` |
| Number banned | Switch to spare SIM, new `AUTH_DATA_PATH`, rescan; slow down sends |

---

## 7. Definition of done for the whole service

- [ ] Tasks 1–9 complete, `npm test` green, `scripts/smoke.sh` passes
- [ ] README documents contracts (§3) and setup
- [ ] Session folder backed up once authenticated
- [ ] Deployed (Task 10) or running on the demo laptop with a documented start command
- [ ] Brain owner has: public URL, `SERVICE_TOKEN`, `BRAIN_SHARED_SECRET`, test group `chat_id`, and the FastAPI verification snippet from README §4