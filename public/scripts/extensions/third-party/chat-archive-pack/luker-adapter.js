const EXTENSION_KEY = 'chatArchivePack';

function normalizeFileName(fileName) {
  return String(fileName || '').replace(/\.jsonl$/i, '');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getCharacter(context) {
  const characterId = context?.characterId;
  return context?.characters?.[characterId] || null;
}

function getCharacterName(context) {
  const character = getCharacter(context);
  return String(character?.name || context?.name2 || character?.data?.name || '').trim();
}

function getHeaders(context) {
  return typeof context?.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
}

function normalizeChatListItem(item) {
  const fileName = normalizeFileName(item?.file_name || item?.fileName || item);
  return {
    ...item,
    fileName,
    file_name: item?.file_name || `${fileName}.jsonl`,
  };
}

export function ensureExtensionSettings(context) {
  const root = context.extensionSettings || {};
  if (!root[EXTENSION_KEY]) {
    root[EXTENSION_KEY] = {};
  }

  const settings = root[EXTENSION_KEY];
  settings.packs ||= {};
  settings.bindings ||= {};
  settings.options ||= {
    autoUpdate: false,
    autoDelete: false,
    deleteByDefault: true,
    intervalMinutes: 30,
  };

  return settings;
}

export function saveExtensionSettings(context) {
  if (typeof context?.saveSettingsDebounced === 'function') {
    context.saveSettingsDebounced();
  }
}

export function rememberPack(context, pack) {
  const settings = ensureExtensionSettings(context);
  const packSummary = {
    packId: pack.packId,
    packName: pack.packName,
    updatedAt: pack.updatedAt,
    chatCount: Array.isArray(pack.chats) ? pack.chats.length : 0,
  };
  settings.packs[pack.packId] = {
    ...packSummary,
    // Store the latest pack JSON as a recovery fallback. Large installs can replace this with file upload.
    inlinePack: clone(pack),
  };

  const avatar = pack.bindings?.[0]?.avatar;
  if (avatar) {
    settings.bindings[avatar] = pack.packId;
  }

  saveExtensionSettings(context);
  return packSummary;
}

export function createLukerAdapter(context = {}) {
  const fetchImpl = context.fetchImpl || globalThis.fetch?.bind(globalThis);

  function requireCharacter() {
    const character = getCharacter(context);
    if (!character?.avatar) {
      throw new Error('No current character is selected');
    }
    return character;
  }

  return {
    get currentFileName() {
      return normalizeFileName(context.chatId || getCharacter(context)?.chat || '');
    },

    get currentAvatar() {
      return getCharacter(context)?.avatar || '';
    },

    async listChats() {
      if (typeof context.getPastCharacterChats !== 'function') {
        return [];
      }

      const rows = await context.getPastCharacterChats(context.characterId);
      return Array.isArray(rows) ? rows.map(normalizeChatListItem) : [];
    },

    async getChat(fileName) {
      const character = requireCharacter();
      const response = await fetchImpl('/api/chats/get', {
        method: 'POST',
        headers: getHeaders(context),
        cache: 'no-cache',
        body: JSON.stringify({
          ch_name: getCharacterName(context),
          file_name: normalizeFileName(fileName),
          avatar_url: character.avatar,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to read chat: ${fileName}`);
      }

      const chat = await response.json();
      if (!Array.isArray(chat)) {
        throw new Error(`Chat payload is not an array: ${fileName}`);
      }

      return chat;
    },

    async saveChat(fileName, chat, { force = true } = {}) {
      const character = requireCharacter();
      const response = await fetchImpl('/api/chats/save', {
        method: 'POST',
        headers: getHeaders(context),
        cache: 'no-cache',
        body: JSON.stringify({
          ch_name: getCharacterName(context),
          file_name: normalizeFileName(fileName),
          chat: clone(chat),
          avatar_url: character.avatar,
          force,
        }),
      });

      return response.ok;
    },

    async deleteChat(fileName) {
      if (typeof context.deleteCharacterChat === 'function') {
        return Boolean(await context.deleteCharacterChat(normalizeFileName(fileName)));
      }

      const character = requireCharacter();
      const response = await fetchImpl('/api/chats/delete', {
        method: 'POST',
        headers: getHeaders(context),
        body: JSON.stringify({
          chatfile: `${normalizeFileName(fileName)}.jsonl`,
          avatar_url: character.avatar,
        }),
      });
      return response.ok;
    },

    async chatExists(fileName) {
      const chats = await this.listChats();
      return chats.some(chat => normalizeFileName(chat.fileName) === normalizeFileName(fileName));
    },
  };
}

export function downloadJson(pack, fileName = `${pack.packId}.json`) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function tryUploadPack(context, pack) {
  const fetchImpl = context.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    return { ok: false, reason: 'upload-api-unavailable' };
  }

  const fileName = `${pack.packId}.json`;
  const form = new FormData();
  form.append('path', 'chat-archive-pack');
  form.append('file', new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }), fileName);

  const headers = { ...getHeaders(context) };
  delete headers['content-type'];
  delete headers['Content-Type'];

  const response = await fetchImpl('/api/files/upload', {
    method: 'POST',
    headers,
    body: form,
  }).catch(error => ({ ok: false, error }));

  return response.ok
    ? { ok: true, fileName, path: `chat-archive-pack/${fileName}` }
    : { ok: false, reason: response.error ? String(response.error) : 'upload-failed' };
}
