# DeckFlow CLI

`deckflow` 是面向开发者、Agent 和 CI 的 DeckBase 文件命令行客户端，提供文件与目录管理、内容检索、已有文本与视觉预览读取、文件处理任务和版本管理。当前 npm 包版本为 `0.2.0`，命令设计遵循 v0.3 规范。

## 安装

安装和运行需要 Node.js 18.17.0 或更高版本。发布包位于 GitHub Packages。将下面两行添加到用户级 `.npmrc`，通过环境变量提供有包读取权限的 GitHub PAT classic。

```ini
@deckflow:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npm install -g @deckflow/deckflow-cli
deckflow --version
```

也可以用 `npm install -g ./deckflow-deckflow-cli-0.2.0.tgz` 安装本地构建包。安装包自带 SDK 运行时代码。

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

从 DeckBase WebUI 的 API Key 页面获取密钥。交互登录会隐藏输入，并将 Token 和对应 API 地址存入 `~/.deckflow/credentials`。CI 通过密钥管理器设置 `DECKFLOW_TOKEN`，可以直接运行命令。

- [v0.3 迁移说明](docs/migration-v03.md)
- [命令参考与支持矩阵](docs/commands.md)
- [认证与工作空间](docs/auth-and-workspaces.md)
- [Agent 与 CI](docs/automation.md)

## 本地开发

将 DeckBase 放在相邻的 `../deckbase`。构建和测试使用 Node.js 24、TypeScript 7.0.2 和 pnpm 11.21.0。发布 CI 使用工作流中固定的 SDK 源 commit。

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

## 本地发布

更新 `package.json` 的版本号，并为目标 registry 配置有发布权限的 npm 凭据。两个命令都会重新构建并打包当前版本。

```sh
pnpm release          # 公开发布到 registry.npmjs.org
pnpm release --github # 发布到 npm.pkg.github.com
```

任一命令可加 `--dry-run` 预览目标和安装包。发布到 GitHub Packages 时，同一版本也可以走下方的 tag 发布流程，选择其中一个入口即可。

GitHub Actions 的构建需要 `DECKBASE_CHECKOUT_TOKEN`（仅 DeckBase 仓库读取）和 `DECKBASE_PACKAGES_TOKEN`（读取 DeckBase 的私有包依赖）。带版本的 `v*` tag 通过三平台安装验证后发布，tag 必须与 `package.json` 版本一致。发布作业使用当前仓库的 `GITHUB_TOKEN`。
