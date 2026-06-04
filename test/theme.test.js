import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyThemePreference,
  normalizeThemeMode,
} from '../public/scripts/extensions/third-party/chat-archive-pack/theme.js';

describe('theme preferences', () => {
  it('defaults unknown theme preferences to system', () => {
    assert.equal(normalizeThemeMode(undefined), 'system');
    assert.equal(normalizeThemeMode('solarized'), 'system');
    assert.equal(normalizeThemeMode('light'), 'light');
    assert.equal(normalizeThemeMode('dark'), 'dark');
  });

  it('writes the selected theme to the document root dataset', () => {
    const root = { dataset: {} };

    const mode = applyThemePreference('dark', root);

    assert.equal(mode, 'dark');
    assert.equal(root.dataset.chatArchivePackTheme, 'dark');
  });
});
