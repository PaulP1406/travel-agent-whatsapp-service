function mapMediaType(type) {
  if (type === 'ptt' || type === 'audio') return 'audio';
  return type || 'unknown';
}

async function getMentionedIds(msg) {
  if (typeof msg.getMentions === 'function') {
    try {
      const mentions = await msg.getMentions();
      return mentions.map((m) => m.id?._serialized ?? m.id);
    } catch {
      // fall through to the raw field below
    }
  }
  return msg.mentionedIds ?? [];
}

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
      id: q.id?._serialized ?? q.id,
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
    message_id: msg.id?._serialized ?? msg.id,
    timestamp: msg.timestamp,
    chat: {
      id: chat.id?._serialized ?? chat.id,
      name: chat.name,
      is_group: isGroup,
      participant_count: isGroup ? chat.participants?.length ?? null : null,
    },
    sender: {
      id: senderId,
      name: contact?.pushname || contact?.name || contact?.number || senderId,
      phone: contact?.number ?? senderId?.split('@')[0],
    },
    text: msg.body ?? '',
    type: msg.type ?? 'chat',
    tagged,
    mentioned_ids: mentionedIds,
    quoted,
    media,
    agent_id: selfId,
  };
}
