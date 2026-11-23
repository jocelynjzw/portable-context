# portable-context

[English](#english) · [中文](#中文)

## English

**When you use several AI tools in your day-to-day work, give them the same project background so you can skip the repeat briefings.** Use the tools that fit each task and the devices that are convenient at the time. portable-context is a shared memory layer for the tools you already use.

### Intended use case

In this fictional example, someone uses one AI on their phone to draft a message about an upcoming release and another on their computer to work on the code. Both need the same background, such as what's in scope for the release and why a feature was deferred. The goal is for both tools to read and add to that shared background. **This is a target scenario. It has yet to be tested.**

### Current status

| Status | What's supported |
| --- | --- |
| **Released and verified** | v0.1.0 is a local proof of concept. It stores memories in SQLite on your computer and connects through a local MCP server over stdio. Cross-session use has been verified with the official Codex CLI. Other AI clients have yet to be verified. |
| **Unreleased Notion development build on `main`** | Optional Notion storage is implemented and has been tested only with offline mocks. The live Notion API and cross-device use have yet to be validated. Cloud storage is a core part of the first version still to be completed. The setup uses a dedicated database in your own Notion account that local MCP servers on multiple computers can share. |
| **Not implemented** | Mobile access and remote HTTP MCP, including authentication. Cloud AI services that cannot launch a local MCP server cannot connect directly yet. Each participating device must run its own local MCP server and connect over stdio. |

### How sharing works

Keep using your existing AI tools directly. portable-context is a shared memory layer with no required central agent or single entry point. A connected client explicitly calls the tools to save or read project background. It does not act as another agent, automatically record conversations or hand off progress, coordinate tasks across tools, or sync instantly across devices. Models can still give different answers with the same background.

### Data and privacy

With local storage, the app puts `memories.sqlite` in your user data directory outside the repository by default.

| System | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/portable-context` |
| Linux | `$XDG_DATA_HOME/portable-context`. If the variable is unset or contains a relative path, the app uses `~/.local/share/portable-context`. |
| Windows | `%APPDATA%\portable-context`. If the variable is unset or contains a relative path, the app uses `AppData\Roaming\portable-context` under your user directory. |

To choose another directory, set `PORTABLE_CONTEXT_DATA_DIR` to the same absolute path outside the repository for both the command-line tool and your client. The app does not load `.env` automatically.

Directory checks and Git ignore rules reduce the risk of accidental uploads. If you copy files manually, you can still add the database or exports to a Git repository or upload them elsewhere.

### Installation and Codex setup

#### Install

Use Node.js 22.13 or later in the 22.x series, or Node.js 24 or later. Download the [public repository](https://github.com/jocelynjzw/portable-context), then run these commands from the repository directory to install dependencies, build the project, and display help.

```sh
npm ci
npm run build
node dist/cli.js --help
```

You can also run `npm pack` in the repository to create an installable package. Then run the following commands in your chosen installation directory, replacing the example path with the location of the package you built.

```sh
npm install /absolute/path/to/portable-context-0.1.0.tgz
npm exec -- portable-context --help
```

#### Connect Codex

With either storage option, each device runs its own local MCP server and the client connects to it over stdio (standard input and output). If you built from source, start the server with `node dist/server.js`. If you installed the package, you can also run `npm exec -- portable-context-mcp` from the installation directory.

Add the example below to your Codex `config.toml` and replace the paths with your own absolute paths. If you installed the package, the server script is at `node_modules/portable-context/dist/server.js` under the installation directory. To use the default data directory, omit the entire `env` section. Restart Codex and ask it to call `memory_search`. [Codex MCP setup](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.portable-context]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/portable-context/dist/server.js"]

[mcp_servers.portable-context.env]
PORTABLE_CONTEXT_DATA_DIR = "/absolute/path/to/local-memory"
```

#### Verified minimum example

After setup, ask the official Codex CLI to save a fictional project fact with `memory_write`. In a new session on the same computer, find it with `memory_search` and use `memory_correct` to update it. In another session, search again to see the corrected fact.

### Try Notion storage

This unreleased setup has only been tested with offline mocks. Build from the source on `main` and have the client on each computer launch its own local MCP server. The command-line tool uses the same environment variables. To try the setup across devices, point each computer at the same dedicated database and use an integration token with access to it.

1. Create a dedicated Notion database with a single data source. Set `Name` as the title property and add a text property called `Portable Context v1`. Use this database exclusively for portable-context.
2. Create an internal integration with permission to read and insert content. Add the integration as a connection to the dedicated database.
3. Set these three variables in the environment that starts the MCP server or CLI. Replace the placeholders in angle brackets with your values. Keep the token only in private local configuration. The app does not load `.env` automatically.

```sh
export PORTABLE_CONTEXT_BACKEND=notion
export PORTABLE_CONTEXT_NOTION_TOKEN='<NOTION_INTEGRATION_TOKEN>'
export PORTABLE_CONTEXT_NOTION_DATABASE_ID='<NOTION_DATABASE_ID>'
```

In Codex, use `env_vars` to pass the variables to the local MCP server. Add this line under `[mcp_servers.portable-context]` in the server configuration above, then restart the client.

```toml
env_vars = ["PORTABLE_CONTEXT_BACKEND", "PORTABLE_CONTEXT_NOTION_TOKEN", "PORTABLE_CONTEXT_NOTION_DATABASE_ID"]
```

Call `memory_search` first to check the connection. An empty database should return no results. Use a separate test database and fictional data during development. [Notion setup guide](https://developers.notion.com/guides/get-started/getting-started) · [Storage design and consistency limits](docs/notion-backend.md)

### Tools and command line

| Client tool | Usage |
| --- | --- |
| `memory_write` | Save a memory with a `subject`, `content`, `source`, source date or timestamp (`time`), and `scope`. |
| `memory_search` | Search by keyword (`query`) and optionally filter by `subject` and `scope`. Search returns only current versions, with up to 50 results by default. Set `limit` to a value from 1 to 1000. |
| `memory_read` | Read a specific version by `id`, including earlier versions. |
| `memory_correct` | Provide the current `id` and `expectedVersion`, along with new content, source, and time. You can also change the subject or scope. |
| `memory_delete` | Provide the current `id` and `expectedVersion` to remove a memory and its history. With Notion storage, deletion only hides the records from the tools. The original pages stay in Notion. |

A correction creates a new version and ID, increments the version number by one, and keeps the earlier versions. If you get a version conflict (`VERSION_CONFLICT`), check the latest version first. If Notion contains two competing versions, review and resolve them in the dedicated database first.

These command examples use fictional release data and show how to list, view, search, correct, delete, and export memories. Run the ones you need and replace `ID` and the version numbers with your own values. To delete a memory after correcting it, use the new ID and version number returned by the correction. If you installed the package, run the commands from the installation directory and replace `node dist/cli.js` with `npm exec -- portable-context`.

```sh
node dist/cli.js list --scope "April release"
node dist/cli.js show ID
node dist/cli.js search "dashboard" --scope "April release"
node dist/cli.js correct ID --version 1 --content "The dashboard is deferred to the next release pending accessibility review" --source "Fictional release planning notes" --time 2026-04-16
node dist/cli.js delete ID --version 2
node dist/cli.js export
```

Export writes a JSON file to the local data directory with the memories you can still access and their history. The terminal displays only the file path. Delete exported copies separately.

### Version and license

**v0.1.0** is the released local proof of concept. [Changelog](CHANGELOG.md) · [v0.1.0 release](https://github.com/jocelynjzw/portable-context/releases/tag/v0.1.0) · [MIT license](LICENSE)

## 中文

**日常工作用到多个 AI 时，让它们共用同一份项目背景，省去反复交代。** 哪个工具擅长哪件事，就用哪个，手边哪台设备方便，就用哪台。portable-context 给你已经在用的 AI 提供一层共享记忆。

### 目标使用场景

举个虚构的例子。一个人在手机上用一个 AI 起草发布通知，回到电脑前用另一个 AI 写代码。两边都需要知道这次发布包含什么、某项功能为什么延期。目标是让两边都能读取和补充同一份项目背景。**这是目标场景，尚未实测。**

### 当前状态

| 状态 | 支持范围 |
| --- | --- |
| **已发布并验证** | 本地 v0.1.0 技术验证。记忆存在本机 SQLite，客户端通过本机 stdio MCP 接入。已验证官方 Codex CLI 跨会话使用。其他 AI 客户端尚未验证。 |
| **main 上的 Notion 开发版 · 未发布** | 已实现可选的 Notion 存储，目前只做过离线模拟测试，尚未验收真实 Notion API 或跨设备使用。云端存储是首版待完成的核心范围。方案是在你自己的 Notion 中建一个专用库，供多台电脑上的本机 MCP 共用。 |
| **尚未实现** | 手机接入和远程 HTTP MCP（含认证）。无法启动本机 MCP 的云端 AI 暂时也无法直接接入。每台接入设备都需要各自运行本机 MCP 服务，通过 stdio 连接。 |

### 怎么共用记忆

可以继续直接使用现有的 AI 工具。portable-context 是独立的共享记忆层，无需中心管家或统一入口。接入的 AI 要主动调用工具，才会保存或读取项目背景。它不是另一个 Agent，不会自动记录对话、交接进度、统一调度任务或跨设备即时同步。即使共用同一份背景，不同模型也可能给出不同答案。

### 数据与隐私

选择本机存储时，默认把 `memories.sqlite` 放在仓库外的用户数据目录。

| 系统 | 默认目录 |
| --- | --- |
| macOS | `~/Library/Application Support/portable-context` |
| Linux | `$XDG_DATA_HOME/portable-context`。变量未设置或不是绝对路径时，用 `~/.local/share/portable-context` |
| Windows | `%APPDATA%\portable-context`。变量未设置或不是绝对路径时，用用户目录下的 `AppData\Roaming\portable-context` |

要自选目录，请把命令行和客户端的 `PORTABLE_CONTEXT_DATA_DIR` 设为同一个仓库外的绝对路径。程序不会自动读取 `.env`。

目录检查和 Git 忽略规则能降低误传风险。手动复制后，仍可能把数据库或导出文件加进 Git 仓库，或上传到其他地方。

### 安装与 Codex 接入

#### 安装

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

#### 接入 Codex

无论选择哪种存储，每台设备都需要各自运行本机 MCP 服务，客户端通过 stdio（本机输入输出）接入。从源码构建时，启动命令是 `node dist/server.js`。使用安装包时，也可在安装目录运行 `npm exec -- portable-context-mcp`。

把下方示例加入 Codex 的 `config.toml`，换成你自己的绝对路径。使用安装包时，启动文件在安装目录的 `node_modules/portable-context/dist/server.js`。想用默认数据目录，可省略整个 `env` 段。重启 Codex 后，先请它调用 `memory_search`。 [Codex 接入说明](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.portable-context]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/portable-context/dist/server.js"]

[mcp_servers.portable-context.env]
PORTABLE_CONTEXT_DATA_DIR = "/absolute/path/to/local-memory"
```

#### 已验证的最小例子

接入后，请官方 Codex CLI 用 `memory_write` 保存一条虚构的项目背景。在同一台电脑上开一个新会话，用 `memory_search` 找到它，再用 `memory_correct` 更新。另开一个会话搜索，就能看到纠正后的内容。

### 试用 Notion 存储

这套未发布的方案只做过离线模拟测试。从 `main` 的源码构建，再让每台电脑的客户端各自启动本机 MCP。命令行工具也使用同一组变量。跨设备试用时，各电脑配置同一个专用库，并使用对该库有权限的集成令牌。

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

### 工具与命令行

| 客户端工具 | 用法 |
| --- | --- |
| `memory_write` | 保存记忆，填写主体 `subject`、内容 `content`、来源 `source`、来源日期或时间 `time`、适用范围 `scope` |
| `memory_search` | 按关键词 `query` 搜索，可按 `subject` 和 `scope` 筛选。只返回当前版本，默认最多 50 条，`limit` 可设为 1 到 1000 |
| `memory_read` | 按 `id` 查看指定版本，包括历史版本 |
| `memory_correct` | 提供当前 `id`、`expectedVersion`、新内容、来源和时间。可选改主体和范围 |
| `memory_delete` | 提供当前 `id` 和 `expectedVersion`，移除整条记忆及历史版本。Notion 模式下只在工具中隐藏记录，原页面仍保留在 Notion |

纠正会生成新版本和新 ID，版本号加一，旧版本保留。遇到版本冲突（`VERSION_CONFLICT`）时，先查看最新版本。Notion 若出现两个并行版本，需要先到专用库核对并处理分支。

下面用虚构的发布数据举例，展示如何用本机命令列出、查看、搜索、纠正、删除或导出记忆。按需执行，把 `ID` 和版本号换成实际值。纠正后如要删除，请用纠正返回的新 ID 和版本号。使用安装包时，在安装目录把 `node dist/cli.js` 换成 `npm exec -- portable-context`。

```sh
node dist/cli.js list --scope "April release"
node dist/cli.js show ID
node dist/cli.js search "dashboard" --scope "April release"
node dist/cli.js correct ID --version 1 --content "The dashboard is deferred to the next release pending accessibility review" --source "Fictional release planning notes" --time 2026-04-16
node dist/cli.js delete ID --version 2
node dist/cli.js export
```

导出会在本机数据目录生成 JSON 文件，包含仍可访问的记忆及其历史。终端只显示文件位置。已导出的副本需要单独删除。

### 版本与许可

已发布版本为 **v0.1.0**（本地技术验证）。[变更记录](CHANGELOG.md) · [v0.1.0 发布页](https://github.com/jocelynjzw/portable-context/releases/tag/v0.1.0) · [MIT 许可证](LICENSE)
