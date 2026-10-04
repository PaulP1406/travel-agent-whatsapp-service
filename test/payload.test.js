import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, buildPollVotePayload, protectDashboardLinks, rewriteOutboundMentions } from '../src/payload.js';

function makeMsg(overrides = {}) {
  return {
    id: { _serialized: 'false_1203@g.us_ABC' },
    timestamp: 1759400000,
    body: 'hello @agent',
    type: 'chat',
    author: '14165551234@c.us',
    from: '14165551234@c.us',
    hasQuotedMsg: false,
    hasMedia: false,
    getContact: async () => ({ pushname: 'Priya', number: '14165551234' }),
    getMentions: async () => [],
    ...overrides,
  };
}

function makeGroupChat(overrides = {}) {
  return {
    id: { _serialized: '1203@g.us' },
    name: 'Lisbon trip',
    isGroup: true,
    participants: [1, 2, 3, 4, 5],
    ...overrides,
  };
}

function makeDmChat(overrides = {}) {
  return {
    id: { _serialized: '14165551234@c.us' },
    name: 'Priya',
    isGroup: false,
    ...overrides,
  };
}

test('WhatsApp mention ids in the body are rewritten to @Full Name', async () => {
  const msg = makeMsg({
    body: 'hey @14165551234 can you make it',
    getMentions: async () => [
      { id: { _serialized: '14165551234@c.us' }, name: 'Priya Shah' },
    ],
  });
  const payload = await buildPayload(msg, makeGroupChat(), '1555@c.us');
  assert.equal(payload.text, 'hey @Priya Shah can you make it');
});

test('outbound messages keep @Full Name and rewrite ids onto that name', () => {
  const out = rewriteOutboundMentions('hey @Priya and @14165551234@c.us', [
    { id: '14165551234@c.us', name: 'Priya Shah' },
  ]);
  assert.equal(out.text, 'hey @Priya Shah and @Priya Shah');
  assert.deepEqual(out.mentions, ['14165551234@c.us']);
});

test('outbound rewrite leaves dashboard session URLs intact', () => {
  const link = 'http://localhost:3001/dashboard/120363431201620340%40g.us/8a589a65-0212-4bba-b7ab-a95c1d7fdcbe';
  const raw = 'http://localhost:3001/dashboard/120363431201620340@g.us/8a589a65-0212-4bba-b7ab-a95c1d7fdcbe';
  const encoded = rewriteOutboundMentions(`Watch live:\n${link}`, [
    { id: '14165551234@c.us', name: 'Priya Shah' },
  ]);
  const jid = rewriteOutboundMentions(`Watch live:\n${raw}`, [
    { id: '14165551234@c.us', name: 'Priya Shah' },
  ]);
  assert.equal(encoded.text, `Watch live:\n${link}`);
  assert.equal(jid.text, `Watch live:\n${raw}`);
});

test('protectDashboardLinks restores a group id WhatsApp mention-stripping removed', () => {
  const broken = 'Watch the flight and hotel search live:\nhttp://localhost:3001/dashboard//1eabd965-7bd0-4658-b523-f407c72c189c';
  const raw = 'http://localhost:3001/dashboard/120363429754104173@g.us/1eabd965-7bd0-4658-b523-f407c72c189c';
  const fixed = 'http://localhost:3001/dashboard/120363429754104173%40g.us/1eabd965-7bd0-4658-b523-f407c72c189c';
  assert.equal(
    protectDashboardLinks(broken, '120363429754104173@g.us'),
    'Watch the flight and hotel search live:\n' + fixed,
  );
  assert.equal(protectDashboardLinks(raw, '120363429754104173@g.us'), fixed);
});

test('buildPayload produces the flat orchestrator contract shape', async () => {
  const payload = await buildPayload(makeMsg(), makeGroupChat(), '1555@c.us');

  assert.equal(payload.event, 'message');
  assert.equal(payload.channel, 'whatsapp');
  assert.equal(payload.message_id, 'false_1203@g.us_ABC');
  assert.equal(payload.group_id, '1203@g.us');
  assert.equal(payload.group_name, 'Lisbon trip');
  assert.equal(payload.is_group, true);
  assert.equal(payload.participant_count, 5);
  assert.equal(payload.sender_id, '14165551234@c.us');
  assert.equal(payload.sender_name, 'Priya');
  assert.equal(payload.text, 'hello @agent');
  assert.equal(payload.agent_id, '1555@c.us');
  assert.equal(payload.quoted, null);
  assert.equal(payload.media, null);
  assert.deepEqual(payload.participants, []);
});

test('a reply to the bot counts as tagged', async () => {
  const msg = makeMsg({
    getMentions: async () => [],
    hasQuotedMsg: true,
    getQuotedMessage: async () => ({
      id: { _serialized: 'bot_msg' },
      fromMe: true,
      body: 'Reply 1, 2, or 3.',
    }),
  });
  const payload = await buildPayload(msg, makeGroupChat(), '1555@c.us');
  assert.equal(payload.tagged, true);
  assert.equal(payload.quoted.from_me, true);
});

test('tagged is true only when selfId is among the mentioned ids', async () => {
  const msg = makeMsg({ getMentions: async () => [{ id: { _serialized: '1555@c.us' } }] });
  const chat = makeGroupChat();

  const tagged = await buildPayload(msg, chat, '1555@c.us');
  assert.equal(tagged.tagged, true);

  const untagged = await buildPayload(msg, chat, '9999@c.us');
  assert.equal(untagged.tagged, false);
});

test('tagged group messages include a named roster of members', async () => {
  const msg = makeMsg({
    getMentions: async () => [{ id: { _serialized: '1555@c.us' } }],
  });
  const chat = makeGroupChat({
    participants: [
      {
        id: { _serialized: '14165551234@c.us' },
        isAdmin: true,
        getContact: async () => ({ name: 'Priya', number: '14165551234' }),
      },
      {
        id: { _serialized: '1555@c.us' },
        getContact: async () => ({ pushname: 'Fare' }),
      },
    ],
  });
  const payload = await buildPayload(msg, chat, '1555@c.us');
  assert.equal(payload.tagged, true);
  assert.deepEqual(payload.participants, [
    { id: '14165551234@c.us', name: 'Priya', is_admin: true, is_agent: false },
    { id: '1555@c.us', name: 'Fare', is_admin: false, is_agent: true },
  ]);
});

test('group messages use msg.author as the sender id', async () => {
  const msg = makeMsg({ author: '14165551234@c.us', from: '1203@g.us' });
  const payload = await buildPayload(msg, makeGroupChat(), null);
  assert.equal(payload.sender_id, '14165551234@c.us');
});

test('DMs use msg.from as the sender id', async () => {
  const msg = makeMsg({ author: undefined, from: '14165551234@c.us' });
  const payload = await buildPayload(msg, makeDmChat(), null);
  assert.equal(payload.sender_id, '14165551234@c.us');
  assert.equal(payload.is_group, false);
  assert.equal(payload.participant_count, null);
});

test('a quoted message is included when present', async () => {
  const msg = makeMsg({
    hasQuotedMsg: true,
    getQuotedMessage: async () => ({
      id: { _serialized: 'quoted_id' },
      author: '555@c.us',
      body: 'original text',
      fromMe: false,
    }),
  });
  const payload = await buildPayload(msg, makeGroupChat(), null);
  assert.deepEqual(payload.quoted, {
    id: 'quoted_id',
    sender_id: '555@c.us',
    text: 'original text',
    from_me: false,
  });
});

test('media is summarized without base64 unless forwardMedia is set', async () => {
  const msg = makeMsg({ hasMedia: true, type: 'image' });
  const payload = await buildPayload(msg, makeGroupChat(), null, { forwardMedia: false });
  assert.deepEqual(payload.media, { type: 'image' });
});

test('media includes base64 data when forwardMedia is set', async () => {
  const msg = makeMsg({
    hasMedia: true,
    type: 'image',
    downloadMedia: async () => ({ mimetype: 'image/jpeg', filename: null, data: 'base64data' }),
  });
  const payload = await buildPayload(msg, makeGroupChat(), null, { forwardMedia: true });
  assert.deepEqual(payload.media, {
    type: 'image',
    mimetype: 'image/jpeg',
    filename: null,
    data_base64: 'base64data',
  });
});

function makeVote(overrides = {}) {
  return {
    voter: '14165551234@c.us',
    selectedOptions: [{ name: 'Hotel B', localId: 1 }],
    interractedAtTs: 1759400000000,
    parentMessage: { id: { _serialized: 'poll_msg_id' }, pollName: 'Where should we stay?' },
    client: { getContactById: async () => ({ pushname: 'Priya', number: '14165551234' }) },
    ...overrides,
  };
}

test('buildPollVotePayload produces the flat poll_vote event shape', async () => {
  const payload = await buildPollVotePayload(makeVote(), makeGroupChat(), '1555@c.us');
  assert.equal(payload.event, 'poll_vote');
  assert.equal(payload.channel, 'whatsapp');
  assert.equal(payload.group_id, '1203@g.us');
  assert.equal(payload.group_name, 'Lisbon trip');
  assert.equal(payload.voter_id, '14165551234@c.us');
  assert.equal(payload.voter_name, 'Priya');
  assert.equal(payload.poll_message_id, 'poll_msg_id');
  assert.equal(payload.poll_name, 'Where should we stay?');
  assert.deepEqual(payload.selected_options, ['Hotel B']);
  assert.equal(payload.agent_id, '1555@c.us');
  assert.equal(payload.timestamp, 1759400000);
});

test('buildPollVotePayload reports an empty array when all options are deselected', async () => {
  const payload = await buildPollVotePayload(makeVote({ selectedOptions: [] }), makeGroupChat(), null);
  assert.deepEqual(payload.selected_options, []);
});

test('buildPollVotePayload falls back to the bare id when contact lookup fails', async () => {
  const vote = makeVote({
    client: {
      getContactById: async () => {
        throw new Error('not found');
      },
    },
  });
  const payload = await buildPollVotePayload(vote, makeGroupChat(), null);
  assert.equal(payload.voter_name, 'Someone');
  assert.equal(payload.voter_phone, '14165551234');
});
