# DeckFlow CLI

`deckflow` 管理 DeckBase 的工作空间、文件、版本、文件夹、分享页和专辑。支持开发者终端、Agent 和 CI。

## 安装

需要 Node.js 22.12.0 或更高版本。发布包位于 GitHub Packages。将下面两行添加到用户级 `.npmrc`，通过环境变量提供有包读取权限的 GitHub PAT classic。

```ini
@deckflow:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
pnpm add -g @deckflow/deckflow-cli
deckflow --version
```

也可以用 `pnpm add -g ./deckflow-deckflow-cli-0.1.0.tgz` 安装本地构建包。安装包自带 SDK 运行时代码。

## 快速开始

```sh
deckflow config set apiUrl https://deckbase.example.com/api
deckflow config set webUrl https://deckbase.example.com
deckflow auth login
deckflow space list
deckflow space use <space-id>
deckflow folder create Reports
deckflow upload ./report.pdf --folder /Reports
deckflow file list --folder /Reports --json
deckflow download <file-id> --output ./downloaded-report.pdf
deckflow open <file-id> --type file
```

从 DeckBase WebUI 的 API Key 页面获取密钥。交互登录会隐藏输入，并将 Token 和对应 API 地址存入 `~/.deckflow/credentials`。CI 通过密钥管理器设置 `DECKFLOW_TOKEN`，可以直接运行命令。

- [命令参考与支持矩阵](docs/commands.md)
- [认证与工作空间](docs/auth-and-workspaces.md)
- [Agent 与 CI](docs/automation.md)

## 本地开发

将 DeckBase 放在相邻的 `../deckbase`。发布 CI 使用工作流中固定的 SDK 源 commit。项目采用 TypeScript 7.0.2 和 pnpm 11.21.0。

```sh
pnpm --dir ../deckbase install --frozen-lockfile
pnpm --dir ../deckbase build:sdk
pnpm --dir ../deckbase verify:sdk
pnpm install --frozen-lockfile
pnpm ci:check
node dist/cli.js --help
pnpm pack
```

升级 SDK 时，同步更新 CI 固定的 commit，重新构建 SDK 并安装 CLI 开发依赖后运行检查。CLI 从 SDK 类型和对应源码生成方法清单，用于验证 `api` 方法及其 HTTP 动词。

GitHub Actions 的构建需要 `DECKBASE_CHECKOUT_TOKEN`（仅 DeckBase 仓库读取）和 `DECKBASE_PACKAGES_TOKEN`（读取 DeckBase 的私有包依赖）。带版本的 `v*` tag 通过三平台安装验证后发布，tag 必须与 `package.json` 版本一致。发布作业使用当前仓库的 `GITHUB_TOKEN`。
