import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildArchivePack,
  findNearDuplicateTexts,
  materializeChat,
  parseJsonlChat,
  validateRoundTrip,
} from '../src/archive-core.js';

describe('archive core', () => {
  it('parses a Luker jsonl chat into header and message floors', () => {
    const jsonl = [
      JSON.stringify({ user_name: 'User', character_name: 'Bot', chat_metadata: { main_chat: 'main' } }),
      JSON.stringify({ name: 'User', is_user: true, mes: 'hello', send_date: '2026-06-04T01:00:00Z' }),
      JSON.stringify({ name: 'Bot', is_user: false, mes: 'hi', send_date: '2026-06-04T01:01:00Z' }),
    ].join('\n');

    const parsed = parseJsonlChat(jsonl, { fileName: 'main' });

    assert.equal(parsed.fileName, 'main');
    assert.deepEqual(parsed.header.chat_metadata, { main_chat: 'main' });
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].mes, 'hello');
  });

  it('packs assistant swipes as variants and materializes the original payload losslessly', () => {
    const chat = [
      { user_name: 'User', character_name: 'Bot', chat_metadata: { main_chat: 'main' } },
      { name: 'User', is_user: true, mes: 'prompt', extra: { files: [{ name: 'a.txt' }] } },
      {
        name: 'Bot',
        is_user: false,
        mes: 'answer b',
        swipes: ['answer a', 'answer b'],
        swipe_id: 1,
        swipe_info: [{ gen_started: 'a-start' }, { gen_started: 'b-start' }],
        extra: { reasoning: 'kept' },
      },
    ];

    const pack = buildArchivePack({
      packName: '测试包',
      avatar: 'bot.png',
      chats: [{ fileName: 'main', chat }],
      now: () => '2026-06-04T00:00:00.000Z',
      makeId: (prefix) => `${prefix}-fixed`,
    });

    const materialized = materializeChat(pack, 'main');

    assert.deepEqual(materialized, chat);
    assert.equal(pack.chats[0].floors[1].variants.length, 2);
    assert.equal(validateRoundTrip(chat, materialized).ok, true);
  });

  it('shares exact text content blocks while keeping per-message restore payloads separate', () => {
    const chat = [
      { chat_metadata: {} },
      { name: 'Bot', is_user: false, mes: 'same text', extra: { model: 'a' } },
      { name: 'Bot', is_user: false, mes: 'same text', extra: { model: 'b' } },
    ];

    const pack = buildArchivePack({ chats: [{ fileName: 'same', chat }] });
    const [firstFloor, secondFloor] = pack.chats[0].floors;

    assert.equal(firstFloor.variants[0].contentBlockId, secondFloor.variants[0].contentBlockId);
    assert.deepEqual(firstFloor.restorePayload.extra, { model: 'a' });
    assert.deepEqual(secondFloor.restorePayload.extra, { model: 'b' });
  });

  it('reports near duplicate text candidates without merging them automatically', () => {
    const pack = buildArchivePack({
      chats: [{
        fileName: 'near',
        chat: [
          { chat_metadata: {} },
          { name: 'Bot', is_user: false, mes: 'The answer is almost right.' },
          { name: 'Bot', is_user: false, mes: 'The answer is almost right!' },
        ],
      }],
    });

    const blockIds = pack.chats[0].floors.map(floor => floor.variants[0].contentBlockId);
    const candidates = findNearDuplicateTexts(pack);

    assert.notEqual(blockIds[0], blockIds[1]);
    assert.equal(candidates.length, 1);
  });

  it('keeps user swipes in the archive reader model but downgrades them for native Luker materialization', () => {
    const chat = [
      { chat_metadata: {} },
      {
        name: 'User',
        is_user: true,
        mes: 'choice b',
        swipes: ['choice a', 'choice b'],
        swipe_id: 1,
        swipe_info: [{ note: 'a' }, { note: 'b' }],
      },
    ];

    const pack = buildArchivePack({ chats: [{ fileName: 'user-swipe', chat }] });
    const archiveCopy = materializeChat(pack, 'user-swipe');
    const lukerCopy = materializeChat(pack, 'user-swipe', { target: 'luker' });

    assert.equal(pack.chats[0].floors[0].variants.length, 2);
    assert.deepEqual(archiveCopy, chat);
    assert.equal(lukerCopy[1].mes, 'choice b');
    assert.equal('swipes' in lukerCopy[1], false);
    assert.equal('swipe_id' in lukerCopy[1], false);
    assert.equal('swipe_info' in lukerCopy[1], false);
  });
});
