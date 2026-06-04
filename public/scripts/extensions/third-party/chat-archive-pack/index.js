import { getContext, registerExtensionApi } from '../../../extensions.js';

import { buildArchivePack, findNearDuplicateTexts, materializeChat, validateRoundTrip } from './archive-core.js';
import { buildChatSelectionModel, planConsolidationDelete } from './operations.js';
import { createLukerAdapter, downloadJson, ensureExtensionSettings, rememberPack, tryUploadPack } from './luker-adapter.js';

const EXTENSION_NAME = 'chat-archive-pack';
const SETTINGS_TEMPLATE = new URL('./settings.html', import.meta.url);

const state = {
  panel: null,
  selected: new Set(),
  chats: [],
  pack: null,
  timer: null,
};

function normalizeFileName(fileName) {
  return String(fileName || '').replace(/\.jsonl$/i, '');
}

function getToastr() {
  return globalThis.toastr || {
    success: console.log,
    info: console.info,
    warning: console.warn,
    error: console.error,
  };
}

function notify(type, message) {
  const toastr = getToastr();
  const fn = typeof toastr[type] === 'function' ? toastr[type] : toastr.info;
  fn.call(toastr, message, '聊天归档包');
}

async function renderSettings() {
  const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
  if (!host || document.querySelector('#chat_archive_pack_settings')) {
    return;
  }

  const html = await fetch(SETTINGS_TEMPLATE).then(response => response.text()).catch(() => '');
  if (!html) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  host.append(...wrapper.children);

  const context = getContext();
  const settings = ensureExtensionSettings(context);
  document.querySelector('#chat_archive_pack_auto_update').checked = Boolean(settings.options.autoUpdate);
  document.querySelector('#chat_archive_pack_auto_delete').checked = Boolean(settings.options.autoDelete);
  document.querySelector('#chat_archive_pack_delete_default').checked = settings.options.deleteByDefault !== false;

  document.querySelector('#chat_archive_pack_open')?.addEventListener('click', openPanel);
  for (const [id, key] of [
    ['#chat_archive_pack_auto_update', 'autoUpdate'],
    ['#chat_archive_pack_auto_delete', 'autoDelete'],
    ['#chat_archive_pack_delete_default', 'deleteByDefault'],
  ]) {
    document.querySelector(id)?.addEventListener('change', (event) => {
      settings.options[key] = Boolean(event.currentTarget.checked);
      context.saveSettingsDebounced?.();
      scheduleAutoTask();
    });
  }
}

function createPanel() {
  if (state.panel) {
    return state.panel;
  }

  const panel = document.createElement('section');
  panel.id = 'chat_archive_pack_panel';
  panel.innerHTML = `
    <div class="chat-archive-pack-panel-head">
      <div>
        <h3>聊天归档包</h3>
        <div class="chat-archive-pack-muted">当前角色卡范围内归档、释放和阅读聊天。</div>
      </div>
      <button class="menu_button" data-cap-action="close">关闭</button>
    </div>
    <div class="chat-archive-pack-grid">
      <div class="chat-archive-pack-card">
        <h4>当前角色聊天</h4>
        <div class="chat-archive-pack-actions">
          <button class="menu_button" data-cap-action="refresh">刷新</button>
          <button class="menu_button" data-cap-action="select-all">全选非当前</button>
          <button class="menu_button" data-cap-action="invert">反选</button>
          <button class="menu_button" data-cap-action="clear">取消</button>
        </div>
        <div id="chat_archive_pack_chat_list" class="chat-archive-pack-list"></div>
      </div>
      <div class="chat-archive-pack-card">
        <h4>归档包</h4>
        <label>归档包名称 <input id="chat_archive_pack_name" class="text_pole" value="聊天归档包"></label>
        <div id="chat_archive_pack_summary" class="chat-archive-pack-muted">还没有加载归档包。</div>
        <hr>
        <label>释放聊天 <select id="chat_archive_pack_release_select"></select></label>
        <button class="menu_button" data-cap-action="release">释放为 .jsonl</button>
        <button class="menu_button" data-cap-action="export">导出 JSON</button>
        <label class="menu_button">
          导入 JSON
          <input id="chat_archive_pack_import" type="file" accept="application/json" hidden>
        </label>
        <hr>
        <h4>基础阅读器</h4>
        <div id="chat_archive_pack_reader"></div>
      </div>
    </div>
    <div class="chat-archive-pack-actions">
      <label><input id="chat_archive_pack_delete_after" type="checkbox"> 收束后删除已归档的非当前 .jsonl</label>
      <div>
        <button class="menu_button" data-cap-action="archive">更新归档</button>
        <button class="menu_button" data-cap-action="consolidate">收束删除</button>
      </div>
    </div>
  `;

  panel.addEventListener('click', onPanelClick);
  panel.querySelector('#chat_archive_pack_import')?.addEventListener('change', onImportPack);
  panel.querySelector('#chat_archive_pack_release_select')?.addEventListener('change', renderReader);
  document.body.append(panel);
  state.panel = panel;
  return panel;
}

async function openPanel() {
  const panel = createPanel();
  const context = getContext();
  const settings = ensureExtensionSettings(context);
  panel.querySelector('#chat_archive_pack_delete_after').checked = settings.options.deleteByDefault !== false;
  panel.classList.add('open');
  await refreshChats();
  renderPackSummary();
}

function closePanel() {
  state.panel?.classList.remove('open');
}

async function refreshChats() {
  const adapter = createLukerAdapter(getContext());
  const chats = await adapter.listChats();
  state.chats = chats;
  const model = buildChatSelectionModel({
    chatFiles: chats.map(chat => chat.fileName),
    currentFileName: adapter.currentFileName,
  });

  const container = document.querySelector('#chat_archive_pack_chat_list');
  if (!container) {
    return;
  }

  container.innerHTML = model.map((item) => `
    <label class="chat-archive-pack-row ${item.disabled ? 'current' : ''}">
      <input type="checkbox" data-cap-chat="${item.fileName}" ${item.disabled ? 'disabled' : ''} ${state.selected.has(item.fileName) ? 'checked' : ''}>
      <span>${item.fileName}${item.disabled ? '（当前，禁选）' : ''}</span>
      <small>${chats.find(chat => chat.fileName === item.fileName)?.message_count ?? ''} 楼</small>
    </label>
  `).join('');

  container.querySelectorAll('input[data-cap-chat]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const fileName = event.currentTarget.dataset.capChat;
      if (event.currentTarget.checked) {
        state.selected.add(fileName);
      } else {
        state.selected.delete(fileName);
      }
    });
  });
}

function setSelection(mode) {
  const adapter = createLukerAdapter(getContext());
  const current = adapter.currentFileName;
  const selectable = state.chats.map(chat => chat.fileName).filter(fileName => fileName !== current);

  if (mode === 'all') {
    state.selected = new Set(selectable);
  } else if (mode === 'clear') {
    state.selected.clear();
  } else if (mode === 'invert') {
    state.selected = new Set(selectable.filter(fileName => !state.selected.has(fileName)));
  }

  refreshChats();
}

async function archiveSelected({ deleteAfter = false, requireConfirm = true } = {}) {
  const context = getContext();
  const adapter = createLukerAdapter(context);
  const selectedFileNames = [...state.selected].filter(Boolean);
  if (!selectedFileNames.length) {
    notify('warning', '请先选择至少一个非当前聊天。');
    return null;
  }

  const chats = [];
  for (const fileName of selectedFileNames) {
    chats.push({ fileName, chat: await adapter.getChat(fileName) });
  }

  const packName = document.querySelector('#chat_archive_pack_name')?.value || '聊天归档包';
  const pack = buildArchivePack({ packName, avatar: adapter.currentAvatar, chats });

  for (const entry of chats) {
    const restored = materializeChat(pack, entry.fileName);
    const result = validateRoundTrip(entry.chat, restored);
    if (!result.ok) {
      notify('error', `校验失败：${entry.fileName}，不会删除任何聊天。`);
      return null;
    }
  }

  state.pack = pack;
  rememberPack(context, pack);
  const upload = await tryUploadPack(context, pack);
  if (!upload.ok) {
    notify('warning', `归档已保存到扩展设置；文件上传不可用：${upload.reason}`);
  }

  if (deleteAfter) {
    const deletePlan = planConsolidationDelete({
      chatFiles: state.chats.map(chat => chat.fileName),
      currentFileName: adapter.currentFileName,
      selectedFileNames,
    });

    if (deletePlan.deletableFileNames.length) {
      const message = `确认删除这些非当前聊天？\n${deletePlan.deletableFileNames.join('\n')}`;
      if (!requireConfirm || window.confirm(message)) {
        for (const fileName of deletePlan.deletableFileNames) {
          await adapter.deleteChat(fileName);
        }
        notify('success', `已归档并删除 ${deletePlan.deletableFileNames.length} 个聊天。`);
      }
    }

    if (deletePlan.blocked.length) {
      notify('info', `已跳过 ${deletePlan.blocked.length} 个受保护聊天。`);
    }
  } else {
    notify('success', `已更新归档：${pack.chats.length} 个聊天。`);
  }

  renderPackSummary();
  await refreshChats();
  return pack;
}

async function releaseSelectedChat() {
  const pack = state.pack;
  const fileName = document.querySelector('#chat_archive_pack_release_select')?.value;
  if (!pack || !fileName) {
    notify('warning', '请先加载归档包并选择要释放的聊天。');
    return;
  }

  const adapter = createLukerAdapter(getContext());
  let targetFileName = normalizeFileName(fileName);
  if (await adapter.chatExists(targetFileName)) {
    const renamed = window.prompt('同名 .jsonl 已存在，请输入新的聊天文件名：', `${targetFileName}-materialized`);
    if (!renamed || await adapter.chatExists(renamed)) {
      notify('warning', '释放取消：不能覆盖已有聊天。');
      return;
    }
    targetFileName = normalizeFileName(renamed);
  }

  const chat = materializeChat(pack, fileName, { target: 'luker' });
  const ok = await adapter.saveChat(targetFileName, chat);
  notify(ok ? 'success' : 'error', ok ? `已释放：${targetFileName}.jsonl` : '释放失败。');
  await refreshChats();
}

function renderPackSummary() {
  const summary = document.querySelector('#chat_archive_pack_summary');
  const select = document.querySelector('#chat_archive_pack_release_select');
  if (!summary || !select) {
    return;
  }

  const pack = state.pack;
  if (!pack) {
    summary.textContent = '还没有加载归档包。';
    select.innerHTML = '';
    renderReader();
    return;
  }

  const nearDuplicates = findNearDuplicateTexts(pack);
  summary.textContent = `${pack.packName}：${pack.chats.length} 个聊天，${Object.keys(pack.contentBlocks).length} 个内容块，${nearDuplicates.length} 个疑似重复。`;
  select.innerHTML = pack.chats.map(chat => `<option value="${chat.fileName}">${chat.fileName} · ${chat.messageCount} 楼 · ${chat.swipeCount} swipe</option>`).join('');
  renderReader();
}

function renderReader() {
  const reader = document.querySelector('#chat_archive_pack_reader');
  const fileName = document.querySelector('#chat_archive_pack_release_select')?.value;
  if (!reader) {
    return;
  }

  const chat = state.pack?.chats?.find(item => item.fileName === fileName);
  if (!chat) {
    reader.textContent = '选择归档包内的聊天后可预览。';
    return;
  }

  reader.innerHTML = chat.floors.map((floor) => {
    const variants = floor.variants.map((variant, index) => {
      const text = state.pack.contentBlocks[variant.contentBlockId]?.text || '';
      return `<div><strong>${variant.active ? '当前' : `变体 ${index + 1}`}</strong>：${escapeHtml(text).slice(0, 500)}</div>`;
    }).join('');
    return `<div class="chat-archive-pack-reader-floor"><strong>${floor.index + 1}. ${escapeHtml(floor.name || (floor.isUser ? 'User' : 'Assistant'))}</strong>${variants}</div>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function onImportPack(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.pack = JSON.parse(await file.text());
    rememberPack(getContext(), state.pack);
    renderPackSummary();
    notify('success', '归档包已导入并绑定当前设置。');
  } catch (error) {
    notify('error', `导入失败：${error.message}`);
  } finally {
    event.currentTarget.value = '';
  }
}

async function onPanelClick(event) {
  const action = event.target?.dataset?.capAction;
  if (!action) {
    return;
  }

  if (action === 'close') closePanel();
  if (action === 'refresh') await refreshChats();
  if (action === 'select-all') setSelection('all');
  if (action === 'invert') setSelection('invert');
  if (action === 'clear') setSelection('clear');
  if (action === 'archive') await archiveSelected({ deleteAfter: false });
  if (action === 'consolidate') await archiveSelected({ deleteAfter: document.querySelector('#chat_archive_pack_delete_after')?.checked });
  if (action === 'release') await releaseSelectedChat();
  if (action === 'export') {
    if (!state.pack) {
      notify('warning', '没有可导出的归档包。');
      return;
    }
    downloadJson(state.pack);
  }
}

function scheduleAutoTask() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  const context = getContext();
  const settings = ensureExtensionSettings(context);
  if (!settings.options.autoUpdate) {
    return;
  }

  const intervalMs = Math.max(1, Number(settings.options.intervalMinutes || 30)) * 60 * 1000;
  state.timer = setInterval(async () => {
    try {
      await refreshChats();
      const adapter = createLukerAdapter(getContext());
      state.selected = new Set(state.chats.map(chat => chat.fileName).filter(fileName => fileName !== adapter.currentFileName));
      await archiveSelected({ deleteAfter: Boolean(settings.options.autoDelete), requireConfirm: false });
    } catch (error) {
      console.warn('[chat-archive-pack] auto task failed', error);
    }
  }, intervalMs);
}

function registerApi() {
  registerExtensionApi?.(EXTENSION_NAME, {
    buildArchivePack,
    materializeChat,
    archiveSelected,
    getCurrentPack: () => state.pack,
  });
}

async function init() {
  registerApi();
  await renderSettings();
  createPanel();
  scheduleAutoTask();
  console.debug('[chat-archive-pack] loaded');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
