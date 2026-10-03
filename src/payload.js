function mapMediaType(type) {
  if (type === 'ptt' || type === 'audio') return 'audio';
  return type || 'unknown';
}

function serializedId(id) {
  if (id == null) return '';
  if (typeof id === 'string') return id;
  return id._serialized || id.$1 || '';
}

export function looksLikeWhatsAppId(value) {
  if (!value || typeof value !== 'string') return false;
  return /@(c\.us|g\.us|lid|s\.whatsapp\.net)\b/i.test(value);
}

export function firstName(name) {
  const s = String(name || '').trim();
  if (!s || looksLikeWhatsAppId(s)) return '';
  return s.split(/\s+/)[0];
}

function isBarePhone(value) {
  return /^\d{6,}$/.test(String(value || '').trim());
}

export function contactDisplayName(contact, fallback) {
  const candidates = [
    contact?.name,
    contact?.pushname,
    contact?.shortName,
    contact?.notifyName,
    fallback,
  ];
  for (const raw of candidates) {
    const s = String(raw || '').trim();
    if (s && !looksLikeWhatsAppId(s) && !isBarePhone(s)) return s;
  }
  return '';
}

export function stripOutboundTags(text, members = []) {
  let out = String(text || '');
  const list = (members || []).filter((m) => m && (m.id || m.name));
  list.sort((a, b) => String(b.id || '').length - String(a.id || '').length);
  for (const m of list) {
    const id = String(m.id || '');
    const user = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
    if (id) {
      out = out.split(`@${id}`).join(' ').split(id).join(' ');
    }
    if (user && user.length >= 6) {
      out = out.split(`@${user}`).join(' ');
    }
    const n = firstName(m.name);
    if (n.length >= 2) {
      out = out.replace(new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
    }
  }
  out = out.replace(/@?[A-Za-z0-9._+-]+@(?:c\.us|g\.us|lid|s\.whatsapp\.net)/gi, '');
  out = out.replace(/@\d{6,}/g, '');
  out = out.replace(/@[A-Za-z][\w'-]*/g, '');
  return out.replace(/[^\S\n]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

export function humanizeChatText(text, members = []) {
  let out = String(text || '');
  const list = (members || []).filter((m) => m && contactDisplayName({ name: m.name }, m.name));
  list.sort((a, b) => String(b.id || '').length - String(a.id || '').length);
  for (const m of list) {
    const name = firstName(m.name) || m.name;
    const id = String(m.id || '');
    const user = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
    if (id) {
      out = out.split(`@${id}`).join(name).split(id).join(name);
    }
    if (user && user.length >= 6) {
      out = out.split(`@${user}`).join(name);
    }
  }
  out = out.replace(/@?[A-Za-z0-9._+-]+@(?:c\.us|g\.us|lid|s\.whatsapp\.net)/gi, '');
  out = out.replace(/@\d{6,}/g, '');
  return out.replace(/[^\S\n]{2,}/g, ' ').trim();
}

export async function listChatMembers(chat, selfId) {
  const parts = Array.isArray(chat.participants) ? chat.participants : [];
  const members = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !p.id) continue;
    const id = serializedId(p.id);
    if (!id) continue;
    let contact = null;
    if (typeof p.getContact === 'function') {
      try {
        contact = await p.getContact();
      } catch {
        // fall through
      }
    }
    members.push({
      id,
      name: contactDisplayName(contact, ''),
      is_admin: !!(p.isAdmin || p.isSuperAdmin),
      is_agent: id === selfId,
    });
  }
  return members;
}

async function getMentionMembers(msg) {
  if (typeof msg.getMentions === 'function') {
    try {
      const mentions = await msg.getMentions();
      return mentions.map((m) => ({
        id: serializedId(m.id),
        name: contactDisplayName(m, ''),
      }));
    } catch {
      // fall through to the raw field below
    }
  }
  const ids = msg.mentionedIds ?? [];
  return ids.map((id) => ({ id: serializedId(id), name: '' }));
}

// Field names match the orchestrator's existing CONTRACTS.md (flat group_id /
// sender_id, not nested chat/sender objects) — this service conforms to the
// brain's established contract rather than the other way around. Extra
// fields (mentioned_ids, quoted, media, agent_id, ...) ride along for brains
// that want them; Go's json.Decode silently ignores fields it doesn't know.
export async function buildPayload(msg, chat, selfId, opts = {}) {
  const { forwardMedia = false, includeRoster } = opts;
  const contact = await msg.getContact();
  const isGroup = !!chat.isGroup;
  // Group messages you send yourself (ALLOW_SELF_MESSAGES testing) have no
  // msg.author — fall back to selfId instead of misattributing to the group.
  const senderId = isGroup ? msg.author || (msg.fromMe ? selfId : msg.from) : msg.from;
  const mentionMembers = await getMentionMembers(msg);
  const mentionedIds = mentionMembers.map((m) => m.id).filter(Boolean);

  let quoted = null;
  if (msg.hasQuotedMsg) {
    const q = await msg.getQuotedMessage();
    quoted = {
      id: serializedId(q.id),
      sender_id: q.author || q.from,
      text: q.body || '',
      from_me: !!q.fromMe,
    };
  }

  const tagged =
    (!!selfId && mentionedIds.includes(selfId)) || !!(quoted && quoted.from_me);
  const senderName = contactDisplayName(contact, '') || 'Someone';
  const rawText = msg.body ?? '';
  const wantRoster = includeRoster ?? (isGroup && tagged);
  const needsNames = wantRoster || /@/.test(rawText) || looksLikeWhatsAppId(rawText);
  const participants = isGroup && needsNames ? await listChatMembers(chat, selfId) : [];
  const text = humanizeChatText(rawText, [...mentionMembers, ...participants]);

  let media = null;
  if (msg.hasMedia) {
    const type = mapMediaType(msg.type);
    if (forwardMedia) {
      const data = await msg.downloadMedia();
      media = {
        type,
        mimetype: data?.mimetype ?? null,
        filename: data?.filename ?? null,
        data_base64: data?.data ?? null,
      };
    } else {
      media = { type };
    }
  }

  return {
    event: 'message',
    channel: 'whatsapp',
    message_id: serializedId(msg.id) || msg.id,
    group_id: serializedId(chat.id),
    group_name: chat.name,
    sender_id: senderId,
    sender_name: senderName,
    sender_phone: contact?.number ?? senderId?.split('@')[0],
    text,
    tagged,
    timestamp: msg.timestamp,
    type: msg.type ?? 'chat',
    is_group: isGroup,
    participant_count: isGroup ? chat.participants?.length ?? null : null,
    participants: wantRoster ? participants : [],
    mentioned_ids: mentionedIds,
    quoted,
    media,
    agent_id: selfId,
  };
}

// vote.client is set by whatsapp-web.js's Base class constructor — there's no
// vote.getContact() helper, so resolve the voter's contact the same way Chat
// and Message do internally (via client.getContactById).
//
// poll_vote is a brand-new event type — there's no existing brain-side
// contract for it yet, so these field names are this service's proposal
// (kept flat, matching the message event's convention) rather than an
// existing agreement.
export async function buildPollVotePayload(vote, chat, selfId) {
  let contact = null;
  const voterId = serializedId(vote.voter) || String(vote.voter || '');
  try {
    if (voterId) {
      contact = await vote.client.getContactById(voterId);
    }
  } catch {
    // best effort — fall back to the bare id below
  }

  const selected = (vote.selectedOptions || [])
    .map((o) => o?.name ?? (o?.localId != null ? String(o.localId) : ''))
    .filter((s) => s !== '');

  return {
    event: 'poll_vote',
    channel: 'whatsapp',
    group_id: serializedId(chat.id),
    group_name: chat.name,
    voter_id: voterId,
    voter_name: contactDisplayName(contact, '') || 'Someone',
    voter_phone: contact?.number ?? voterId.split('@')[0],
    poll_message_id:
      serializedId(vote.parentMessage?.id) ||
      serializedId(vote.parentMsgKey) ||
      null,
    poll_name: vote.parentMessage?.pollName ?? null,
    selected_options: selected,
    agent_id: selfId,
    timestamp: vote.interractedAtTs
      ? Math.floor(vote.interractedAtTs / 1000)
      : Math.floor(Date.now() / 1000),
  };
}
