# 聊天归档包测试用例

## 自动化测试

运行：

```bash
npm run test:core
```

覆盖：

- 解析 Luker `.jsonl`：第一行为 header，其余为消息楼层。
- assistant `swipes[] / swipe_id / swipe_info[]` 归档为变体，并可无损还原。
- 相同文本共享内容块，但每次出现的 `extra` 等还原载荷保持独立。
- 近似文本只进入疑似重复候选，不自动合并。
- user swipe 在归档阅读器模型内保留；释放到 Luker 时降级为普通 user 楼层。
- 当前聊天显示但禁选。
- 删除计划不会删除当前聊天，也不会删除角色最后一个聊天。
- 改名同步 `chat_metadata.main_chat`、`message.extra.bookmark_link`、`message.extra.branches`。
- Adapter 使用 Luker `/api/chats/get` 和 `/api/chats/save` 的正确请求体。

## 手动验收

安装：

1. 将 `public/scripts/extensions/third-party/chat-archive-pack/` 放入 Luker/SillyTavern 的同名第三方扩展目录。
2. 重启或刷新 Luker。
3. 在“扩展”设置中找到“聊天归档包”，打开主面板。

场景：

- 当前聊天应显示为“当前，禁选”，不能被勾选。
- 勾选一个非当前聊天，点击“更新归档”，应生成归档包摘要。
- 点击“导出 JSON”，应下载归档包。
- 导入刚导出的 JSON，归档包摘要和阅读器应恢复。
- 选择归档包内聊天，点击“释放为 .jsonl”；若同名已存在，应提示改名且不覆盖。
- 勾选“收束后删除”，点击“收束删除”；确认后只删除非当前聊天。
- 构造 assistant 多 swipe 聊天，释放后 `swipes[] / swipe_id / swipe_info[]` 应保留。
- 构造 user 多 swipe 归档，释放到 Luker 后应只保留普通 user `mes`，不写入 user `swipes[]`。
- 构造 `extra.reasoning`、工具调用、媒体、附件字段，归档后释放应不丢字段。
