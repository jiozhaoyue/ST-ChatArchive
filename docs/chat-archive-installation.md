# 聊天归档包安装说明

当前仓库是插件源码仓库，不是运行中的 Luker 本体目录。

插件源码位于：

```text
public/scripts/extensions/third-party/chat-archive-pack/
```

安装到 Luker 时，将整个 `chat-archive-pack` 目录复制到 Luker 的：

```text
public/scripts/extensions/third-party/
```

安装后目标目录应类似：

```text
public/scripts/extensions/third-party/chat-archive-pack/manifest.json
public/scripts/extensions/third-party/chat-archive-pack/index.js
public/scripts/extensions/third-party/chat-archive-pack/archive-core.js
public/scripts/extensions/third-party/chat-archive-pack/operations.js
public/scripts/extensions/third-party/chat-archive-pack/luker-adapter.js
public/scripts/extensions/third-party/chat-archive-pack/settings.html
public/scripts/extensions/third-party/chat-archive-pack/style.css
```

刷新 Luker 后，插件应出现在“扩展”设置区域。
