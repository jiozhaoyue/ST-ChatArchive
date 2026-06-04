import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLukerAdapter,
  ensureExtensionSettings,
} from '../public/scripts/extensions/third-party/chat-archive-pack/luker-adapter.js';

describe('luker adapter', () => {
  it('lists current character chats using getPastCharacterChats', async () => {
    const adapter = createLukerAdapter({
      characterId: 3,
      getPastCharacterChats: async () => [
        { file_name: 'main.jsonl', message_count: 2 },
        { file_name: 'branch-a.jsonl', message_count: 4 },
      ],
    });

    const chats = await adapter.listChats();

    assert.deepEqual(chats.map(chat => chat.fileName), ['main', 'branch-a']);
  });

  it('defaults extension theme preference to system for older settings', () => {
    const context = {
      extensionSettings: {
        chatArchivePack: {
          options: {
            autoUpdate: true,
          },
        },
      },
    };

    const settings = ensureExtensionSettings(context);

    assert.equal(settings.options.theme, 'system');
    assert.equal(settings.options.autoUpdate, true);
  });

  it('reads and saves character chats with the Luker chat endpoint payload shape', async () => {
    const calls = [];
    const adapter = createLukerAdapter({
      characterId: 0,
      chatId: 'main',
      characters: [{ avatar: 'bot.png', name: 'Bot' }],
      name2: 'Bot',
      getRequestHeaders: () => ({ 'x-test': 'yes' }),
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
        return {
          ok: true,
          json: async () => [{ chat_metadata: {} }, { mes: 'hi' }],
        };
      },
    });

    const chat = await adapter.getChat('main');
    const saved = await adapter.saveChat('copy', chat);

    assert.equal(saved, true);
    assert.equal(calls[0].url, '/api/chats/get');
    assert.deepEqual(calls[0].body, { ch_name: 'Bot', file_name: 'main', avatar_url: 'bot.png' });
    assert.equal(calls[1].url, '/api/chats/save');
    assert.equal(calls[1].body.force, true);
    assert.deepEqual(calls[1].body.chat, chat);
  });
});
