# 命令参考

参数详情以各命令的 `--help` 为准。以下命令均以 `deckflow` 开头。

| 命令                                              | DeckBase SDK 或本地行为                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `auth login/logout/status`                        | 凭据库、`user.self`                                                       |
| `config list/get/set`、`status`                   | 用户配置、身份及有效工作空间                                              |
| `space list/get/create/use/members`               | `my.spaces`、`space.detail`、`my.addSpace`、项目或用户绑定、`space.users` |
| `upload` / `file upload`                          | `uploadSession.*`、签名存储、`file.add`                                   |
| `download` / `file download`                      | `file.content` 或 `revision.content`、签名交付                            |
| `file list/get/update/move/delete`                | `file.list/detail/modify/move/remove`                                     |
| `file convert`                                    | `conversion.add/detail`，再以 artifact source 调用 `file.add`             |
| `file conversion list/get`                        | `conversion.list/detail`                                                  |
| `file creation get`、`file deletion get`          | `file.creationDetail`、`deletionJob.detail`                               |
| `revision list/get/upload/restore/delete`         | `revision.list/detail/add/restore/remove`                                 |
| `folder list/get/create/update/move/delete`       | `folder.list/detail/add/modify/move/remove`                               |
| `share list/get/create/update/revoke/open`        | `sharePage.list/detail/add/addItem/modify`、浏览器                        |
| `album list/get/create/update/delete/subscribers` | `album.list/detail/add/modify/remove/subscriptions`                       |
| `usage [summary\|storage\|traffic\|credits]`      | `billing.detail`，遵循服务端管理员权限                                    |
| `open <id>`                                       | 读取工作空间资源详情并生成现有 WebUI 地址                                 |
| `api <sdk-method> --input <json-file\|->`         | SDK 直通。非只读操作必须显式 `--yes`                                      |

`find`、`search`、`ask`、`file archive/restore`、`revision activate` 和 `action list/run/status/cancel` 为占位命令，返回 `FEATURE_NOT_SUPPORTED` 和退出码 11。WebUI 文件页当前没有版本、页面和区块深链接，`open` 的对应参数也返回 11。

## 文件与版本

- `upload ./reports --recursive --folder /Reports --create-folders --yes` 保留子目录结构。省略 `--create-folders` 时，各远端目标目录须存在。
- `--ttl-days` 支持小数，只接受换算后至少 10800 个整秒的值。
- `revision upload <file-id> ./updated.pdf` 提交新版本。上传失败可用 `upload --resume <operation-id>` 恢复，包括新版本上传。
- `revision get/restore/delete <revision-id> --file <file-id>` 需要文件上下文。恢复会创建新的当前版本。删除当前版本时按后端约定提供 `--replacement <revision-id>`。
- `file convert <file-id> --to pdf --folder /Exports --yes` 等待转换产物，再创建独立文件。超时可用错误详情中的 ID 查询或恢复。恢复时使用原工作空间和 API 地址。
- `file conversion get <operation-id> --file <file-id> --revision <revision-id>` 查看任务状态。
- 文件夹参数以 `/` 开头时按路径解析，否则作为 ID。`/` 表示根目录。
- 分页命令使用 `--limit` 和 `--offset`。默认每页 50 条，范围 1–100。分页字段由 SDK 接口决定。

## 分享、专辑与打开

```sh
deckflow share create --title Reports --files FILE1,FILE2 --yes
deckflow share revoke SHARE_ID --dry-run --json
deckflow album create --name Weekly --folder /Reports --yes
deckflow open SHARE_ID --type share --url
```

`share create` 逐条添加文件，部分成功时错误详情包含分享 ID 和各条结果。`share update --input` 接受页面属性或策略对象，复杂 Gate 管理可以使用 WebUI。`share revoke` 禁用整个页面。

`album create --input` 接受专辑 config 对象，可与 `--name` 和 `--folder` 合用。默认关闭公开访问、预览、下载、支付及解锁方式。`album update --input` 需要完整 config，而不是局部补丁。

`open` 可用 `--type file|share|album` 消歧。非交互和 JSON 模式仅输出 URL。浏览器沿用 WebUI 登录态。
