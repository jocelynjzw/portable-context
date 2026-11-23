# portable-context

**跨 AI 工具、跨设备，共用你自己的一份记忆。** 你决定记忆存在哪里，也可以查来源、纠正内容、追查旧版本。

| 状态 | 支持范围 |
| --- | --- |
| **已发布并验证** | 本地 v0.1.0 技术验证。记忆存在本机 SQLite，客户端通过本机 stdio MCP 接入。已验证官方 Codex CLI 跨会话使用。 |
| **main 上的 Notion 开发版 · 未发布** | 已实现可选的 Notion 存储，可配置为使用同一个专用库。目前只做过离线模拟测试，尚未验收真实 Notion API 或跨设备使用。 |
| **尚未实现** | 手机接入和远程 HTTP MCP（含认证）。无法启动本机 MCP 的云端 AI 也暂时无法直接接入。 |

其他 AI 客户端尚未验证。SQLite 继续作为本机离线选项。

## 数据与隐私

选择本机存储时，默认把 `memories.sqlite` 放在仓库外的用户数据目录。

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

每台设备都需要各自运行本机 MCP 服务，客户端通过 stdio（本机输入输出）接入。从源码构建时，启动命令是 `node dist/server.js`。使用安装包时，也可在安装目录运行 `npm exec -- portable-context-mcp`。

把下方示例加入 Codex 的 `config.toml`，换成你自己的绝对路径。使用安装包时，启动文件在安装目录的 `node_modules/portable-context/dist/server.js`。想用默认数据目录，可省略整个 `env` 段。重启 Codex 后，先请它调用 `memory_search`。 [Codex 接入说明](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.portable-context]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/portable-context/dist/server.js"]

[mcp_servers.portable-context.env]
PORTABLE_CONTEXT_DATA_DIR = "/absolute/path/to/local-memory"
```

## 试用 Notion 存储

从 main 的源码构建，再让每台电脑的客户端各自启动本机 MCP。命令行工具也使用同一组变量。跨设备试用时，各电脑配置同一个专用库，并使用对该库有权限的集成令牌。

1. 在自己的 Notion 新建专用数据库，只保留一个数据源。设置 `Name` 为标题列，另加一个文本列 `Portable Context v1`。这张表只给 portable-context 使用。
2. 新建内部集成，打开读取和新增内容权限。在专用数据库里添加该连接。
3. 在启动 MCP 或 CLI 的环境中设置下面三项，把尖括号里的占位符换成自己的值。令牌仅保存在本机的私密配置中。程序不会自动加载 `.env`。

```sh
export PORTABLE_CONTEXT_BACKEND=notion
export PORTABLE_CONTEXT_NOTION_TOKEN='<NOTION_INTEGRATION_TOKEN>'
export PORTABLE_CONTEXT_NOTION_DATABASE_ID='<NOTION_DATABASE_ID>'
```

使用 Codex 时，可以用 `env_vars` 将已设置的变量传给本机 MCP。在上一节的服务器配置中、`[mcp_servers.portable-context]` 下添加这一行，再重启客户端。

```toml
env_vars = ["PORTABLE_CONTEXT_BACKEND", "PORTABLE_CONTEXT_NOTION_TOKEN", "PORTABLE_CONTEXT_NOTION_DATABASE_ID"]
```

先调用 `memory_search` 核对连接。空库应返回空结果。开发阶段请用独立测试库和虚构数据。 [Notion 接入指南](https://developers.notion.com/guides/get-started/getting-started) · [存储设计与一致性边界](docs/notion-backend.md)

## 工具与命令行

| 客户端工具 | 用法 |
| --- | --- |
| `memory_write` | 保存记忆，填写主体 `subject`、内容 `content`、来源 `source`、来源日期或时间 `time`、适用范围 `scope` |
| `memory_search` | 按关键词 `query` 搜索，可按 `subject` 和 `scope` 筛选。只返回当前版本，默认最多 50 条，`limit` 可设为 1 到 1000 |
| `memory_read` | 按 `id` 查看指定版本，包括历史版本 |
| `memory_correct` | 提供当前 `id`、`expectedVersion`、新内容、来源和时间。可选改主体和范围 |
| `memory_delete` | 提供当前 `id` 和 `expectedVersion`，移除整条记忆及历史版本。Notion 模式下原页面仍保留在 Notion |

纠正会生成新的 ID，版本号加一。遇到版本冲突（`VERSION_CONFLICT`）时，先查看最新版本。Notion 若出现两个并行版本，需要先到专用库核对并处理分支。

下面用本机命令列出、查看、搜索、纠正、删除或导出记忆。按需执行，把 `ID` 和版本号换成实际值。纠正后如要删除，请用纠正返回的新 ID 和版本号。使用安装包时，在安装目录把 `node dist/cli.js` 换成 `npm exec -- portable-context`。

```sh
node dist/cli.js list --scope "饮料推荐"
node dist/cli.js show ID
node dist/cli.js search "乌龙茶" --scope "饮料推荐"
node dist/cli.js correct ID --version 1 --content "Alex Chen 喜欢乌龙茶" --source "虚构试饮记录" --time 2026-01-16
node dist/cli.js delete ID --version 2
node dist/cli.js export
```

导出会在本机数据目录生成 JSON 文件，包含仍可访问的记忆及其历史。终端只显示文件位置。已导出的副本需要单独删除。

## 版本与许可

已发布版本为 **v0.1.0**（本地技术验证）。[变更记录](CHANGELOG.md) · [v0.1.0 发布页](https://github.com/jocelynjzw/portable-context/releases/tag/v0.1.0) · [MIT 许可证](LICENSE)
