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

function makeGroupId(index) {
  return `group-${String(index).padStart(6, '0')}`;
}

function makeRowBlockId(index) {
  return `row-${String(index).padStart(6, '0')}`;
}

function splitJsonl(jsonl) {
  const text = String(jsonl ?? '');
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /(?:\r\n|\n)$/.test(text);
  const rawLines = text.length ? text.split(/\r?\n/) : [];
  if (hasFinalNewline) {
    rawLines.pop();
  }

  return { rawLines, lineEnding, hasFinalNewline };
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
  const { rawLines, lineEnding, hasFinalNewline } = splitJsonl(jsonl);
  const lines = rawLines
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
    rawLines,
    lineEnding,
    hasFinalNewline,
    sourceWasJsonl: true,
  };
}

function parsedFromArray(chat, fileName) {
  const rows = clone(chat);
  return {
    fileName: normalizeFileName(fileName),
    header: rows[0],
    messages: rows.slice(1),
    rows,
    rawLines: rows.map(row => JSON.stringify(row)),
    lineEnding: '\n',
    hasFinalNewline: false,
    sourceWasJsonl: false,
  };
}

function getOrCreateRowBlock(ledger, rawLine) {
  const key = String(rawLine ?? '');
  if (ledger.byRawLine.has(key)) {
    return ledger.byRawLine.get(key);
  }

  const blockId = makeRowBlockId(ledger.byRawLine.size + 1);
  ledger.byRawLine.set(key, blockId);
  ledger.rowBlocks[blockId] = { id: blockId, rawLine: key };
  return blockId;
}

function buildRestoreLedger(parsedChats) {
  const ledgerIndex = { byRawLine: new Map(), rowBlocks: {} };
  const sourceFiles = parsedChats.map((parsed) => ({
    fileName: parsed.fileName,
    rowBlockIds: parsed.rawLines.map(rawLine => getOrCreateRowBlock(ledgerIndex, rawLine)),
    rawLineCount: parsed.rawLines.length,
    lineEnding: parsed.lineEnding,
    hasFinalNewline: parsed.hasFinalNewline,
    sourceWasJsonl: parsed.sourceWasJsonl,
  }));

  return {
    sourceFiles,
    rowBlocks: ledgerIndex.rowBlocks,
  };
}

function createEmptyGraph() {
  return {
    floors: [],
    paths: [],
    groupsById: {},
    pathMemory: {},
    activePathId: '',
  };
}

function getFloor(graph, index) {
  if (!graph.floors[index]) {
    graph.floors[index] = { index, groups: [] };
  }
  return graph.floors[index];
}

function getGroupSignature({ floorIndex, parentGroupId, variants }) {
  const variantKey = variants.map(variant => variant.contentBlockId).join('|');
  return `${floorIndex}::${parentGroupId || 'root'}::${variantKey}`;
}

function addChildGroup(graph, parentGroupId, childGroupId) {
  if (!parentGroupId) {
    return;
  }

  const parent = graph.groupsById[parentGroupId];
  if (parent && !parent.childGroupIds.includes(childGroupId)) {
    parent.childGroupIds.push(childGroupId);
  }
}

function buildGraph(parsedChats, contentIndex) {
  const graph = createEmptyGraph();
  const groupsBySignature = new Map();

  for (const parsed of parsedChats) {
    let parentGroupId = null;
    const groupIds = [];

    parsed.messages.forEach((message, floorIndex) => {
      const variants = getMessageVariants(message).map((variant, variantIndex) => ({
        contentBlockId: getOrCreateContentBlock(contentIndex, variant.text),
        swipeIndex: variant.swipeIndex,
        active: variant.active,
        swipeInfo: variant.swipeInfo,
        restorePayload: variant.restorePayload,
        label: variant.active ? '当前' : `变体 ${variantIndex + 1}`,
      }));
      const signature = getGroupSignature({ floorIndex, parentGroupId, variants });
      let groupId = groupsBySignature.get(signature);

      if (!groupId) {
        groupId = makeGroupId(groupsBySignature.size + 1);
        groupsBySignature.set(signature, groupId);

        const group = {
          id: groupId,
          floorIndex,
          parentGroupId,
          childGroupIds: [],
          title: '',
          summary: '',
          autoTitle: `${floorIndex + 1}.${getFloor(graph, floorIndex).groups.length + 1}`,
          name: message?.name ?? '',
          isUser: Boolean(message?.is_user),
          isSystem: Boolean(message?.is_system),
          variants,
          restorePayload: clone(message),
          sourceRefs: [],
        };

        getFloor(graph, floorIndex).groups.push(group);
        graph.groupsById[groupId] = group;
        addChildGroup(graph, parentGroupId, groupId);
      }

      graph.groupsById[groupId].sourceRefs.push({
        sourceFileName: parsed.fileName,
        floorIndex,
      });
      groupIds.push(groupId);
      parentGroupId = groupId;
    });

    const path = {
      id: `path-${parsed.fileName || graph.paths.length + 1}`,
      sourceFileName: parsed.fileName,
      title: parsed.fileName || `路径 ${graph.paths.length + 1}`,
      groupIds,
      active: graph.paths.length === 0,
    };
    graph.paths.push(path);
    if (!graph.activePathId) {
      graph.activePathId = path.id;
    }
  }

  graph.floors = graph.floors.filter(Boolean);
  return graph;
}

function getGraphGroups(graph) {
  return Object.values(graph?.groupsById || {});
}

function calculateCommonPrefixFloors(graph) {
  const paths = graph?.paths || [];
  if (!paths.length) {
    return 0;
  }

  const minLength = Math.min(...paths.map(path => path.groupIds.length));
  let count = 0;
  for (let index = 0; index < minLength; index++) {
    const first = paths[0].groupIds[index];
    if (paths.every(path => path.groupIds[index] === first)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function countSameTextDifferentContext(graph) {
  const contentGroups = new Map();
  for (const group of getGraphGroups(graph)) {
    for (const variant of group.variants || []) {
      if (!contentGroups.has(variant.contentBlockId)) {
        contentGroups.set(variant.contentBlockId, new Set());
      }
      contentGroups.get(variant.contentBlockId).add(group.id);
    }
  }

  return [...contentGroups.values()].filter(groupIds => groupIds.size > 1).length;
}

function countSharedContentBlocks(graph) {
  const contentUseCount = new Map();
  for (const group of getGraphGroups(graph)) {
    for (const variant of group.variants || []) {
      contentUseCount.set(variant.contentBlockId, (contentUseCount.get(variant.contentBlockId) || 0) + 1);
    }
  }

  return [...contentUseCount.values()].filter(count => count > 1).length;
}

function buildMergePreview(pack) {
  const sourceFiles = pack.restoreLedger?.sourceFiles || [];
  const graphGroups = getGraphGroups(pack.graph);
  return {
    sourceFileCount: sourceFiles.length,
    pathCount: pack.graph?.paths?.length || 0,
    rawLineCount: sourceFiles.reduce((sum, source) => sum + source.rawLineCount, 0),
    restoreLedgerOk: sourceFiles.every(source => source.rowBlockIds.length === source.rawLineCount),
    graphGroupCount: graphGroups.length,
    contentBlockCount: Object.keys(pack.contentBlocks || {}).length,
    sharedContentBlockCount: countSharedContentBlocks(pack.graph),
    sameTextDifferentContextCount: countSameTextDifferentContext(pack.graph),
    commonPrefixFloors: calculateCommonPrefixFloors(pack.graph),
    nearDuplicateCount: findNearDuplicateTexts(pack).length,
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
  const parsedChats = chats.map((entry) => Array.isArray(entry.chat)
    ? parsedFromArray(entry.chat, entry.fileName)
    : parseJsonlChat(entry.jsonl, { fileName: entry.fileName }));

  const packedChats = parsedChats.map((parsed) => {
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

  const graph = buildGraph(parsedChats, contentIndex);
  const restoreLedger = buildRestoreLedger(parsedChats);

  const pack = {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    packId: makeId('pack'),
    packName,
    createdAt: timestamp,
    updatedAt: timestamp,
    bindings: avatar ? [{ avatar }] : [],
    contentBlocks: contentIndex.blocks,
    graph,
    restoreLedger,
    chats: packedChats,
  };

  pack.mergePreview = buildMergePreview(pack);
  return pack;
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

export function materializeOriginalJsonl(pack, fileName) {
  const materializeFileName = normalizeFileName(fileName);
  const source = pack?.restoreLedger?.sourceFiles?.find(entry => normalizeFileName(entry.fileName) === materializeFileName);
  if (!source) {
    throw new Error(`Original JSONL not found in restore ledger: ${materializeFileName}`);
  }

  const rowBlocks = pack.restoreLedger?.rowBlocks || {};
  const rawLines = source.rowBlockIds.map((blockId) => {
    if (!rowBlocks[blockId]) {
      throw new Error(`Restore row block missing: ${blockId}`);
    }
    return rowBlocks[blockId].rawLine;
  });
  const text = rawLines.join(source.lineEnding || '\n');
  return source.hasFinalNewline ? `${text}${source.lineEnding || '\n'}` : text;
}

export function materializePathChat(pack, pathId, { target = 'archive' } = {}) {
  const path = pack?.graph?.paths?.find(entry => entry.id === pathId || entry.sourceFileName === normalizeFileName(pathId));
  if (!path) {
    throw new Error(`Path not found in archive graph: ${pathId}`);
  }

  const sourceChat = pack?.chats?.find(entry => normalizeFileName(entry.fileName) === normalizeFileName(path.sourceFileName));
  const header = clone(sourceChat?.header || {});
  const messages = path.groupIds.map((groupId) => {
    const group = pack.graph.groupsById[groupId];
    if (!group) {
      throw new Error(`Graph group not found: ${groupId}`);
    }

    const activeVariant = group.variants.find(variant => variant.active) || group.variants[0];
    return clone(activeVariant?.restorePayload || group.restorePayload);
  });
  const rows = [header, ...messages];

  return target === 'luker'
    ? rows.map((row, index) => index === 0 ? row : downgradeUserSwipeForLuker(row))
    : rows;
}

function getFirstChildGroupId(pack, parentGroupId) {
  const parent = pack?.graph?.groupsById?.[parentGroupId];
  return parent?.childGroupIds?.[0] || null;
}

export function switchPathGroup(pack, currentGroupIds = [], floorIndex, nextGroupId, pathMemory = {}) {
  if (!pack?.graph?.groupsById?.[nextGroupId]) {
    throw new Error(`Graph group not found: ${nextGroupId}`);
  }

  const groupIds = currentGroupIds.slice(0, floorIndex);
  groupIds[floorIndex] = nextGroupId;

  let current = nextGroupId;
  for (let index = floorIndex + 1; index < (pack.graph.floors?.length || 0); index++) {
    const oldGroupId = currentGroupIds[index];
    const oldGroup = oldGroupId ? pack.graph.groupsById[oldGroupId] : null;
    if (oldGroup?.parentGroupId === current) {
      groupIds[index] = oldGroupId;
      current = oldGroupId;
      continue;
    }

    const remembered = pathMemory[current];
    const rememberedGroup = remembered ? pack.graph.groupsById[remembered] : null;
    const nextChild = rememberedGroup?.parentGroupId === current
      ? remembered
      : getFirstChildGroupId(pack, current);

    if (!nextChild) {
      break;
    }

    groupIds[index] = nextChild;
    current = nextChild;
  }

  return { groupIds, changedAtFloor: floorIndex };
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
