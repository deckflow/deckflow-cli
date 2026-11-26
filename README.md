# DeckFlow CLI

**English** | [简体中文](README.zh-CN.md)

`deckflow` is a DeckBase file CLI for developers, agents and CI. It manages files and directories, searches content, reads existing text and visual previews, submits processing jobs and manages revisions. The current package version is `0.3.1`, using the v0.3 command contract.

## Installation

Node.js 18.17.0 or later is required. Public npm is the preferred installation channel:

```sh
npm install -g @deckflow/deckflow-cli --registry=https://registry.npmjs.org
deckflow --version
```

Remove any existing GitHub Packages scope registry for `@deckflow` before using public npm. Existing users should read the [migration guide](docs/migration-v03.en.md). A local archive can also be installed with `npm install -g ./deckflow-deckflow-cli-0.3.1.tgz`. SDK runtime code is bundled.

GitHub Packages is an optional, independent publishing channel. Add the following to your user `.npmrc`, supply a GitHub PAT classic with package read access through the environment, then install:

```ini
@deckflow:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npm install -g @deckflow/deckflow-cli
```

## Language

The CLI automatically detects your system language. Chinese locales use Simplified Chinese; unsupported languages fall back to English.

```sh
deckflow config set lang en
deckflow config set lang zh
deckflow config set lang auto
deckflow --lang en --help
```

Precedence: `--lang` → `DECKFLOW_LANG` → saved `lang` → system language. `auto` at any level selects system detection directly. System detection respects the message locale environment and falls back to the default Intl locale. `C` and `POSIX` use English. Language changes need no server credentials. Commands, option names, error codes and JSON keys are stable. CLI-generated messages are translated; user content and original server reasons are preserved. The local login callback follows the CLI; the DeckBase website retains its own language setting.

## Quick start

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

Replace IDs with actual values. `ws use` persists the default workspace. Override it temporarily with `--ws OTHER_WORKSPACE_ID`. Workspace precedence is `--ws` → `DECKFLOW_WORKSPACE` → saved default; missing all three produces `WORKSPACE_REQUIRED`.

- Objects: `ls/info/mkdir/new/put/get/cp/mv/rm`. `cat` reads existing UTF-8 text; `view` reads existing previews for the current revision.
- Retrieval: `find` filters metadata, `grep` matches content with RE2, `seek` performs semantic retrieval and `ask` returns grounded answers. Lexical/hybrid `search` is not connected.
- Workspaces: `ws`; file processing: `ops`; jobs: `jobs`; history: `version`.
- Structured files: `pptx/docx` expose capabilities; deep structure reading and editing are not implemented.

Unavailable backend capabilities return `NOT_IMPLEMENTED` or `UNSUPPORTED_OPERATION`. Soft deletion is unavailable. Permanent deletion requires `rm --permanent` and confirmation. Processing returns artifacts unless `--output` requests managed files.

With `--json`, success and failure each produce one JSON object on stdout; diagnostics go to stderr. Agents and CI should use `--no-input --json` and inspect `ok`, `error.code` and exit status.

Browser login defaults to a dedicated workspace read/write CLI token, valid for 30 days and independently revocable with `auth logout --revoke`. It does not reuse or end your browser session. Use `auth login --with-token` to explicitly import an existing API key or compatible token (`--token-stdin` remains an alias). `DECKFLOW_TOKEN` overrides the active local account without being saved: unset it before login or switching. Use `auth accounts` and `auth switch --user ACCOUNT_ID` to manage accounts per API instance. See [authentication and migration](docs/auth-and-workspaces.en.md).

- [Migration](docs/migration-v03.en.md)
- [Command reference and support matrix](docs/commands.en.md)
- [Authentication and workspaces](docs/auth-and-workspaces.en.md)
- [Agents and CI](docs/automation.en.md)

## Development

Place DeckBase at `../deckbase`. Development uses Node.js 24, TypeScript 7.0.2 and pnpm 11.21.0. The DeckBase SDK version must include browser callback APIs. Deploy the DeckBase API and WebUI before publishing the CLI.

```sh
pnpm --dir ../deckbase install --frozen-lockfile
pnpm --dir ../deckbase build:sdk
pnpm --dir ../deckbase verify:sdk
pnpm install --frozen-lockfile
pnpm ci:check
node dist/cli.js --help
pnpm pack
```

When upgrading the SDK, rebuild and reinstall dependencies, then run all checks. The method manifest is generated from the intersection of installed SDK declarations and runtime routes, verifying adapter methods and HTTP verbs. Existing `dist-sdk` can be used directly. See the migration guide for the upstream `embed.query` generation limitation.

```sh
pnpm install:global
deckflow --version
deckflow --help
```

Global installation rebuilds and installs the same archive used for release, then cleans temporary files. Repeat after code changes. Install development dependencies first and ensure the npm global binary directory is on `PATH`.

## Publishing

Update the package version and configure publishing credentials for the target registry. Both commands typecheck, rebuild and pack:

```sh
pnpm release          # Publish to public npm
pnpm release --github # Publish to GitHub Packages
```

After a successful publication, `pnpm release` creates a local tag matching the package version (for example, `v0.3.1`) without pushing it. An existing tag aborts the release before publication. `--github` skips tag creation. Add `--dry-run` to preview publication without creating a tag. Before publishing, run `pnpm ci:check` to check translations, formatting, types, tests and the installable package.

The GitHub Actions workflow has been removed for now. Branch and version tag pushes do not automatically build or publish; use the local publishing commands above.

## License

This project is licensed under the [MIT License](LICENSE).
