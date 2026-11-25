# Agents and CI

[中文](automation.md) | **English**

Supply `DECKFLOW_API_URL`, `DECKFLOW_TOKEN`, `DECKFLOW_WORKSPACE` and use `--no-input --json`. Parallel agents should specify `--ws`. Set `DECKFLOW_LANG=en` or pass `--lang en` for deterministic English diagnostics.

Success and failure each write exactly one JSON object followed by a newline to stdout. Diagnostics go to stderr.

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
    "message": "Set a workspace with ws use <id> or specify --ws",
    "details": {},
    "retryable": false
  },
  "meta": { "request_id": "uuid" }
}
```

Exit statuses: 0 success; 1 internal failure; 2 usage or unsupported operation; 3 authentication/permissions; 4 missing object or conflict; 5 backend, job, network or billing failure. Machines should primarily inspect `error.code`. CLI messages and explanatory hints follow the selected language; JSON keys, codes, protocol enum values and original server reasons remain stable.

```sh
deckflow ls / --json --no-input
deckflow rm /Reports/old.pdf --permanent --dry-run --json
deckflow rm /Reports/old.pdf --permanent --yes --json
deckflow jobs status JOB_HANDLE --json
```

A processing timeout does not cancel the server job. Retain its handle for status/result queries. Resume uploads with `put LOCAL DEST --resume OPERATION_ID`; the original API, workspace, credentials and local fingerprint must match. Legacy conversion resume does not automatically continue managed file creation.

`grep` uses server RE2 with budgets of 2000 candidate chunks, 64 MiB and 3 seconds, returning at most 1000 hits. Final coverage and warnings are retained in provenance. `seek` is semantic and does not fall back to lexical retrieval. `ask` may incur charges; replay safely with `--idempotency-key`.

Real smoke tests require a dedicated workspace: set `DECKFLOW_SMOKE_SPACE` and authentication variables, build, then run `node scripts/live-smoke.mjs`. The script permanently deletes its own resources and waits for deletion.
