# 认证与工作空间

`DECKFLOW_API_URL` 和 `DECKFLOW_WEB_URL` 分别覆盖用户配置中的 `apiUrl` 和 `webUrl`。API 地址应包含部署前缀，例如 `https://deckbase.example.com/api`。

`~/.deckflow/auth-uuid` 在首次执行普通命令时写入随机 UUID。文件已存在时会保留原值。

`~/.deckflow/credentials` 是 JSON 文件，保存用户配置和当前登录凭据。CLI 配置项 `apiUrl`、`webUrl` 和 `space` 分别对应文件中的 `apiRoot`、`webRoot` 和 `spaceId`。Token 以明文保存，文件按 `0600` 权限写入。

交互运行 `deckflow auth login` 可隐藏输入。使用 `--token-stdin` 可从标准输入读入 Token。CLI 用 `user.self` 验证后保存 Token 和对应的 API 地址，切换到其他 API 地址时不会使用该 Token。日常命令优先使用 `DECKFLOW_TOKEN`。API Key 的 scope 和工作空间权限由服务端校验。

`deckflow auth logout` 清除当前 API 地址的本地 Token。要撤销 API Key，请在 WebUI 操作。若 shell 仍设置了 `DECKFLOW_TOKEN`，后续命令仍使用它。

升级后可用 `deckflow config set` 重新保存旧配置，再运行 `deckflow auth login` 写入新凭据文件。

工作空间优先级依次为：

1. `--space <id>`
2. `DECKFLOW_SPACE`
3. 从当前目录向上找到的最近 `.deckflow.json` 中的 `space` 配置
4. 用户配置中的 `space`

`deckflow space use <id>` 验证空间访问后保存用户默认配置。加 `--local` 将绑定写到当前项目。操作恢复状态位于 `~/.config/deckflow/operations/`，设置 `XDG_CONFIG_HOME` 时使用 `$XDG_CONFIG_HOME/deckflow/operations/`。

没有有效工作空间时，空间内命令会报告缺少绑定。可运行 `deckflow status --json` 查看当前工作空间和来源。
