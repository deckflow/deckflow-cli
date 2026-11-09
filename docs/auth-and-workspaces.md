# 认证与工作空间

`DECKFLOW_API_URL` 和 `DECKFLOW_WEB_URL` 分别覆盖用户配置中的 `apiUrl` 和 `webUrl`。API 地址应包含部署前缀，例如 `https://deckbase.example.com/api`。

`DECKFLOW_TOKEN` 优先于系统凭据库，适合 CI、容器和没有系统凭据库的 Linux。交互运行 `deckflow auth login` 可隐藏输入。显式使用 `deckflow auth login --token-stdin` 时，从标准输入读入一个 Token。CLI 用 `user.self` 验证身份后存入按 API 地址隔离的系统凭据。API Key 的 scope 和工作空间权限由服务端校验。

`auth logout` 清除当前 API 地址的本地凭据。要撤销 API Key，请在 WebUI 操作。若 shell 仍设置了 `DECKFLOW_TOKEN`，后续命令仍使用它。

工作空间优先级依次为：

1. `--space <id>`
2. `DECKFLOW_SPACE`
3. 从当前目录向上找到的最近 `.deckflow.json` 中的 `space` 配置
4. 用户配置中的 `space`

`deckflow space use <id>` 验证空间访问后保存用户默认配置。加 `--local` 将绑定写到当前项目。用户配置默认位于 `~/.config/deckflow/config.json`，也可以用 `XDG_CONFIG_HOME` 指定配置根目录。操作恢复状态位于同一配置目录的 `operations/`，包含本地路径、指纹和服务端操作 ID。

没有有效工作空间时，空间内命令会报告缺少绑定。可运行 `deckflow status --json` 查看当前工作空间和来源。
