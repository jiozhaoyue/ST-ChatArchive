import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXTENSIONS_STUB = resolve('public/scripts/extensions.js');
const ENTRYPOINT = resolve('public/scripts/extensions/third-party/chat-archive-pack/index.js');

let previousStub = null;
let hadPreviousStub = false;

function createElementStub() {
  return {
    id: '',
    innerHTML: '',
    checked: false,
    value: '',
    classList: { add() {}, remove() {} },
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
}

describe('extension entrypoint', () => {
  beforeEach(async () => {
    hadPreviousStub = existsSync(EXTENSIONS_STUB);
    previousStub = hadPreviousStub ? await fs.readFile(EXTENSIONS_STUB, 'utf8') : null;
    await fs.mkdir(dirname(EXTENSIONS_STUB), { recursive: true });
    await fs.writeFile(EXTENSIONS_STUB, `
export function getContext() {
  return globalThis.__chatArchivePackTestContext;
}
`, 'utf8');

    globalThis.document = {
      readyState: 'complete',
      body: { append() {} },
      createElement: createElementStub,
      querySelector() {
        return null;
      },
    };
  });

  afterEach(async () => {
    delete globalThis.document;
    delete globalThis.__chatArchivePackTestContext;

    if (hadPreviousStub) {
      await fs.writeFile(EXTENSIONS_STUB, previousStub, 'utf8');
    } else {
      await fs.rm(EXTENSIONS_STUB, { force: true });
    }
  });

  it('loads when registerExtensionApi is provided by context instead of extensions.js', async () => {
    const registrations = [];
    globalThis.__chatArchivePackTestContext = {
      extensionSettings: {},
      registerExtensionApi(name, api) {
        registrations.push({ name, api });
      },
    };

    await import(`${pathToFileURL(ENTRYPOINT).href}?entrypoint-test=${Date.now()}`);

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].name, 'chat-archive-pack');
    assert.equal(typeof registrations[0].api.buildArchivePack, 'function');
  });
});
