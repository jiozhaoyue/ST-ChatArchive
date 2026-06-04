# 聊天归档包插件计划

## Summary

目标是做一个 Luker/SillyTavern 前端插件 `chat-archive-pack`，中文名“聊天归档包”。它在当前角色卡范围内，把多个 `.jsonl` 聊天收束进稳定 JSON 归档包，按需释放 `.jsonl` 给原聊天系统读取，并维护 checkpoint/branch 文件名引用。

Luker 聊天系统理解：

- 一个 `.jsonl` 文件代表一个原生聊天。
- 第一行是 header，主要是 `chat_metadata`。
- 第二行开始每一行是一个 `ChatMessage`，也就是一个“楼层”。
- 浏览器里一条 `.mes[mesid=N]` 对应 `chat[N]`。
- 编辑按钮打开的未渲染文本来自 `message.mes`。
- assistant 楼层可有 `swipes[] / swipe_id / swipe_info[]`；Luker 原生不支持 user 楼层 swipe。
- 常见会影响 `.jsonl` 的字段包括 `name`、`is_user`、`is_system`、`send_date`、`gen_started`、`gen_finished`、`swipes`、`swipe_info`、`extra`。
- 插件可能在 `extra` 中写入 reasoning、token、模型、工具调用、媒体、文件附件、变量操作等任意字段。

## Key Decisions

术语：

- **更新归档**：把 `.jsonl` 最新内容写入聊天归档包，但保留 `.jsonl`。
- **收束删除**：先更新归档，再删除 `.jsonl`。
- **释放工作副本**：从归档包生成给原聊天系统读取/写入的 `.jsonl`。
- **判等键**：只看未渲染文本，即 `mes` 或 `swipes[i]`。
- **还原载荷**：完整保存用于释放 `.jsonl` 的元数据和字段。

核心规则：

- 自动合并只基于严格文本相等。
- 空白、不可见字符、一两个字差异只作为疑似重复候选，不自动合并。
- 归档分块采用“楼层元信息 + swipe 变体块”。
- 相同 swipe 文本可共享内容块；每次出现的时间、模型、`extra`、`swipe_info` 等保存在还原载荷/差异补丁中。
- 每个角色卡至少保留一个 `.jsonl`。
- 当前正在显示的聊天文件显示但禁选，不参与收束删除。
- user swipe 只在归档阅读器中支持；释放到 Luker 时写成普通 user 楼层，遵守原生规范。

## Implementation Changes

前端插件结构：

- 新建 `public/scripts/extensions/third-party/chat-archive-pack/`。
- `manifest.json` 注册插件。
- `index.js` 负责状态、端点调用、归档算法、UI 事件。
- `settings.html` 放全局设置。
- `style.css` 放插件样式。
- 文档建议生成：
  - `docs/chat-archive-luker-chat-system.md`
  - `docs/chat-archive-feature-spec.md`
  - `docs/chat-archive-implementation-plan.md`

存储：

- 不做 server plugin。
- 归档包 JSON 文件写入用户 data 的 `user/files`，使用 `/api/files/upload`。
- 插件索引与绑定关系保存在 `extension_settings.chatArchivePack`，通过 `saveSettingsDebounced()` 落到后端 settings。
- 归档包带 `schemaVersion`、`packId`、绑定角色 avatar、聊天条目、内容块、还原载荷、引用关系索引。

主要 UI：

- 扩展设置区：自动更新/收束删除、删除默认勾选、30 分钟定时、切换触发项。
- 当前聊天区按钮：打开聊天归档包主面板。
- 主面板：
  - 当前角色 `.jsonl` 列表，带全选、反选、取消。
  - 当前聊天显示但禁选。
  - 新建归档包或追加到已有归档包。
  - 收束后默认勾选“删除原 `.jsonl`”，但必须确认。
  - 归档包内聊天列表：文件名、预览、楼层数、swipe 数、状态。
  - 改名功能：更新归档包内引用，并扫描当前角色非当前 `.jsonl` 中的 `chat_metadata.main_chat`、`message.extra.bookmark_link`、`message.extra.branches`。
  - 基础阅读器：浏览归档聊天、切换 swipe、显示 swipe 树/分支关系。
  - 疑似重复界面：文本 diff + 字段差异摘要。

安全流程：

- 收束/更新归档时，先读取选中的非当前 `.jsonl`。
- 在内存中构建新归档包，不先删文件。
- 上传归档包 JSON。
- 再读取归档包并按目标 `.jsonl` 重建，和原始解析结果做结构校验。
- 校验通过后保存插件索引。
- 只有索引保存成功且用户确认后，才删除非当前 `.jsonl`。
- 自动任务默认每 30 分钟执行：更新归档并删除非当前 `.jsonl`，但永远保留当前聊天和每角色至少一个 `.jsonl`。

释放：

- 从归档包释放 `.jsonl` 时使用原文件名。
- 如果同名 `.jsonl` 已存在，禁止覆盖并提示改名。
- 释放后该文件是原聊天系统的工作副本；后续可被自动更新归档流程吸收回归档包。
- 通过 Luker 保存端点释放时，`chat_metadata.integrity` 可能被系统刷新；消息楼层和 swipe 还原载荷必须完整保留。

## Test Plan

核心数据测试：

- 解析普通 `.jsonl`：header + 多楼层。
- 解析 assistant 多 swipe：`mes`、`swipes[]`、`swipe_id`、`swipe_info[]` 完整重建。
- user 消息按单一变体处理。
- 文本相同、元数据不同：共享内容块，但释放后元数据分别还原。
- 文本近似不同：进入疑似重复，不自动合并。
- 带 reasoning、tool、media、files、token、插件自定义 `extra` 字段的消息不丢字段。

操作测试：

- 当前聊天禁选。
- 选择、全选、反选、取消正确。
- 新建归档包和追加归档包正确。
- 校验失败时不删除任何 `.jsonl`。
- 自动 30 分钟任务不删除当前聊天，不删除角色最后一个 `.jsonl`。
- 同名释放禁止覆盖。
- 改名同步更新 `main_chat`、`bookmark_link`、`branches`。
- 导出 JSON 后可重新导入并绑定当前角色。
- 基础阅读器能展示分支树和 swipe 树。

## Assumptions

- V1 只操作当前角色卡，不做全局角色扫描。
- V1 不改 Luker 原生 user swipe UI。
- V1 不实现 server plugin；如果未来需要原生目录扫描、专属归档目录、跨角色全局仓库，再评估 server plugin。
- “完全还原”指消息与 swipe 载荷完整还原；Luker 系统自动维护的 integrity 类字段允许刷新。
