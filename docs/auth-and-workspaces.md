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
