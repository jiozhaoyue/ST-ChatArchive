import {
  buildArchivePack,
  findNearDuplicateTexts,
  materializeChat,
  materializeOriginalJsonl,
  materializePathChat,
  validateRoundTrip,
} from './archive-core.js';
import { buildChatSelectionModel, planConsolidationDelete } from './operations.js';
import { createLukerAdapter, downloadJson, ensureExtensionSettings, rememberPack, tryUploadPack } from './luker-adapter.js';
import { applyThemePreference } from './theme.js';

const EXTENSION_NAME = 'chat-archive-pack';
let getContext = null;
let SETTINGS_TEMPLATE = null;

const state = {
  panel: null,
  activeTab: 'manager',
  selected: new Set(),
  chats: [],
  pack: null,
  pendingPack: null,
  releaseLog: [],
  graphView: 'skeleton',
  graphLayout: 'down',
  graphEditMode: false,
  currentPathId: '',
  selectedGroupId: '',
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
  document.querySelector('#chat_archive_pack_theme').value = applyThemePreference(settings.options.theme);

  document.querySelector('#chat_archive_pack_open')?.addEventListener('click', openPanel);
  document.querySelector('#chat_archive_pack_theme')?.addEventListener('change', (event) => {
    settings.options.theme = applyThemePreference(event.currentTarget.value);
    context.saveSettingsDebounced?.();
  });

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
        <div class="chat-archive-pack-muted">管理原生 jsonl，生成归档 JSON，并查看归档内的剧情结构。</div>
      </div>
      <div class="chat-archive-pack-head-actions">
        <button class="menu_button" data-cap-action="refresh">刷新</button>
        <button class="menu_button" data-cap-action="close">关闭</button>
      </div>
    </div>

    <nav class="chat-archive-pack-tabs" aria-label="聊天归档包面板">
      <button class="menu_button" data-cap-tab="manager">归档管理</button>
      <button class="menu_button" data-cap-tab="graph">结构图</button>
      <button class="menu_button" data-cap-tab="duplicates">重复候选</button>
      <button class="menu_button" data-cap-tab="releases">释放记录</button>
    </nav>

    <div class="chat-archive-pack-tab-body">
      <section class="chat-archive-pack-tab-panel" data-cap-panel="manager">
        <div class="chat-archive-pack-manager-grid">
          <div class="chat-archive-pack-pane">
            <div class="chat-archive-pack-pane-head">
              <h4>当前角色 jsonl</h4>
              <div class="chat-archive-pack-actions compact">
                <button class="menu_button" data-cap-action="select-all">全选非当前</button>
                <button class="menu_button" data-cap-action="invert">反选</button>
                <button class="menu_button" data-cap-action="clear">取消</button>
              </div>
            </div>
            <div id="chat_archive_pack_chat_list" class="chat-archive-pack-list"></div>
          </div>

          <div class="chat-archive-pack-pane">
            <div class="chat-archive-pack-pane-head">
              <h4>归档包</h4>
              <label class="menu_button">
                导入 JSON
                <input id="chat_archive_pack_import" type="file" accept="application/json" hidden>
              </label>
            </div>
            <label class="chat-archive-pack-field">归档包名称 <input id="chat_archive_pack_name" class="text_pole" value="聊天归档包"></label>
            <div id="chat_archive_pack_pack_list" class="chat-archive-pack-list"></div>
          </div>

          <div class="chat-archive-pack-pane">
            <div class="chat-archive-pack-pane-head">
              <h4>合并预览</h4>
              <button class="menu_button" data-cap-action="preview-merge">生成预览</button>
            </div>
            <div id="chat_archive_pack_summary" class="chat-archive-pack-summary">还没有加载归档包。</div>
            <div id="chat_archive_pack_merge_preview" class="chat-archive-pack-preview">选择 jsonl 后生成审查预览。</div>
            <div class="chat-archive-pack-actions stack">
              <button class="menu_button" data-cap-action="confirm-merge">确认写入归档</button>
              <label><input id="chat_archive_pack_delete_after" type="checkbox"> 收束后删除已归档的非当前 .jsonl</label>
              <button class="menu_button" data-cap-action="consolidate">确认归档并收束删除</button>
            </div>
          </div>
        </div>

      </section>

      <section class="chat-archive-pack-tab-panel" data-cap-panel="graph">
        <div class="chat-archive-pack-graph-toolbar">
          <label>路径 <select id="chat_archive_pack_path_select"></select></label>
          <label>视图 <select id="chat_archive_pack_graph_view">
            <option value="skeleton">骨架视图</option>
            <option value="path">路径视图</option>
            <option value="full">全图视图</option>
          </select></label>
          <label>展开 <select id="chat_archive_pack_graph_layout">
            <option value="down">向下</option>
            <option value="right">向右</option>
          </select></label>
          <label><input id="chat_archive_pack_edit_mode" type="checkbox"> 编辑模式</label>
        </div>
        <div class="chat-archive-pack-graph-grid">
          <div id="chat_archive_pack_path_list" class="chat-archive-pack-pane"></div>
          <div id="chat_archive_pack_graph_canvas" class="chat-archive-pack-graph-canvas"></div>
          <div id="chat_archive_pack_inspector" class="chat-archive-pack-pane"></div>
        </div>
      </section>

      <section class="chat-archive-pack-tab-panel" data-cap-panel="duplicates">
        <div id="chat_archive_pack_duplicates" class="chat-archive-pack-pane"></div>
      </section>

      <section class="chat-archive-pack-tab-panel" data-cap-panel="releases">
        <div class="chat-archive-pack-release-grid">
          <div class="chat-archive-pack-pane">
            <h4>释放</h4>
            <label>原文件 <select id="chat_archive_pack_original_release_select"></select></label>
            <button class="menu_button" data-cap-action="release-original">无损释放原文件</button>
            <button class="menu_button" data-cap-action="release-path">释放当前路径</button>
          </div>
          <div id="chat_archive_pack_release_log" class="chat-archive-pack-pane"></div>
        </div>
      </section>
    </div>

    <div class="chat-archive-pack-statusbar">
      <div id="chat_archive_pack_status">未加载归档包。</div>
      <div class="chat-archive-pack-actions compact">
        <button class="menu_button" data-cap-action="open-graph">打开结构图</button>
        <button class="menu_button" data-cap-action="export">导出 JSON</button>
        <button class="menu_button" data-cap-action="release-path">释放当前路径</button>
      </div>
    </div>
  `;

  panel.addEventListener('click', onPanelClick);
  panel.querySelector('#chat_archive_pack_import')?.addEventListener('change', onImportPack);
  panel.querySelector('#chat_archive_pack_path_select')?.addEventListener('change', (event) => {
    state.currentPathId = event.currentTarget.value;
    renderGraphWorkspace();
    renderStatusBar();
  });
  panel.querySelector('#chat_archive_pack_graph_view')?.addEventListener('change', (event) => {
    state.graphView = event.currentTarget.value;
    renderGraphWorkspace();
  });
  panel.querySelector('#chat_archive_pack_graph_layout')?.addEventListener('change', (event) => {
    state.graphLayout = event.currentTarget.value;
    renderGraphWorkspace();
  });
  panel.querySelector('#chat_archive_pack_edit_mode')?.addEventListener('change', (event) => {
    state.graphEditMode = Boolean(event.currentTarget.checked);
    renderGraphWorkspace();
  });
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
  renderWorkbench();
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

async function readSelectedChats(adapter) {
  const selectedFileNames = [...state.selected].filter(Boolean);
  if (!selectedFileNames.length) {
    notify('warning', '请先选择至少一个非当前聊天。');
    return null;
  }

  const chats = [];
  for (const fileName of selectedFileNames) {
    chats.push({ fileName, chat: await adapter.getChat(fileName) });
  }
  return { selectedFileNames, chats };
}

function validatePackSources(pack, chats) {
  for (const entry of chats) {
    const restored = materializeChat(pack, entry.fileName);
    const result = validateRoundTrip(entry.chat, restored);
    if (!result.ok) {
      notify('error', `校验失败：${entry.fileName}，不会删除任何聊天。`);
      return false;
    }
  }
  return true;
}

async function previewSelectedArchive() {
  const adapter = createLukerAdapter(getContext());
  const selection = await readSelectedChats(adapter);
  if (!selection) {
    return null;
  }

  const packName = document.querySelector('#chat_archive_pack_name')?.value || '聊天归档包';
  const pack = buildArchivePack({ packName, avatar: adapter.currentAvatar, chats: selection.chats });
  if (!validatePackSources(pack, selection.chats)) {
    return null;
  }

  state.pendingPack = pack;
  notify('info', `已生成合并预览：${pack.graph.paths.length} 条路径。`);
  renderWorkbench();
  return pack;
}

async function commitPendingArchive({ deleteAfter = false, requireConfirm = true } = {}) {
  if (!state.pendingPack) {
    const preview = await previewSelectedArchive();
    if (!preview) {
      return null;
    }
  }

  const context = getContext();
  const adapter = createLukerAdapter(context);
  const selectedFileNames = [...state.selected].filter(Boolean);
  const pack = state.pendingPack;
  state.pack = pack;
  state.pendingPack = null;
  state.currentPathId = pack.graph?.activePathId || pack.graph?.paths?.[0]?.id || '';
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
    notify('success', `已写入归档：${pack.graph.paths.length} 条路径。`);
  }

  renderWorkbench();
  await refreshChats();
  return pack;
}

async function archiveSelected({ deleteAfter = false, requireConfirm = true } = {}) {
  const context = getContext();
  const adapter = createLukerAdapter(context);
  const selection = await readSelectedChats(adapter);
  if (!selection) {
    return null;
  }

  const packName = document.querySelector('#chat_archive_pack_name')?.value || '聊天归档包';
  const pack = buildArchivePack({ packName, avatar: adapter.currentAvatar, chats: selection.chats });

  if (!validatePackSources(pack, selection.chats)) {
    return null;
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
      selectedFileNames: selection.selectedFileNames,
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

  renderWorkbench();
  await refreshChats();
  return pack;
}

async function releasePathChat() {
  const pack = state.pack;
  const pathId = state.currentPathId || pack?.graph?.activePathId;
  if (!pack || !pathId) {
    notify('warning', '请先加载归档包并选择要释放的路径。');
    return;
  }

  const adapter = createLukerAdapter(getContext());
  const path = pack.graph?.paths?.find(item => item.id === pathId) || pack.graph?.paths?.[0];
  let targetFileName = normalizeFileName(`${path?.sourceFileName || 'archive-path'}-materialized`);
  if (await adapter.chatExists(targetFileName)) {
    const renamed = window.prompt('同名 .jsonl 已存在，请输入新的聊天文件名：', `${targetFileName}-materialized`);
    if (!renamed || await adapter.chatExists(renamed)) {
      notify('warning', '释放取消：不能覆盖已有聊天。');
      return;
    }
    targetFileName = normalizeFileName(renamed);
  }

  const chat = materializePathChat(pack, pathId, { target: 'luker' });
  const ok = await adapter.saveChat(targetFileName, chat);
  state.releaseLog.unshift({
    type: 'path',
    fileName: targetFileName,
    at: new Date().toLocaleString(),
    ok,
  });
  notify(ok ? 'success' : 'error', ok ? `已释放路径：${targetFileName}.jsonl` : '释放失败。');
  renderWorkbench();
  await refreshChats();
}

async function releaseOriginalChat() {
  const pack = state.pack;
  const fileName = document.querySelector('#chat_archive_pack_original_release_select')?.value;
  if (!pack || !fileName) {
    notify('warning', '请先加载归档包并选择原文件。');
    return;
  }

  const adapter = createLukerAdapter(getContext());
  let targetFileName = normalizeFileName(fileName);
  if (await adapter.chatExists(targetFileName)) {
    const renamed = window.prompt('同名 .jsonl 已存在，请输入新的聊天文件名：', `${targetFileName}-restored`);
    if (!renamed || await adapter.chatExists(renamed)) {
      notify('warning', '释放取消：不能覆盖已有聊天。');
      return;
    }
    targetFileName = normalizeFileName(renamed);
  }

  const rawJsonl = materializeOriginalJsonl(pack, fileName);
  const rows = rawJsonl.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const ok = await adapter.saveChat(targetFileName, rows);
  state.releaseLog.unshift({
    type: 'original',
    fileName: targetFileName,
    at: new Date().toLocaleString(),
    ok,
  });
  notify(ok ? 'success' : 'error', ok ? `已释放原文件：${targetFileName}.jsonl` : '释放失败。');
  renderWorkbench();
  await refreshChats();
}

function renderWorkbench() {
  renderTabs();
  renderPackList();
  renderPackSummary();
  renderMergePreview();
  renderGraphWorkspace();
  renderDuplicateCandidates();
  renderReleasePanel();
  renderStatusBar();
}

function renderTabs() {
  document.querySelectorAll('[data-cap-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.capTab === state.activeTab);
  });
  document.querySelectorAll('[data-cap-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.capPanel === state.activeTab);
  });
}

function renderPackList() {
  const container = document.querySelector('#chat_archive_pack_pack_list');
  if (!container) {
    return;
  }

  const settings = ensureExtensionSettings(getContext());
  const summaries = Object.values(settings.packs || {});
  if (!summaries.length && !state.pack) {
    container.innerHTML = '<div class="chat-archive-pack-muted">还没有归档包。生成预览并确认后会出现在这里。</div>';
    return;
  }

  const rows = summaries.map((summary) => `
    <button class="chat-archive-pack-pack-row ${state.pack?.packId === summary.packId ? 'active' : ''}" data-cap-pack="${summary.packId}">
      <strong>${escapeHtml(summary.packName || summary.packId)}</strong>
      <small>${summary.chatCount ?? 0} 个原聊天 · ${escapeHtml(summary.updatedAt || '')}</small>
    </button>
  `);
  container.innerHTML = rows.join('');
}

function renderPackSummary() {
  const summary = document.querySelector('#chat_archive_pack_summary');
  if (!summary) {
    return;
  }

  const pack = state.pack;
  if (!pack) {
    summary.textContent = '还没有加载归档包。';
    return;
  }

  const preview = pack.mergePreview || {};
  const nearDuplicates = findNearDuplicateTexts(pack);
  summary.innerHTML = `
    <strong>${escapeHtml(pack.packName)}</strong>
    <div>${pack.chats?.length || 0} 个原聊天 · ${pack.graph?.paths?.length || 0} 条路径 · ${preview.graphGroupCount ?? 0} 个分支分组</div>
    <div>${Object.keys(pack.contentBlocks || {}).length} 个内容块 · ${nearDuplicates.length} 个疑似重复 · 无损账本${preview.restoreLedgerOk ? '正常' : '异常'}</div>
  `;
}

function renderMergePreview() {
  const container = document.querySelector('#chat_archive_pack_merge_preview');
  if (!container) {
    return;
  }

  const pack = state.pendingPack || state.pack;
  if (!pack?.mergePreview) {
    container.textContent = '选择 jsonl 后生成审查预览。';
    return;
  }

  const preview = pack.mergePreview;
  container.innerHTML = `
    <div class="chat-archive-pack-kpis">
      <span>${preview.sourceFileCount} 个源文件</span>
      <span>${preview.pathCount} 条路径</span>
      <span>${preview.commonPrefixFloors} 楼共同前缀</span>
      <span>${preview.graphGroupCount} 个分支分组</span>
    </div>
    <ul>
      <li>原始行账本：${preview.rawLineCount} 行，${preview.restoreLedgerOk ? '可还原' : '存在缺口'}</li>
      <li>内容块：${preview.contentBlockCount} 个，共享内容块 ${preview.sharedContentBlockCount} 个</li>
      <li>同文本不同上下文：${preview.sameTextDifferentContextCount} 处，仅共享内容，不合并分组</li>
      <li>近似重复候选：${preview.nearDuplicateCount} 处</li>
    </ul>
  `;
}

function getCurrentPath() {
  const pack = state.pack;
  if (!pack?.graph?.paths?.length) {
    return null;
  }
  return pack.graph.paths.find(path => path.id === state.currentPathId) || pack.graph.paths[0];
}

function getNodeLabel(group) {
  return group.title || group.summary || group.autoTitle || group.id;
}

function renderGraphWorkspace() {
  const pathSelect = document.querySelector('#chat_archive_pack_path_select');
  const pathList = document.querySelector('#chat_archive_pack_path_list');
  const canvas = document.querySelector('#chat_archive_pack_graph_canvas');
  const inspector = document.querySelector('#chat_archive_pack_inspector');
  if (!pathSelect || !pathList || !canvas || !inspector) {
    return;
  }

  const pack = state.pack;
  if (!pack?.graph?.paths?.length) {
    pathSelect.innerHTML = '';
    pathList.textContent = '归档包生成后可查看路径。';
    canvas.textContent = '还没有结构图。请先在归档管理中合并 jsonl。';
    inspector.textContent = '选择节点后显示详情。';
    return;
  }

  if (!state.currentPathId) {
    state.currentPathId = pack.graph.activePathId || pack.graph.paths[0].id;
  }
  const currentPath = getCurrentPath();
  pathSelect.innerHTML = pack.graph.paths.map(path => `<option value="${path.id}" ${path.id === currentPath.id ? 'selected' : ''}>${escapeHtml(path.title || path.sourceFileName)}</option>`).join('');
  document.querySelector('#chat_archive_pack_graph_view').value = state.graphView;
  document.querySelector('#chat_archive_pack_graph_layout').value = state.graphLayout;
  document.querySelector('#chat_archive_pack_edit_mode').checked = state.graphEditMode;

  pathList.innerHTML = `
    <h4>路径列表</h4>
    ${pack.graph.paths.map(path => `
      <button class="chat-archive-pack-path-row ${path.id === currentPath.id ? 'active' : ''}" data-cap-path="${path.id}">
        <strong>${escapeHtml(path.title || path.sourceFileName)}</strong>
        <small>${path.groupIds.length} 楼 · ${escapeHtml(path.sourceFileName || '')}</small>
      </button>
    `).join('')}
  `;

  const visibleGroupIds = getVisibleGroupIds(pack, currentPath);
  canvas.classList.toggle('right', state.graphLayout === 'right');
  canvas.innerHTML = visibleGroupIds.map((groupId, index) => {
    const group = pack.graph.groupsById[groupId];
    const text = pack.contentBlocks[group.variants?.[0]?.contentBlockId]?.text || '';
    const active = currentPath.groupIds.includes(groupId);
    const branchCount = group.childGroupIds?.length || 0;
    return `
      <button class="chat-archive-pack-graph-node ${active ? 'active-path' : ''} ${state.selectedGroupId === groupId ? 'selected' : ''}" data-cap-group="${groupId}">
        <strong>${escapeHtml(getNodeLabel(group))}</strong>
        <span>${group.floorIndex + 1} 楼 · ${branchCount} 子级</span>
        <small>${escapeHtml(text).slice(0, 80)}</small>
      </button>
      ${index < visibleGroupIds.length - 1 ? '<div class="chat-archive-pack-edge">↓</div>' : ''}
    `;
  }).join('');

  const selected = pack.graph.groupsById[state.selectedGroupId] || pack.graph.groupsById[currentPath.groupIds[0]];
  state.selectedGroupId = selected?.id || '';
  inspector.innerHTML = selected ? `
    <h4>节点检查器</h4>
    <div><strong>${escapeHtml(getNodeLabel(selected))}</strong></div>
    <div class="chat-archive-pack-muted">${selected.floorIndex + 1} 楼 · ${selected.id}</div>
    <div>父级：${escapeHtml(selected.parentGroupId || '根节点')}</div>
    <div>子级：${selected.childGroupIds.length}</div>
    <div>来源路径：${selected.sourceRefs.map(ref => escapeHtml(ref.sourceFileName)).join('、')}</div>
    <hr>
    <h4>消息变体</h4>
    ${(selected.variants || []).map((variant, index) => {
      const text = pack.contentBlocks[variant.contentBlockId]?.text || '';
      return `<div class="chat-archive-pack-reader-floor"><strong>${variant.active ? '当前' : `变体 ${index + 1}`}</strong><p>${escapeHtml(text).slice(0, 500)}</p></div>`;
    }).join('')}
    <hr>
    <div>${state.graphEditMode ? '编辑模式已开启：结构改动需要二次确认。' : '查看模式：不会修改绑定关系。'}</div>
  ` : '选择节点后显示详情。';
}

function getVisibleGroupIds(pack, currentPath) {
  if (state.graphView === 'path') {
    return currentPath.groupIds;
  }
  if (state.graphView === 'full') {
    return pack.graph.floors.flatMap(floor => floor.groups.map(group => group.id));
  }

  const ids = new Set();
  for (const groupId of currentPath.groupIds) {
    const group = pack.graph.groupsById[groupId];
    if (!group) continue;
    const isBranchPoint = group.childGroupIds.length > 1;
    const isLeaf = group.childGroupIds.length === 0;
    if (isBranchPoint || isLeaf || group.floorIndex < 2 || currentPath.groupIds.includes(state.selectedGroupId)) {
      ids.add(groupId);
      group.childGroupIds.forEach(childId => ids.add(childId));
    }
  }
  return [...ids];
}

function renderDuplicateCandidates() {
  const container = document.querySelector('#chat_archive_pack_duplicates');
  if (!container) {
    return;
  }
  const pack = state.pack;
  if (!pack) {
    container.textContent = '加载归档包后显示重复候选。';
    return;
  }
  const nearDuplicates = findNearDuplicateTexts(pack);
  const sameText = pack.mergePreview?.sameTextDifferentContextCount || 0;
  container.innerHTML = `
    <h4>重复候选</h4>
    <p>同文本不同上下文：${sameText} 处。它们共享内容块，但不会自动合并分支分组。</p>
    <p>近似重复：${nearDuplicates.length} 处。V1 只提示，不自动合并。</p>
    ${nearDuplicates.map(item => `
      <div class="chat-archive-pack-reader-floor">
        <strong>${escapeHtml(item.reason)}</strong>
        <p>${escapeHtml(item.leftText).slice(0, 180)}</p>
        <p>${escapeHtml(item.rightText).slice(0, 180)}</p>
      </div>
    `).join('')}
  `;
}

function renderReleasePanel() {
  const select = document.querySelector('#chat_archive_pack_original_release_select');
  const log = document.querySelector('#chat_archive_pack_release_log');
  if (!select || !log) {
    return;
  }
  const sourceFiles = state.pack?.restoreLedger?.sourceFiles || [];
  select.innerHTML = sourceFiles.map(source => `<option value="${source.fileName}">${escapeHtml(source.fileName)} · ${source.rawLineCount} 行</option>`).join('');
  log.innerHTML = `
    <h4>释放记录</h4>
    ${state.releaseLog.length ? state.releaseLog.map(item => `
      <div class="chat-archive-pack-row">
        <span>${item.type === 'original' ? '原文件' : '路径'}</span>
        <strong>${escapeHtml(item.fileName)}.jsonl</strong>
        <small>${item.ok ? '成功' : '失败'} · ${escapeHtml(item.at)}</small>
      </div>
    `).join('') : '<div class="chat-archive-pack-muted">还没有释放记录。</div>'}
  `;
}

function renderStatusBar() {
  const status = document.querySelector('#chat_archive_pack_status');
  if (!status) {
    return;
  }
  const pack = state.pack;
  const path = getCurrentPath();
  status.textContent = pack
    ? `当前包：${pack.packName} · 无损账本：${pack.mergePreview?.restoreLedgerOk ? '正常' : '异常'} · 当前路径：${path?.title || '未选择'}`
    : '未加载归档包。';
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
    state.pendingPack = null;
    state.currentPathId = state.pack?.graph?.activePathId || state.pack?.graph?.paths?.[0]?.id || '';
    rememberPack(getContext(), state.pack);
    renderWorkbench();
    notify('success', '归档包已导入并绑定当前设置。');
  } catch (error) {
    notify('error', `导入失败：${error.message}`);
  } finally {
    event.currentTarget.value = '';
  }
}

async function onPanelClick(event) {
  const tab = event.target?.dataset?.capTab;
  if (tab) {
    state.activeTab = tab;
    renderWorkbench();
    return;
  }

  const packId = event.target?.closest?.('[data-cap-pack]')?.dataset?.capPack;
  if (packId) {
    const settings = ensureExtensionSettings(getContext());
    const pack = settings.packs?.[packId]?.inlinePack;
    if (pack) {
      state.pack = clonePack(pack);
      state.pendingPack = null;
      state.currentPathId = state.pack?.graph?.activePathId || state.pack?.graph?.paths?.[0]?.id || '';
      renderWorkbench();
    }
    return;
  }

  const pathId = event.target?.closest?.('[data-cap-path]')?.dataset?.capPath;
  if (pathId) {
    state.currentPathId = pathId;
    renderGraphWorkspace();
    renderStatusBar();
    return;
  }

  const groupId = event.target?.closest?.('[data-cap-group]')?.dataset?.capGroup;
  if (groupId) {
    state.selectedGroupId = groupId;
    renderGraphWorkspace();
    return;
  }

  const action = event.target?.dataset?.capAction;
  if (!action) {
    return;
  }

  if (action === 'close') closePanel();
  if (action === 'refresh') await refreshChats();
  if (action === 'select-all') setSelection('all');
  if (action === 'invert') setSelection('invert');
  if (action === 'clear') setSelection('clear');
  if (action === 'preview-merge') await previewSelectedArchive();
  if (action === 'confirm-merge') await commitPendingArchive({ deleteAfter: false });
  if (action === 'consolidate') await commitPendingArchive({ deleteAfter: document.querySelector('#chat_archive_pack_delete_after')?.checked });
  if (action === 'release-original') await releaseOriginalChat();
  if (action === 'release-path') await releasePathChat();
  if (action === 'open-graph') {
    state.activeTab = 'graph';
    renderWorkbench();
  }
  if (action === 'export') {
    if (!state.pack) {
      notify('warning', '没有可导出的归档包。');
      return;
    }
    downloadJson(state.pack);
  }
}

function clonePack(pack) {
  return pack == null ? pack : JSON.parse(JSON.stringify(pack));
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
  const context = getContext();
  const registerExtensionApi = context?.registerExtensionApi;
  registerExtensionApi?.call(context, EXTENSION_NAME, {
    buildArchivePack,
    materializeChat,
    materializeOriginalJsonl,
    materializePathChat,
    archiveSelected,
    getCurrentPack: () => state.pack,
  });
}

function applyConfiguredTheme() {
  const context = getContext();
  const settings = ensureExtensionSettings(context);
  settings.options.theme = applyThemePreference(settings.options.theme);
}

async function init() {
  applyConfiguredTheme();
  registerApi();
  await renderSettings();
  createPanel();
  scheduleAutoTask();
  console.debug('[chat-archive-pack] loaded');
}

export function initializeChatArchivePack({
  getContext: contextGetter,
  settingsTemplate = new URL('./settings.html', import.meta.url),
} = {}) {
  if (typeof contextGetter !== 'function') {
    throw new TypeError('chat-archive-pack requires a getContext function');
  }

  getContext = contextGetter;
  SETTINGS_TEMPLATE = settingsTemplate;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
