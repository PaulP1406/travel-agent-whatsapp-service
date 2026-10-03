function mapMediaType(type) {
  if (type === 'ptt' || type === 'audio') return 'audio';
  return type || 'unknown';
}

function serializedId(id) {
  if (id == null) return '';
  if (typeof id === 'string') return id;
  return id._serialized || id.$1 || '';
}

async function getMentionedIds(msg) {
  if (typeof msg.getMentions === 'function') {
    try {
      const mentions = await msg.getMentions();
      return mentions.map((m) => serializedId(m.id));
    } catch {
      // fall through to the raw field below
    }
  }
  return msg.mentionedIds ?? [];
}

// Field names match the orchestrator's existing CONTRACTS.md (flat group_id /
// sender_id, not nested chat/sender objects) — this service conforms to the
// brain's established contract rather than the other way around. Extra
// fields (mentioned_ids, quoted, media, agent_id, ...) ride along for brains
// that want them; Go's json.Decode silently ignores fields it doesn't know.
export async function buildPayload(msg, chat, selfId, opts = {}) {
  const { forwardMedia = false } = opts;
  const contact = await msg.getContact();
  const isGroup = !!chat.isGroup;
  // Group messages you send yourself (ALLOW_SELF_MESSAGES testing) have no
  // msg.author — fall back to selfId instead of misattributing to the group.
  const senderId = isGroup ? msg.author || (msg.fromMe ? selfId : msg.from) : msg.from;
  const mentionedIds = await getMentionedIds(msg);
  const tagged = !!selfId && mentionedIds.includes(selfId);

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
    sender_name: contact?.pushname || contact?.name || contact?.number || senderId,
    sender_phone: contact?.number ?? senderId?.split('@')[0],
    text: msg.body ?? '',
    tagged,
    timestamp: msg.timestamp,
    type: msg.type ?? 'chat',
    is_group: isGroup,
    participant_count: isGroup ? chat.participants?.length ?? null : null,
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
  try {
    contact = await vote.client.getContactById(vote.voter);
  } catch {
    // best effort — fall back to the bare id below
  }

  return {
    event: 'poll_vote',
    channel: 'whatsapp',
    group_id: serializedId(chat.id),
    group_name: chat.name,
    voter_id: vote.voter,
    voter_name: contact?.pushname || contact?.name || contact?.number || vote.voter,
    voter_phone: contact?.number ?? vote.voter?.split('@')[0],
    poll_message_id: serializedId(vote.parentMessage?.id) || null,
    poll_name: vote.parentMessage?.pollName ?? null,
    selected_options: vote.selectedOptions.map((o) => o.name ?? String(o.localId)),
    agent_id: selfId,
    timestamp: vote.interractedAtTs ? Math.floor(vote.interractedAtTs / 1000) : Math.floor(Date.now() / 1000),
  };
}
