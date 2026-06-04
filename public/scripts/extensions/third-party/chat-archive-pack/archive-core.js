const DEFAULT_SCHEMA_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeFileName(fileName) {
  return String(fileName || '').replace(/\.jsonl$/i, '');
}

function textKey(text) {
  return String(text ?? '');
}

function makeContentBlockId(index) {
  return `content-${String(index).padStart(6, '0')}`;
}

function getMessageVariants(message) {
  const swipes = Array.isArray(message?.swipes) ? message.swipes : null;
  if (swipes?.length) {
    return swipes.map((text, index) => ({
      text: textKey(text),
      swipeIndex: index,
      active: Number(message.swipe_id || 0) === index,
      swipeInfo: clone(Array.isArray(message.swipe_info) ? message.swipe_info[index] : undefined),
      restorePayload: clone(message),
    }));
  }

  return [{
    text: textKey(message?.mes),
    swipeIndex: null,
    active: true,
    swipeInfo: undefined,
    restorePayload: clone(message),
  }];
}

function getOrCreateContentBlock(contentIndex, text) {
  const key = textKey(text);
  if (contentIndex.byText.has(key)) {
    return contentIndex.byText.get(key);
  }

  const blockId = makeContentBlockId(contentIndex.byText.size + 1);
  const block = { id: blockId, text: key };
  contentIndex.byText.set(key, blockId);
  contentIndex.blocks[blockId] = block;
  return blockId;
}

function normalizeNearText(text) {
  return textKey(text)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?，。！？;；:：'"“”‘’`~\-—_()[\]{}<>《》]/g, '')
    .trim()
    .toLowerCase();
}

function downgradeUserSwipeForLuker(message) {
  if (!message?.is_user || !Array.isArray(message.swipes) || !message.swipes.length) {
    return message;
  }

  const next = clone(message);
  const swipeIndex = Number.isInteger(next.swipe_id) ? next.swipe_id : Number(next.swipe_id || 0);
  const safeIndex = swipeIndex >= 0 && swipeIndex < next.swipes.length ? swipeIndex : 0;
  next.mes = textKey(next.swipes[safeIndex]);
  delete next.swipes;
  delete next.swipe_id;
  delete next.swipe_info;
  return next;
}

export function parseJsonlChat(jsonl, { fileName = '' } = {}) {
  const lines = String(jsonl || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error('Chat JSONL is empty');
  }

  const rows = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });

  return {
    fileName: normalizeFileName(fileName),
    header: rows[0],
    messages: rows.slice(1),
    rows,
  };
}

export function buildArchivePack({
  packName = 'Chat Archive Pack',
  avatar = '',
  chats = [],
  now = () => new Date().toISOString(),
  makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
} = {}) {
  const timestamp = now();
  const contentIndex = { byText: new Map(), blocks: {} };

  const packedChats = chats.map((entry) => {
    const parsed = Array.isArray(entry.chat)
      ? { fileName: normalizeFileName(entry.fileName), header: entry.chat[0], messages: entry.chat.slice(1), rows: entry.chat }
      : parseJsonlChat(entry.jsonl, { fileName: entry.fileName });

    const floors = parsed.messages.map((message, index) => {
      const variants = getMessageVariants(message).map((variant) => ({
        contentBlockId: getOrCreateContentBlock(contentIndex, variant.text),
        swipeIndex: variant.swipeIndex,
        active: variant.active,
        swipeInfo: variant.swipeInfo,
        restorePayload: variant.restorePayload,
      }));

      return {
        index,
        name: message?.name ?? '',
        isUser: Boolean(message?.is_user),
        isSystem: Boolean(message?.is_system),
        variants,
        restorePayload: clone(message),
      };
    });

    return {
      fileName: parsed.fileName,
      header: clone(parsed.header),
      floors,
      restorePayload: clone(parsed.rows),
      messageCount: parsed.messages.length,
      swipeCount: floors.reduce((sum, floor) => sum + Math.max(0, floor.variants.length - 1), 0),
    };
  });

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    packId: makeId('pack'),
    packName,
    createdAt: timestamp,
    updatedAt: timestamp,
    bindings: avatar ? [{ avatar }] : [],
    contentBlocks: contentIndex.blocks,
    chats: packedChats,
  };
}

export function materializeChat(pack, fileName, { target = 'archive' } = {}) {
  const materializeFileName = normalizeFileName(fileName);
  const chat = pack?.chats?.find(entry => normalizeFileName(entry.fileName) === materializeFileName);
  if (!chat) {
    throw new Error(`Chat not found in archive pack: ${materializeFileName}`);
  }

  const rows = clone(chat.restorePayload);
  if (target !== 'luker') {
    return rows;
  }

  return rows.map((row, index) => index === 0 ? row : downgradeUserSwipeForLuker(row));
}

export function validateRoundTrip(originalChat, materializedChat) {
  const expected = JSON.stringify(originalChat);
  const actual = JSON.stringify(materializedChat);

  return {
    ok: expected === actual,
    reason: expected === actual ? '' : 'materialized chat differs from original payload',
  };
}

export function findNearDuplicateTexts(pack) {
  const blocks = Object.values(pack?.contentBlocks || {});
  const candidates = [];

  for (let leftIndex = 0; leftIndex < blocks.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex++) {
      const left = blocks[leftIndex];
      const right = blocks[rightIndex];
      if (left.text === right.text) {
        continue;
      }

      const leftNormalized = normalizeNearText(left.text);
      const rightNormalized = normalizeNearText(right.text);
      if (leftNormalized && leftNormalized === rightNormalized) {
        candidates.push({
          leftContentBlockId: left.id,
          rightContentBlockId: right.id,
          leftText: left.text,
          rightText: right.text,
          reason: 'normalized-text-match',
        });
      }
    }
  }

  return candidates;
}
