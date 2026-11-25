# Agent 与 CI

**中文** | [English](automation.en.md)

可设置 `DECKFLOW_LANG=en` 或传入 `--lang en` 固定诊断语言。CLI 生成的 message 和重试说明随语言变化；JSON 字段、错误码、协议枚举和服务端原始原因保持固定。

注入 `DECKFLOW_API_URL`、`DECKFLOW_TOKEN`、`DECKFLOW_WORKSPACE`，并使用 `--no-input --json`。并行 Agent 推荐显式使用 `--ws`。

成功与失败均在 stdout 输出恰好一个 JSON 对象和末尾换行；诊断输出到 stderr。

```json
{
  "ok": true,
  "data": { "items": [], "next_cursor": null },
  "meta": { "request_id": "uuid" }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "WORKSPACE_REQUIRED",
    "message": "请选择工作空间",
    "details": {},
    "retryable": false
  },
  "meta": { "request_id": "uuid" }
}
```

退出码：0 成功；1 内部错误；2 用法或不支持；3 认证权限；4 不存在或冲突；5 后端、任务、网络或额度失败。机器应优先判断 error.code。

```sh
deckflow ls / --json --no-input
deckflow rm /Reports/old.pdf --permanent --dry-run --json
deckflow rm /Reports/old.pdf --permanent --yes --json
deckflow jobs status JOB_HANDLE --json
```

处理超时不会取消服务器任务。保留返回的任务句柄查询 status/result。上传恢复使用 `put LOCAL DEST --resume OPERATION_ID`，恢复时核验原 API、工作空间及本地文件指纹。旧转换恢复不自动继续创建受管文件。

`grep` 使用服务端 RE2：扫描预算 2000 个候选片段、64 MiB、3 秒，最多 1000 命中；最终覆盖状态与警告保留在 provenance。seek 为语义模式，不回退为 lexical。ask 可能计费，使用 `--idempotency-key` 安全重放。

真实冒烟使用专用工作空间，设置 `DECKFLOW_SMOKE_SPACE` 和认证环境，先构建再运行 `node scripts/live-smoke.mjs`。脚本永久删除自己创建的资源并等待删除完成。
