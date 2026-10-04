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

function memberDisplayName(member) {
  return contactDisplayName({ name: member?.name }, member?.name);
}

function mentionAliases(members) {
  const aliases = [];
  for (const m of members || []) {
    if (!m || m.is_agent) continue;
    const full = memberDisplayName(m);
    if (!full) continue;
    aliases.push({ key: full, member: m });
    const first = firstName(full);
    if (first && first.toLowerCase() !== full.toLowerCase()) {
      aliases.push({ key: first, member: m });
    }
  }
  aliases.sort((a, b) => b.key.length - a.key.length);
  return aliases;
}

function replaceIdsWithNameTags(text, members) {
  let out = String(text || '');
  const mentioned = [];
  const seen = new Set();
  const named = (members || []).filter((m) => m && memberDisplayName(m) && !m.is_agent);
  named.sort((a, b) => String(b.id || '').length - String(a.id || '').length);
  for (const m of named) {
    const tag = `@${memberDisplayName(m)}`;
    const id = String(m.id || '');
    const user = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
    let hit = false;
    if (id && (out.includes(`@${id}`) || out.includes(id))) {
      out = out.split(`@${id}`).join(tag).split(id).join(tag);
      hit = true;
    }
    if (user && user.length >= 6 && out.includes(`@${user}`)) {
      out = out.split(`@${user}`).join(tag);
      hit = true;
    }
    if (hit && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      mentioned.push(m.id);
    }
  }
  // A JID sitting in a URL path is not a mention. Leave /dashboard/1203@g.us/ intact.
  out = out.replace(/(?<![/\w%])@?[A-Za-z0-9._+-]+@(?:c\.us|g\.us|lid|s\.whatsapp\.net)/gi, '');
  out = out.replace(/(?<![/\w%])@\d{6,}/g, '');
  return { text: out, mentioned, seen };
}

function expandNameMentions(text, members, mentioned, seen) {
  const aliases = mentionAliases(members);
  let i = 0;
  let out = '';
  while (i < text.length) {
    if (text[i] !== '@') {
      out += text[i];
      i += 1;
      continue;
    }
    const rest = text.slice(i + 1);
    const hit = aliases.find(({ key }) => {
      if (!rest.toLowerCase().startsWith(key.toLowerCase())) return false;
      const next = rest.charAt(key.length);
      return !next || !/[\w']/.test(next);
    });
    if (!hit) {
      out += '@';
      i += 1;
      continue;
    }
    const full = memberDisplayName(hit.member);
    out += `@${full}`;
    i += 1 + hit.key.length;
    if (hit.member.id && !seen.has(hit.member.id)) {
      seen.add(hit.member.id);
      mentioned.push(hit.member.id);
    }
  }
  return out.replace(/[^\S\n]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

function mapProtectedUrls(text, rewrite) {
  const urls = [];
  const masked = String(text || '').replace(/https?:\/\/[^\s]+/gi, (url) => {
    urls.push(url);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  const restored = rewrite(masked);
  const restore = (value) => String(value || '').replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] || '');
  if (typeof restored === 'string') return restore(restored);
  return { ...restored, text: restore(restored.text) };
}

// Keep @Display Name pings. Rewrite WhatsApp IDs / phone mentions onto that name
// and return the contact ids WhatsApp needs to actually notify them.
export function protectDashboardLinks(text, chatId) {
  const id = String(chatId || '').trim();
  if (!text || !id) return String(text || '');
  const encoded = encodeURIComponent(id);
  return String(text).replace(/\/dashboard\/([^/?#\s]*)/gi, (full, group) => {
    let decoded = group;
    try {
      decoded = decodeURIComponent(group);
    } catch {
      decoded = group;
    }
    if (!group || group.includes('@') || decoded.includes('@')) {
      return `/dashboard/${encoded}`;
    }
    return full;
  });
}

export function rewriteOutboundMentions(text, members = []) {
  return mapProtectedUrls(text, (masked) => {
    const { text: withNames, mentioned, seen } = replaceIdsWithNameTags(masked, members);
    return {
      text: expandNameMentions(withNames, members, mentioned, seen),
      mentions: mentioned,
    };
  });
}

export function stripOutboundTags(text, members = []) {
  return rewriteOutboundMentions(text, members).text;
}

export function humanizeChatText(text, members = []) {
  return mapProtectedUrls(text, (masked) => {
    const { text: out } = replaceIdsWithNameTags(masked, members);
    return out.replace(/[^\S\n]{2,}/g, ' ').trim();
  });
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
export async function buildPollVotePayload(vote, chat, selfId, waClient) {
  let contact = null;
  const voterId = serializedId(vote.voter) || String(vote.voter || '');
  const client = vote.client || waClient;
  try {
    if (voterId && client) {
      contact = await client.getContactById(voterId);
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
