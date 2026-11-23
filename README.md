# portable-context

**让 Codex 开新对话时，能查回你存过的偏好和背景。** 适合经常开新对话、想自己查看和纠正 AI 记忆的人。

长期愿景是让记忆跟人走，换 AI 工具、换设备都能接着用。**v0.1.0 目前只在同一台电脑上工作。**

## 30 秒看懂怎么用

先完成下方的[安装与 Codex 接入](#安装与-codex-接入)。下面用虚构人物 Alex Chen 演示已经验证过的用法。

1. **存下来。** 请 Codex 记下「Alex Chen 喜欢绿茶」，来源填「虚构试饮记录」，日期填 `2026-01-15`，适用范围填「饮料推荐」。
2. **开新对话。** 请同一台电脑上的 Codex 搜索「饮料推荐」范围内 Alex Chen 的记忆，它就能查到这条记录。
3. **纠正再查。** 请 Codex 把这条记忆改为「Alex Chen 喜欢乌龙茶」，并填上新的来源和日期。再开一个对话搜索「乌龙茶」，可以查到新版。搜索「绿茶」时，这条旧记录不会出现在结果里。

## 现在已支持｜仅本地，无 Notion

记忆存在本机的 SQLite 数据库里。客户端主动调用工具，通过本机的标准输入和输出（stdio）与 MCP 服务通信。**不用 Notion，也不需要 Notion 账号。** 保存和搜索记忆不需要额外的模型 API 或向量检索 API（embedding API）。

- 每条记忆都有来源、来源日期或时间，以及适用范围。
- 纠正会生成新版本。旧版本保留原来源，新旧版本可以互相追查。搜索只返回当前版本。
- 两边同时改时，基于过期版本的纠正或删除会被拒绝。
- 你可以直接用本机命令行查看、搜索、纠正、删除和导出。

**当前没有**跨设备或云同步、远程服务、自动监听或从聊天里抽取记忆，也没有图形界面。

| AI 客户端 | 验证情况 |
| --- | --- |
| 官方 Codex CLI | 已验证跨会话写入和读取，以及纠正后在新会话中搜索 |
| Claude Desktop、豆包、WorkBuddy、Cursor | 未验证 |

接入按通用 MCP 协议设计。同一台电脑上，支持 stdio MCP 的客户端可以配置为使用同一数据目录。上表是实际验证范围。

## 已有 AI 记忆，为什么还需要它？

开新对话或换工具时，你可能需要重新交代背景。内置记忆够用时，可以继续用。portable-context 适合想单独管理一份记忆的人，例如想查清一条偏好从哪来、何时改过，或需要把全部版本导出。这些是本项目的取舍，同类方案也可能提供类似能力。

搜索只控制这套工具返回什么。客户端仍可能使用先前读到或缓存的旧内容。

## 数据与隐私

默认把 `memories.sqlite` 放在仓库外的用户数据目录。

| 系统 | 默认目录 |
| --- | --- |
| macOS | `~/Library/Application Support/portable-context` |
| Linux | `$XDG_DATA_HOME/portable-context`。变量未设置或不是绝对路径时，用 `~/.local/share/portable-context` |
| Windows | `%APPDATA%\portable-context`。变量未设置或不是绝对路径时，用用户目录下的 `AppData\Roaming\portable-context` |

要自选目录，请把命令行和客户端的 `PORTABLE_CONTEXT_DATA_DIR` 设为同一个仓库外的绝对路径。程序不会自动读取 `.env`。

目录检查和 Git 忽略规则能降低误传风险。手动复制后，仍可能把数据库或导出文件加进 Git 仓库，或上传到其他地方。

## 安装与 Codex 接入

### 安装

需要 Node.js 22.13 起的 22.x，或 Node.js 24 及以上。下载[公开仓库](https://github.com/jocelynjzw/portable-context)后，在仓库目录执行以下命令，安装依赖、构建并打开帮助。

```sh
npm ci
npm run build
node dist/cli.js --help
```

也可以在仓库执行 `npm pack` 生成安装包，再到你选定的安装目录执行以下命令。先把路径换成安装包的实际位置。

```sh
npm install /absolute/path/to/portable-context-0.1.0.tgz
npm exec -- portable-context --help
```

### 接入 Codex

客户端会启动本机的 MCP 服务。从源码构建时，启动命令是 `node dist/server.js`。使用安装包时，也可在安装目录运行 `npm exec -- portable-context-mcp`。

把下方示例加入 Codex 的 `config.toml`，换成你自己的绝对路径。使用安装包时，启动文件在安装目录的 `node_modules/portable-context/dist/server.js`。想用默认数据目录，可省略整个 `env` 段。重启 Codex 后，先请它调用 `memory_search`。 [Codex 接入说明](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.portable-context]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/portable-context/dist/server.js"]

[mcp_servers.portable-context.env]
PORTABLE_CONTEXT_DATA_DIR = "/absolute/path/to/local-memory"
```

## 工具与命令行

| 客户端工具 | 用法 |
| --- | --- |
| `memory_write` | 保存记忆，填写主体 `subject`、内容 `content`、来源 `source`、来源日期或时间 `time`、适用范围 `scope` |
| `memory_search` | 按关键词 `query` 搜索，可按 `subject` 和 `scope` 筛选。只返回当前版本，默认最多 50 条，`limit` 可设为 1 到 1000 |
| `memory_read` | 按 `id` 查看指定版本，包括历史版本 |
| `memory_correct` | 提供当前 `id`、`expectedVersion`、新内容、来源和时间。可选改主体和范围 |
| `memory_delete` | 提供当前 `id` 和 `expectedVersion`，删除整条记忆及其历史版本 |

纠正会生成新的 ID，版本号加一。遇到版本冲突（`VERSION_CONFLICT`）时，先查看最新版本，再决定是否继续改或删。

下面用本机命令列出、查看、搜索、纠正、删除或导出记忆。按需执行，把 `ID` 和版本号换成实际值。纠正后如要删除，请用纠正返回的新 ID 和版本号。使用安装包时，在安装目录把 `node dist/cli.js` 换成 `npm exec -- portable-context`。

```sh
node dist/cli.js list --scope "饮料推荐"
node dist/cli.js show ID
node dist/cli.js search "乌龙茶" --scope "饮料推荐"
node dist/cli.js correct ID --version 1 --content "Alex Chen 喜欢乌龙茶" --source "虚构试饮记录" --time 2026-01-16
node dist/cli.js delete ID --version 2
node dist/cli.js export
```

导出会在数据目录生成包含全部历史版本的 JSON 文件，终端只显示文件位置。已导出的副本需要单独删除。

## 后续方向｜可选 Notion 私有云存储

**尚未实现，无日期承诺。** 首版先把记忆留在本机，原设想中的跨设备使用还没做到。后续设想是保留本地选项，也让用户自行连接自己的 Notion，作为私有云存储。项目代码可以公开，个人记忆可以留在用户自己的私人 Notion 中。

未来场景是你在一台设备上纠正偏好，换设备或换 AI 工具后仍可查到新版。计划先用虚构数据验证跨工具、跨设备的读写，再小范围接入已有真实内容。

## 版本与许可

当前版本为 **v0.1.0**。[变更记录](CHANGELOG.md) · [v0.1.0 发布页](https://github.com/jocelynjzw/portable-context/releases/tag/v0.1.0) · [MIT 许可证](LICENSE)
