# 认证与工作空间

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

## 浏览器授权

```sh
deckflow auth login                     # 网页默认 API Key，可切换 Token
deckflow auth login --mode apikey       # 指定 API Key（也接受 apiKey）
deckflow auth login --mode token        # 指定 Token
deckflow auth login --no-browser        # 手动在本机浏览器打开链接
```

需要配置 API 与 Web 地址，非本机地址必须使用 HTTPS。CLI 在 `127.0.0.1` 随机端口监听 `/callback`，创建请求时绑定随机 state；网页批准或拒绝后跳转到本地回调。CLI 校验 state 和 Host 后，一次性调用 `cliAuth.exchange` 领取结果，不轮询等待授权。凭据只经 API 响应交付，不出现在回调 URL、终端或 JSON 输出中；仅网络或限流失败会做有限重试并遵守 Retry-After。

网页默认创建只读、无到期时间的 API Key，可自行选择读写权限和到期时间；在 `/account/keys` 管理和撤销。Token 复用当前网页会话，网页退出、会话清理或到期都会影响 CLI。

Ctrl+C、SIGTERM 或等待超时会取消交接并关闭本地服务，`--wait-timeout` 默认 10m。授权失败或取消时保留原凭据和默认工作空间；成功后才通过原子写入替换凭据。本地回调要求浏览器能访问 CLI 所在机器的 loopback；远端终端可使用端口转发，或以 `--token-stdin` 导入凭据。

需要部署包含回调扩展的 DeckBase API 与 WebUI。旧设备轮询接口仍保留供其他客户端使用。

`DECKFLOW_API_URL/DECKFLOW_WEB_URL` 覆盖配置；`DECKFLOW_TOKEN` 优先于本地凭据。支持 `auth login --token-stdin` 导入 API Key 或 Token；设置了 `DECKFLOW_TOKEN` 时，未指定 `--mode` 的登录命令沿用环境变量导入，显式 `--mode` 会发起浏览器授权。`--mode` 与 `--token-stdin` 不能同时使用。退出登录只清除本地凭据，不撤销远端 API Key，也不清除环境变量。

当前只有一个 CLI 用户配置。`config set space ID` 仍可保存默认空间；推荐使用验证访问的 `ws use ID`。状态文件沿用 XDG_CONFIG_HOME/deckflow/operations，或 ~/.config/deckflow/operations。

## API Key 与命令兼容性

工作空间的 `leader` 等角色不代表 API Key 可调用所有接口。`ws members` 使用 `space.users`；`ws usage`、`ws quota`、`ws balance` 使用 `billing.detail`，能否用 API Key 调用取决于部署的服务端允许列表。部分部署会拒绝这些 API Key 请求，即使同一密钥能正常执行 `ws info`。

遇到 HTTP 403 时，检查 JSON 的 `error.details.server_reason`：`API key is not allowed for this method` 表示该接口不接受当前凭据类型；普通授权拒绝则需检查账号权限或 API Key 的 scope。前者需要服务端支持该接口的凭据类型，提升工作空间角色不会解除接口级限制。CLI 保留服务器原因，不会绕过其授权规则。
