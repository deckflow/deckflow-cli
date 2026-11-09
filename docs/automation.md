# Agent 与 CI

在环境中注入 `DECKFLOW_API_URL`、`DECKFLOW_TOKEN` 和 `DECKFLOW_SPACE`，然后使用 `--no-input --json`。

```sh
deckflow file list --limit 50 --offset 0 --no-input --json
deckflow file delete FILE_ID --dry-run --no-input --json
deckflow file delete FILE_ID --yes --no-input --json
deckflow api file.detail --input ./params.json --no-input --json
```

成功结果写入 stdout。失败时 stdout 为空，stderr 的最后一行是包含 `code`、`message`、`details` 的 JSON。`--verbose` 在 stderr 添加方法级诊断。批量部分成功时查看 `details.results`。涉及付费或破坏性的命令可先预检，服务端未提供估价时 `estimatedCost` 为 `null`。

| 退出码 | 含义                 |
| ------ | -------------------- |
| 0      | 成功                 |
| 1      | 未分类 CLI 错误      |
| 2      | 参数、输入或用法错误 |
| 3      | 认证失败             |
| 4      | 拒绝访问             |
| 5      | 资源不存在或不可访问 |
| 6      | 冲突或目标已存在     |
| 7      | 配额或计费限制       |
| 8      | 网络、超时或限流     |
| 9      | 服务端或任务失败     |
| 10     | 部分成功             |
| 11     | 后续支持             |

`--timeout` 默认 30 秒，`--wait-timeout` 默认 10 分钟。上传和转换可使用错误详情提供的操作 ID 恢复。恢复复用服务端支持的幂等键。删除已返回异步任务时，通过 `file deletion get` 查询进度。

## 真实环境冒烟

将 `DECKFLOW_SMOKE_SPACE` 设为允许写入且用于测试的专用工作空间，提供 `DECKFLOW_API_URL` 和有权限创建文件、版本、分享、专辑的 `DECKFLOW_TOKEN`。先运行 `pnpm build`，然后运行：

```sh
node scripts/live-smoke.mjs
```

脚本创建唯一目录，验证上传下载、版本恢复、分享和专辑，并清理本次成功创建且已获得 ID 的资源。测试工作空间需要支持文件传输和分享、专辑功能。
