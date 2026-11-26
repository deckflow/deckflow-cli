# 认证与工作空间

**中文** | [English](auth-and-workspaces.en.md)

语言偏好同样保存在用户配置中，登录和退出不会清除。无需登录即可使用 `config set lang en|zh|auto`；`--lang` 和 `DECKFLOW_LANG` 可临时覆盖。本地授权回调页跟随 CLI，授权网站使用独立网页语言设置。

沿用 `~/.deckflow/credentials`，权限 0600；凭据绑定 API 地址，保留现有用户默认空间。API Key 不会出现在正常诊断中。

```sh
deckflow config set apiUrl https://deckbase.example.com/api
deckflow config set webUrl https://deckbase.example.com
deckflow auth login
deckflow ws ls
deckflow ws use WORKSPACE_ID
```

`--ws` 是可选参数。先运行 `deckflow ws use WORKSPACE_ID` 保存默认值，后续可直接运行 `deckflow ls /`、`deckflow put ./file.txt /file.txt` 等命令。只有需要临时切换空间时才传 `--ws`；显式参数不会修改已保存的默认值。没有参数、环境值或默认配置时才返回 `WORKSPACE_REQUIRED`。

优先级：`--ws` → `DECKFLOW_WORKSPACE` → 用户默认空间。旧 `--space`、`DECKFLOW_SPACE`、`.deckflow.json` 和 `space use --local` 已移除。显示名称不作为 slug；当前接口以稳定空间 ID 使用。

## 登录、账号与迁移

```sh
deckflow auth login
deckflow auth login --no-browser
cat /secure/path/key | deckflow auth login --with-token
deckflow auth accounts
deckflow auth switch --user ACCOUNT_ID
deckflow auth status --json
deckflow auth logout --revoke
```

默认只需在已登录的浏览器确认一次；授权页显示账号和工作空间读写范围。后端签发独立 CLI Token，默认 30 天有效，不复用浏览器会话；有效权限仍取决于实时工作空间角色。到期或撤销后重新运行 `auth login`，不自动续期，也不影响浏览器会话。`auth logout` 只移除本地活动账号；`--revoke` 先撤销当前 Token，API Key 应在 WebUI Key 管理页撤销。显式导入的历史 Token 仍遵循原发行方的期限与撤销语义。

`--with-token` 从标准输入显式导入已有 API Key 或适用 Token；`--token-stdin` 是兼容别名。`--mode` 已弃用：`--mode token` 提示弃用后使用专用 Token 流程；`--mode apikey` 提示迁移并拒绝执行，不能静默改变类型或权限。旧脚本改为 `--with-token`，已有 Key 的权限不会自动提升。新浏览器登录需要同步部署支持专用 Token 的 DeckBase 与授权页，旧的共享浏览器 Token 响应会被拒绝。

业务与状态优先使用 `DECKFLOW_TOKEN`，其次本地活动账号。环境凭据不会隐式导入；设置该变量时 `auth login` 和 `auth switch` 明确拒绝并提示清除覆盖，保留本地凭据。`auth status` 展示实际账号、API 实例、来源与可取得的到期时间，不输出凭据。账号在权限为 0600 的 credentials 文件中按 API 实例保存，原有配置和旧单账号凭据兼容保留；首次保存新账号时迁移旧凭据，API A 的切换不影响 API B。

CLI 监听随机 loopback 端口并校验 state/Host，回调后兑换，不轮询。`--no-browser` 只显示链接；Ctrl+C、SIGTERM 或超时取消交接并关闭监听，失败保留原活动凭据。远端终端可转发回调端口，或显式标准输入导入。令牌到期与工作空间只读拒绝是不同错误，不会自动绕过服务端授权。

## API Key 与命令兼容性

工作空间的 `leader` 等角色不代表 API Key 可调用所有接口。`ws members` 使用 `space.users`；`ws usage`、`ws quota`、`ws balance` 使用 `billing.detail`，能否用 API Key 调用取决于部署的服务端允许列表。部分部署会拒绝这些 API Key 请求，即使同一密钥能正常执行 `ws info`。

遇到 HTTP 403 时，检查 JSON 的 `error.details.server_reason`：`API key is not allowed for this method` 表示该接口不接受当前凭据类型；普通授权拒绝则需检查账号权限或 API Key 的 scope。前者需要服务端支持该接口的凭据类型，提升工作空间角色不会解除接口级限制。CLI 保留服务器原因，不会绕过其授权规则。
