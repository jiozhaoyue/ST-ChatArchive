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
public/scripts/extensions/third-party/chat-archive-pack/theme.js
public/scripts/extensions/third-party/chat-archive-pack/settings.html
public/scripts/extensions/third-party/chat-archive-pack/style.css
```

刷新 Luker 后，插件应出现在“扩展”设置区域。

## 本地仓库导入

Luker 只接受 `http://` 或 `https://`，所以这里用本地 smart HTTP，不用 `git://`。

1. 在当前仓库里启动本地 Git 服务：

   ```powershell
   .\scripts\start-local-git-server.ps1
   ```

2. 在 Luker 的导入地址里填：

   ```text
   http://127.0.0.1:8123/chat-archive-pack.git
   ```

3. 以后你更新这个仓库，只要继续用同一个地址拉取就行，URL 不变。

补充说明：

- 这个服务直接暴露当前仓库，不需要移动仓库文件夹。
- 如果你改了代码但还没提交，Git 服务器不会看到新内容；先在当前仓库里提交，再让 Luker 拉同一个地址。
