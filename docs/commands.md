# 命令参考

**中文** | [English](commands.en.md)

界面语言可通过 `--lang en|zh|auto`、`DECKFLOW_LANG` 或 `config set lang en|zh|auto` 设置，优先级依次递减；`auto` 直接读取系统语言。配置命令支持 `lang`、`apiUrl`、`webUrl` 和 `space`。

所有命令支持 `--json`；详情见各命令 `--help`。对象接受绝对工作空间路径或 `id:<id>`，本地路径仅用于 put/get。相对远端路径不受支持。

| 命令              | 行为                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| auth              | login 通过浏览器回调登录，--mode apikey/token、--no-browser、--token-stdin；status / logout |
| ls / info         | 混合列表、递归、元数据与不透明版本标识                                                      |
| mkdir             | 创建目录，`--parents` 允许创建父目录                                                        |
| new               | 空文本、`--content` 文本或 `--from-stdin` 字节；显式 MIME 当前仅支持 text/plain             |
| put / get         | 原始字节上传下载；`--force` 覆盖，远端覆盖追加同类型版本并保留 ID                           |
| cp                | 文件与递归目录复制；目标存在时拒绝覆盖                                                      |
| mv                | 同目录改名或保持名称跨目录移动；同时移动改名不支持                                          |
| rm                | 默认软删除当前不支持；`--permanent --yes` 进入真实删除任务                                  |
| cat               | 仅现成 UTF-8 原文，无自动提取或 AI 理解                                                     |
| view              | 所选 revision 的已有预览；返回 artifact 获取描述；`--url` 只输出 viewer 链接                |
| find              | 元数据名称 glob、类型、创建日期过滤                                                         |
| grep / seek / ask | RE2 内容匹配、语义检索、带真实依据的问答                                                    |
| search            | lexical/hybrid 模式缺接口，返回 NOT_IMPLEMENTED                                             |
| ws                | ls/info/use、usage/quota/balance/members、invite/remove/role、edit --name                   |
| ops               | capabilities、convert --to pdf、render --to webp；指定 --output 才创建受管文件              |
| jobs              | status/result 接受返回的 dfj1 句柄，可跨机器查询；ls/cancel 不支持                          |
| version           | ls、restore --to REVISION_ID；恢复创建新版本                                                |
| pptx / docx       | capabilities；结构 info 尚未实现                                                            |

`ws new/rm/stats`、空间描述编辑、问答会话、整文件 extract/resize/crop/trim/transcribe/thumbnail 提供严格占位。公开角色值为 manager、teammate；成员管理目前使用用户 ID，不支持邮箱解析。

```sh
deckflow ls / --ws WORKSPACE_ID --json
deckflow mkdir /Reports --parents
deckflow put ./report.pdf /Reports/report.pdf
deckflow get /Reports/report.pdf ./downloaded.pdf
deckflow view /Reports/report.pdf --json
deckflow ops convert /Reports/report.docx --to pdf --output /Reports/export.pdf --yes
```

列表默认 50 条，`--limit` 范围 1–100，使用 `--cursor` 继续。游标绑定范围与过滤条件；offset 适配不提供快照一致性，大型目录遍历会读取全部可访问元数据。

`ls` 的普通输出和 `--json` 列表项仅保留 `id`、`name`、`kind`、`path`，以及可用的 `format`、`updatedAt`。递归列表使用相同字段；完整元数据通过 `info <object>` 获取；两者均不输出内部 `version` 令牌。

`--if-version` 使用对象版本令牌；过期版本不会自动刷新重试。`--dry-run` 不提交处理任务或写入资源。永久删除、版本恢复需要 `--yes` 或交互确认。`--timeout` 为正整数秒，默认 30；`--wait-timeout` 使用时长（例如 10m），默认 10m。

预览和产物通过返回的 SDK method/params 或 artifact ID 获取，访问仍由服务端授权；不创建公开分享。处理默认只产生后台 artifact，不自动创建受管文件。render 多产物持久化要求已有输出目录，已有路径始终冲突。

`ws members` 与 `ws usage/quota/balance` 的 API Key 兼容性取决于服务端允许列表。403 时请检查 `error.details.server_reason`，区分接口不接受 API Key 与账号权限不足；详见[认证与工作空间](auth-and-workspaces.md#api-key-与命令兼容性)。

## 历史版本读取

`get`、`cat`、`view` 支持 `--revision <id>`，文件可用绝对路径或 `id:<id>` 指定，省略时读取当前版本。

```sh
deckflow version ls /report.pdf --json
deckflow get /report.pdf ./report-old.pdf --revision REVISION_ID --json
deckflow cat id:FILE_ID --revision REVISION_ID --json
deckflow view /report.pdf --revision REVISION_ID --json
```

`get` 的结果包含 `revisionId`、下载审计 ID 和请求 ID；`cat/view` 包含 `revision`，预览产物的 retrieval 参数也绑定该版本。下载继续走统一下载授权、计费和审计接口。版本不属于文件、已失效或不可访问时，返回标准错误信封及 HTTP 状态，不回退到当前版本。内容响应版本不符时返回 `REVISION_MISMATCH`。`view --revision` 不支持 `--url`，返回 `UNSUPPORTED_OPERATION`；可通过产物描述读取已有预览，不触发新转换。

## 配置与连接诊断

```sh
deckflow doctor --json
deckflow doctor --ws WORKSPACE_ID --timeout 5 --json
```

诊断报告在标准成功信封的 `data` 内，`ok: true` 表示诊断执行完成；是否健康以 `data.healthy` 为准。`schema_version` 为 1，`exit_code` 为 0（健康，可有警告）或 1（存在失败或跳过项）；参数解析错误仍沿用退出码 2。

稳定检查项为 `config`、`api_url`、`credentials`、`identity_api`、`workspaces_api`、`workspace` 和 `workspace_api`。每项包含 `id`、`status`（`pass/fail/warning/skipped`）和机器码 `code`，失败或跳过项附带 `suggestion`；HTTP 错误附带 `http_status`。来源信息通过 `source` 返回，不输出配置或凭据内容。

身份接口返回 401/403/404、但空间列表可读时，标记 `IDENTITY_ROUTE_RESTRICTED` 警告，避免误判全部凭据失效；其他检查继续执行。接口不支持返回 `NOT_IMPLEMENTED`；地址错误、认证失败、权限拒绝、缺少空间及后端不可用各有独立机器码。依赖缺失的远端检查标记 `DEPENDENCY_FAILED`。探测仅调用只读 API，不修改配置、不创建认证文件、不请求下载授权，不输出 Token、签名 URL 或服务端错误正文。
