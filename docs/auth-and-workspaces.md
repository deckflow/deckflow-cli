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

`DECKFLOW_API_URL/DECKFLOW_WEB_URL` 覆盖配置；`DECKFLOW_TOKEN` 优先于本地凭据。支持 `auth login --token-stdin`。退出登录只清除本地凭据，不撤销远端 API Key，也不清除环境变量。

当前只有一个 CLI 用户配置。`config set space ID` 仍可保存默认空间；推荐使用验证访问的 `ws use ID`。状态文件沿用 XDG_CONFIG_HOME/deckflow/operations，或 ~/.config/deckflow/operations。

## API Key 与命令兼容性

工作空间的 `leader` 等角色不代表 API Key 可调用所有接口。`ws members` 使用 `space.users`；`ws usage`、`ws quota`、`ws balance` 使用 `billing.detail`，能否用 API Key 调用取决于部署的服务端允许列表。部分部署会拒绝这些 API Key 请求，即使同一密钥能正常执行 `ws info`。

遇到 HTTP 403 时，检查 JSON 的 `error.details.server_reason`：`API key is not allowed for this method` 表示该接口不接受当前凭据类型；普通授权拒绝则需检查账号权限或 API Key 的 scope。前者需要服务端支持该接口的凭据类型，提升工作空间角色不会解除接口级限制。CLI 保留服务器原因，不会绕过其授权规则。
