import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildChatSelectionModel,
  planConsolidationDelete,
  rewriteChatReferences,
} from '../src/operations.js';

describe('archive operations', () => {
  it('shows the current chat but disables it for consolidation selection', () => {
    const model = buildChatSelectionModel({
      chatFiles: ['main', 'branch-a', 'branch-b'],
      currentFileName: 'main',
    });

    assert.equal(model.length, 3);
    assert.equal(model[0].fileName, 'main');
    assert.equal(model[0].disabled, true);
    assert.equal(model[0].reason, 'current-chat');
    assert.equal(model[1].disabled, false);
  });

  it('never plans deletion for the current chat or the last remaining chat', () => {
    const plan = planConsolidationDelete({
      chatFiles: ['main', 'branch-a'],
      currentFileName: 'main',
      selectedFileNames: ['main', 'branch-a'],
    });

    assert.deepEqual(plan.deletableFileNames, ['branch-a']);
    assert.equal(plan.blocked.some(item => item.fileName === 'main' && item.reason === 'current-chat'), true);

    const lastOnly = planConsolidationDelete({
      chatFiles: ['main'],
      currentFileName: 'main',
      selectedFileNames: ['main'],
    });

    assert.deepEqual(lastOnly.deletableFileNames, []);
    assert.equal(lastOnly.blocked.some(item => item.reason === 'last-chat'), true);
  });

  it('rewrites known checkpoint and branch references without touching unrelated fields', () => {
    const chat = [
      { chat_metadata: { main_chat: 'old-name', note: 'old-name should remain here' } },
      { mes: 'one', extra: { bookmark_link: 'old-name', branches: ['old-name', 'other'] } },
      { mes: 'two', extra: { branches: [{ chat: 'old-name' }, { file_name: 'old-name' }, { name: 'old-name' }] } },
    ];

    const rewritten = rewriteChatReferences(chat, { oldFileName: 'old-name', newFileName: 'new-name' });

    assert.equal(rewritten[0].chat_metadata.main_chat, 'new-name');
    assert.equal(rewritten[0].chat_metadata.note, 'old-name should remain here');
    assert.equal(rewritten[1].extra.bookmark_link, 'new-name');
    assert.deepEqual(rewritten[1].extra.branches, ['new-name', 'other']);
    assert.equal(rewritten[2].extra.branches[0].chat, 'new-name');
    assert.equal(rewritten[2].extra.branches[1].file_name, 'new-name');
    assert.equal(rewritten[2].extra.branches[2].name, 'old-name');
  });
});
