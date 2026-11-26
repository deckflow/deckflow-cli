# DeckFlow CLI

[English](README.md) | **简体中文**

`deckflow` 是面向开发者、Agent 和 CI 的 DeckBase 文件命令行客户端，提供文件与目录管理、内容检索、已有文本与视觉预览读取、文件处理任务和版本管理。当前源码包版本为 `0.3.1`，命令设计遵循 v0.3 规范。

## 安装

安装和运行需要 Node.js 18.17.0 或更高版本。公共 npm 是首选安装渠道：

```sh
npm install -g @deckflow/deckflow-cli --registry=https://registry.npmjs.org
deckflow --version
```

如曾为 `@deckflow` 配置 GitHub Packages scope registry，使用公共 npm 前先移除该 scope 配置。旧包用户先参阅[迁移说明](docs/migration-v03.md)。也可以用 `npm install -g ./deckflow-deckflow-cli-0.3.1.tgz` 安装本地构建包。安装包自带 SDK 运行时代码。

GitHub Packages 是独立的可选发布渠道。使用该渠道时，将下面两行添加到用户级 `.npmrc`，通过环境变量提供有包读取权限的 GitHub PAT classic，再执行安装命令：

```ini
@deckflow:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npm install -g @deckflow/deckflow-cli
```

## 界面语言

默认自动检测系统语言；中文系统使用简体中文，其他不支持的语言回退英文。

```sh
deckflow config set lang zh
deckflow config set lang en
deckflow config set lang auto
deckflow --lang en --help
```

优先级：`--lang` → `DECKFLOW_LANG` → 已保存的 `lang` → 系统语言。任一层显式设置 `auto` 时直接读取系统语言。系统检测识别 `LANGUAGE`、`LC_ALL`、`LC_MESSAGES`、`LANG`，缺失时读取 Intl 默认 locale；`C/POSIX` 使用英文。语言设置无需登录或配置服务端。命令名、参数名、错误码及 JSON 字段保持固定；CLI 生成的错误说明和提示跟随语言，用户内容及服务端原始原因保持原文。本地授权回调页跟随 CLI，DeckBase 授权网站使用独立网页语言设置。

## 快速开始

```sh
deckflow config set apiUrl https://deckbase.example.com/api
deckflow config set webUrl https://deckbase.example.com
deckflow auth login
deckflow ws ls
deckflow ws use WORKSPACE_ID
deckflow mkdir /Reports
deckflow put ./report.pdf /Reports/report.pdf
deckflow ls /Reports --json
deckflow get id:FILE_ID ./downloaded-report.pdf
deckflow view id:FILE_ID --url
```

将 `WORKSPACE_ID`、`FILE_ID` 替换为实际 ID。`ws use` 会保存默认工作空间，后续命令可省略 `--ws`。需要临时切换时使用：

```sh
deckflow ls / --ws OTHER_WORKSPACE_ID --json
```

工作空间优先级为 `--ws` → `DECKFLOW_WORKSPACE` → 已保存的用户默认值。临时覆盖不修改默认配置；三者均未设置时返回 `WORKSPACE_REQUIRED`。

主要命令入口：

- 诊断：`doctor --json` 检查配置、凭据来源、只读 API 和选定空间，不修改本地状态。
- 对象管理：`ls/info/mkdir/new/put/get/cp/mv/rm`；`cat` 读取已有 UTF-8 文本，`view` 读取已有预览；`get/cat/view` 均支持 `--revision <id>` 读取历史版本。
- 检索：`find` 查元数据，`grep` 做正则内容匹配，`seek` 做语义检索，`ask` 返回带依据的回答。`search` 的 lexical/hybrid 模式尚未接通。
- 工作空间：`ws`；文件处理：`ops`；任务查询：`jobs`；版本历史：`version`。
- 结构化文件：`pptx/docx` 提供能力查询，深度结构读取和编辑尚未实现。

后端未提供的功能会明确返回 `NOT_IMPLEMENTED` 或 `UNSUPPORTED_OPERATION`。默认软删除尚未支持；永久删除须显式使用 `rm --permanent` 并确认。`ops` 默认返回处理产物，指定 `--output` 才创建受管文件。完整支持范围见命令参考。

使用 `--json` 时，成功和失败均在 stdout 输出单个 JSON 对象，诊断写入 stderr。Agent 和 CI 可使用 `--no-input --json`，并通过 `ok`、`error.code` 和退出码判断结果。

`deckflow auth login` 默认通过浏览器一次确认，签发独立的工作空间读写 CLI Token，默认有效期 30 天，可用 `auth logout --revoke` 单独撤销，不复用或退出浏览器会话。显式导入使用 `auth login --with-token`，`--token-stdin` 保留为别名。`DECKFLOW_TOKEN` 仅覆盖当前环境，不会自动保存；登录或切换前应清除该变量。使用 `auth accounts` 与 `auth switch --user ACCOUNT_ID` 管理按 API 实例隔离的账号。参见[认证与迁移说明](docs/auth-and-workspaces.md)。

- [v0.3 迁移说明](docs/migration-v03.md)
- [命令参考与支持矩阵](docs/commands.md)
- [认证与工作空间](docs/auth-and-workspaces.md)
- [Agent 与 CI](docs/automation.md)

## 本地开发

将 DeckBase 放在相邻的 `../deckbase`。构建和测试使用 Node.js 24、TypeScript 7.0.2 和 pnpm 11.21.0。所选 DeckBase SDK 版本须包含浏览器回调接口。先发布 DeckBase 的 API 与 WebUI，再发布 CLI。

```sh
pnpm --dir ../deckbase install --frozen-lockfile
pnpm --dir ../deckbase build:sdk
pnpm --dir ../deckbase verify:sdk
pnpm install --frozen-lockfile
pnpm ci:check
node dist/cli.js --help
pnpm pack
```

升级 SDK 时，重新构建 SDK 并安装 CLI 开发依赖后运行检查。CLI 从实际安装 SDK 的类型声明与运行时代码生成方法清单，用于校验适配器使用的接口及其 HTTP 动词。已有 `dist-sdk` 时可直接安装 CLI 依赖并运行检查；若重新生成 SDK 遇到上游 `embed.query` 类型错误，参见迁移说明中的已知限制。

测试本地代码全局安装后的效果：

```sh
pnpm install:global
deckflow --version
deckflow --help
```

该命令会重新构建，将与发布相同的 `.tgz` 安装包通过 `npm install --global` 安装到当前 npm 全局目录，并清理临时安装包。修改代码后再次运行即可更新全局命令；执行前需安装项目开发依赖，并确保 npm 全局命令目录已加入 `PATH`。

## 本地发布

更新 `package.json` 的版本号，并为目标 registry 配置有发布权限的 npm 凭据。两个命令都会重新构建并打包当前版本。

```sh
pnpm release          # 公开发布到 registry.npmjs.org
pnpm release --github # 发布到 npm.pkg.github.com
```

`pnpm release` 成功发布后会自动创建与 `package.json` 版本一致的本地 tag（如 `v0.3.1`），不会自动推送；tag 已存在时会在发布前报错。`--github` 不创建 tag。任一命令可加 `--dry-run` 预览目标和安装包，且不会创建 tag。发布前运行 `pnpm ci:check`，检查翻译、格式、类型、测试和安装包。

GitHub Actions 工作流暂已移除；推送分支或版本 tag 不会自动构建或发布，请使用上述本地发布命令。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
