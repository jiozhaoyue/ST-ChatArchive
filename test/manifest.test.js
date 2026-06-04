import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const MANIFEST_PATHS = [
  'manifest.json',
  'public/scripts/extensions/third-party/chat-archive-pack/manifest.json',
];

async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('extension manifest', () => {
  it('declares a valid homePage URL for SillyTavern origin links', async () => {
    const manifests = await Promise.all(MANIFEST_PATHS.map(readManifest));

    for (const manifest of manifests) {
      assert.equal(typeof manifest.homePage, 'string');
      assert.doesNotThrow(() => new URL(manifest.homePage));
    }

    assert.equal(manifests[0].homePage, manifests[1].homePage);
  });
});
