# DeckFlow CLI

`deckflow` 是面向开发者、Agent 和 CI 的 DeckBase 文件命令行客户端，提供文件与目录管理、内容检索、已有文本与视觉预览读取、文件处理任务和版本管理。当前源码包版本为 `0.3.0`，命令设计遵循 v0.3 规范。

## 安装

安装和运行需要 Node.js 18.17.0 或更高版本。公共 npm 是首选安装渠道：

```sh
npm install -g @deckflow/deckflow-cli --registry=https://registry.npmjs.org
deckflow --version
```

如曾为 `@deckflow` 配置 GitHub Packages scope registry，使用公共 npm 前先移除该 scope 配置。旧包用户先参阅[迁移说明](docs/migration-v03.md)。也可以用 `npm install -g ./deckflow-deckflow-cli-0.3.0.tgz` 安装本地构建包。安装包自带 SDK 运行时代码。

GitHub Packages 是独立的可选发布渠道。使用该渠道时，将下面两行添加到用户级 `.npmrc`，通过环境变量提供有包读取权限的 GitHub PAT classic，再执行安装命令：

```ini
@deckflow:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npm install -g @deckflow/deckflow-cli
```

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

- 对象管理：`ls/info/mkdir/new/put/get/cp/mv/rm`；`cat` 读取已有 UTF-8 文本，`view` 读取当前版本已有预览。
- 检索：`find` 查元数据，`grep` 做正则内容匹配，`seek` 做语义检索，`ask` 返回带依据的回答。`search` 的 lexical/hybrid 模式尚未接通。
- 工作空间：`ws`；文件处理：`ops`；任务查询：`jobs`；版本历史：`version`。
- 结构化文件：`pptx/docx` 提供能力查询，深度结构读取和编辑尚未实现。

后端未提供的功能会明确返回 `NOT_IMPLEMENTED` 或 `UNSUPPORTED_OPERATION`。默认软删除尚未支持；永久删除须显式使用 `rm --permanent` 并确认。`ops` 默认返回处理产物，指定 `--output` 才创建受管文件。完整支持范围见命令参考。

使用 `--json` 时，成功和失败均在 stdout 输出单个 JSON 对象，诊断写入 stderr。Agent 和 CI 可使用 `--no-input --json`，并通过 `ok`、`error.code` 和退出码判断结果。

`deckflow auth login` 会打开 DeckBase 授权页面，默认创建 API Key，也可在网页切换 Token，或通过 `deckflow auth login --mode token` 指定。CLI 临时启动本地 HTTP 服务接收浏览器回调，授权后自动领取并保存凭据，无需复制粘贴，也不轮询。`--no-browser` 只显示链接，需在运行 CLI 的同一台电脑上打开。凭据和对应 API 地址存入权限为 0600 的 `~/.deckflow/credentials`。CI 可通过密钥管理器设置 `DECKFLOW_TOKEN` 直接运行命令，或使用 `auth login --token-stdin` 导入。

- [v0.3 迁移说明](docs/migration-v03.md)
- [命令参考与支持矩阵](docs/commands.md)
- [认证与工作空间](docs/auth-and-workspaces.md)
- [Agent 与 CI](docs/automation.md)

## 本地开发

将 DeckBase 放在相邻的 `../deckbase`。构建和测试使用 Node.js 24、TypeScript 7.0.2 和 pnpm 11.21.0。CI 默认使用工作流中固定的 DeckBase SDK 源 commit，可通过仓库变量 `DECKBASE_SDK_REF` 覆盖；所选版本须包含浏览器回调接口。先发布 DeckBase 的 API 与 WebUI，再发布 CLI。

```sh
pnpm --dir ../deckbase install --frozen-lockfile
pnpm --dir ../deckbase build:sdk
pnpm --dir ../deckbase verify:sdk
pnpm install --frozen-lockfile
pnpm ci:check
node dist/cli.js --help
pnpm pack
```

升级 SDK 时，同步更新 CI 固定的 commit，重新构建 SDK 并安装 CLI 开发依赖后运行检查。CLI 从实际安装 SDK 的类型声明与运行时代码生成方法清单，用于校验适配器使用的接口及其 HTTP 动词。已有 `dist-sdk` 时可直接安装 CLI 依赖并运行检查；若重新生成 SDK 遇到上游 `embed.query` 类型错误，参见迁移说明中的已知限制。

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

任一命令可加 `--dry-run` 预览目标和安装包。发布到 GitHub Packages 时，同一版本也可以走下方的 tag 发布流程，选择其中一个入口即可。

GitHub Actions 的构建需要 `DECKBASE_CHECKOUT_TOKEN`（仅 DeckBase 仓库读取）和 `DECKBASE_PACKAGES_TOKEN`（读取 DeckBase 的私有包依赖）。带版本的 `v*` tag 通过三平台安装验证后发布，tag 必须与 `package.json` 版本一致。发布作业使用当前仓库的 `GITHUB_TOKEN`。
