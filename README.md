# portable-context

让同一台电脑上的 AI 客户端共用一份本地记忆。客户端主动发起读写。工具不监听聊天、不上传遥测，也不需要模型 API 或密钥。使用官方 [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)。

## 安装和启动

需要 Node.js 22.13+ 或 24+，建议使用 Node.js 24 LTS。在下载的仓库目录执行：

```sh
npm ci
npm run build
node dist/cli.js --help
```

从源码启动 MCP 服务的命令是 `node dist/server.js`。由客户端启动时，服务通过标准输入和输出（stdio）接收请求。

也可以打包后安装。在仓库执行 `npm pack`，然后在你选定的安装目录执行 `npm install /绝对路径/portable-context-0.1.0.tgz`。安装后，在该目录用 `npm exec -- portable-context --help` 打开命令帮助，或用 `npm exec -- portable-context-mcp` 启动服务。

## 在 Codex 中接入

在 Codex 的 `config.toml` 中加入以下示例，并替换为你自己的绝对路径。启动文件可选源码构建后的 `dist/server.js`，也可选安装目录下的 `node_modules/portable-context/dist/server.js`。数据目录应在仓库外。省略整个 `env` 段即可使用默认目录。详见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp)。

```toml
[mcp_servers.portable-context]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/portable-context/dist/server.js"]

[mcp_servers.portable-context.env]
PORTABLE_CONTEXT_DATA_DIR = "/absolute/path/to/local-memory"
```

重启 Codex 后，可以明确要求它调用 `memory_search`。已用两个独立的官方 SDK 客户端验证，Codex、Claude Desktop、Cursor 等实际应用接入未验证。

## 数据存在哪里

| 系统 | 默认目录 |
| --- | --- |
| macOS | `~/Library/Application Support/portable-context` |
| Linux | `$XDG_DATA_HOME/portable-context`，未设置时用 `~/.local/share/portable-context` |
| Windows | `%APPDATA%\portable-context`，未设置时用用户目录下的 `AppData\Roaming\portable-context` |

目录内使用 SQLite 数据库 `memories.sqlite`。如需指定目录，在命令行和各客户端设置相同的 `PORTABLE_CONTEXT_DATA_DIR` 绝对路径。请将目录放在源码、安装包和任何 Git 仓库之外。`.env.example` 只展示变量名，程序不会自动读取 `.env`。

## 客户端可以做什么

| 工具 | 用法 |
| --- | --- |
| `memory_write` | 填主体 `subject`、内容 `content`、来源 `source`、来源日期或时间 `time`、范围 `scope` |
| `memory_search` | 按关键词 `query` 查询，或按 `subject` 和 `scope` 精确筛选。默认最多 50 条，可用 `limit` 调整 |
| `memory_read` | 按 `id` 读取任一版本 |
| `memory_correct` | 提供当前 `id`、`expectedVersion`、新内容、来源和时间。可选改主体和范围 |
| `memory_delete` | 提供当前 `id` 和 `expectedVersion`，删除整条记忆及历史版本 |

新记录从版本 1 开始。纠正会产生新 ID 和递增版本，旧版本保留来源，并通过 `replacedById` 指向新版本。新版本用 `replacesId` 指回旧版本。搜索只返回当前版本。纠正或删除遇到 `VERSION_CONFLICT` 时，先读取最新版本再决定是否重试。删除也会移除工具内的历史，已导出的副本需单独处理。

例如，虚构人物 Alex Chen 的「喜欢绿茶」来自 2026-01-15 的 *Park Tour Planning*，范围是「饮料推荐」。纠正为「喜欢乌龙茶」后，搜索「绿茶」不会返回旧版本。查日程时可将范围设为「日程建议」。像「这类活动提醒可以先列给我看」这样的记录只作为偏好保存，客户端的执行权限仍由客户端管理。示例不会自动写入数据库。

## 命令行

下方示例使用源码构建后的命令。使用安装包时，可将 `node dist/cli.js` 换成 `npm exec -- portable-context`。把 `ID` 和版本号换成实际记录上的值。

```sh
node dist/cli.js list --scope "饮料推荐"
node dist/cli.js show ID
node dist/cli.js search "乌龙茶" --scope "饮料推荐"
node dist/cli.js correct ID --version 1 --content "Alex Chen 喜欢乌龙茶" --source "虚构试饮记录" --time 2026-01-16
node dist/cli.js delete ID --version 2
node dist/cli.js export
```

导出在数据目录下生成一份包含全部历史版本的 JSON 文件，终端只显示文件位置。请把导出和复制件留在 Git 仓库外的私人目录。删除记忆后，如需彻底移除旧副本，也要单独删除这些文件。

## 测试与发布前检查

```sh
npm test
npm run check:safety
git diff --cached
npm pack --dry-run
```

测试使用临时目录和虚构数据，启动两个独立客户端。安全脚本检查仓库已跟踪和可加入的文件名。再检查待提交的内容和打包清单，确认没有私人数据、密钥、备份或真实配置。安装包应只包含三个构建文件、包描述、README 和许可证。

MIT 许可证。
