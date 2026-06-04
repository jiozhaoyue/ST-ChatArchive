function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeFileName(fileName) {
  return String(fileName || '').replace(/\.jsonl$/i, '');
}

function sameFile(left, right) {
  return normalizeFileName(left) === normalizeFileName(right);
}

export function buildChatSelectionModel({ chatFiles = [], currentFileName = '' } = {}) {
  return chatFiles.map((fileName) => {
    const isCurrent = sameFile(fileName, currentFileName);
    return {
      fileName: normalizeFileName(fileName),
      disabled: isCurrent,
      reason: isCurrent ? 'current-chat' : '',
      selected: false,
    };
  });
}

export function planConsolidationDelete({
  chatFiles = [],
  currentFileName = '',
  selectedFileNames = [],
} = {}) {
  const knownFiles = chatFiles.map(normalizeFileName);
  const selected = new Set(selectedFileNames.map(normalizeFileName));
  const blocked = [];
  const deletableFileNames = [];

  for (const fileName of knownFiles) {
    if (!selected.has(fileName)) {
      continue;
    }

    if (sameFile(fileName, currentFileName)) {
      blocked.push({ fileName, reason: 'current-chat' });
      continue;
    }

    const remainingCount = knownFiles.filter(candidate => !sameFile(candidate, fileName)).length;
    if (remainingCount < 1) {
      blocked.push({ fileName, reason: 'last-chat' });
      continue;
    }

    deletableFileNames.push(fileName);
  }

  if (knownFiles.length <= 1 && selected.size) {
    for (const fileName of knownFiles) {
      if (!blocked.some(item => sameFile(item.fileName, fileName) && item.reason === 'last-chat')) {
        blocked.push({ fileName, reason: 'last-chat' });
      }
    }
  }

  return { deletableFileNames, blocked };
}

function rewriteBranchReference(value, oldFileName, newFileName) {
  if (typeof value === 'string') {
    return sameFile(value, oldFileName) ? newFileName : value;
  }

  if (Array.isArray(value)) {
    return value.map(item => rewriteBranchReference(item, oldFileName, newFileName));
  }

  if (value && typeof value === 'object') {
    const next = { ...value };
    for (const key of ['chat', 'file_name', 'chat_file', 'fileName']) {
      if (sameFile(next[key], oldFileName)) {
        next[key] = newFileName;
      }
    }
    return next;
  }

  return value;
}

export function rewriteChatReferences(chatRows, { oldFileName, newFileName } = {}) {
  const oldName = normalizeFileName(oldFileName);
  const newName = normalizeFileName(newFileName);
  const rows = clone(chatRows);

  if (!oldName || !newName || !Array.isArray(rows)) {
    return rows;
  }

  const header = rows[0];
  if (header?.chat_metadata && sameFile(header.chat_metadata.main_chat, oldName)) {
    header.chat_metadata.main_chat = newName;
  }

  for (const message of rows.slice(1)) {
    if (!message?.extra) {
      continue;
    }

    if (sameFile(message.extra.bookmark_link, oldName)) {
      message.extra.bookmark_link = newName;
    }

    if ('branches' in message.extra) {
      message.extra.branches = rewriteBranchReference(message.extra.branches, oldName, newName);
    }
  }

  return rows;
}
