import { Command, CommanderError } from "commander";
import { inspect } from "node:util";
import { commands } from "./runtime.js";
import { randomUUID } from "node:crypto";
import { CliError, Context, type Globals } from "./core.js";

declare const __VERSION__: string;

const billingCodes = new Set([
  "EGRESS_CREDIT_EXHAUSTED",
  "BILLING_SUSPENDED",
  "STORAGE_WRITE_RESTRICTED",
  "INSUFFICIENT_CREDIT",
]);
function redact(value: unknown, token = process.env.DECKFLOW_TOKEN): unknown {
  if (typeof value === "string") {
    const safe = token ? value.split(token).join("[REDACTED]") : value;
    return safe
      .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
      .replace(/\bdbk_[a-z0-9_-]+/gi, "[REDACTED]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
        try {
          const url = new URL(raw);
          return url.username ||
            url.password ||
            url.search ||
            /\/(?:content|album-content|_upload|_read)\//.test(url.pathname)
            ? "[REDACTED URL]"
            : raw;
        } catch {
          return "[REDACTED URL]";
        }
      });
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, token));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|secret|password|authorization|credential|signature|apiKey/i.test(
          k,
        )
          ? "[REDACTED]"
          : redact(v, token),
      ]),
    );
  return value;
}
function failure(error: unknown) {
  const e = error as
    | (Error & {
        code?: string;
        status?: number;
        operation?: unknown;
        cause?: unknown;
      })
    | null;
  const details = e?.operation as Record<string, unknown> | undefined;
  if (e instanceof CliError)
    return {
      exit: e.exit,
      body: {
        code: e.code,
        message: e.message,
        details: {
          ...(typeof e.details === "object" ? e.details : {}),
          ...details,
        },
      },
    };
  if (e instanceof CommanderError)
    return {
      exit: 2,
      body: { code: "INVALID_ARGUMENT", message: e.message, details: {} },
    };
  const status = e?.status;
  if (status) {
    const code =
      typeof e.code === "string" && /^[a-z0-9_]{1,80}$/i.test(e.code)
        ? e.code
        : `HTTP_${status}`;
    const exit =
      billingCodes.has(code) || status === 402
        ? 7
        : ((
            {
              400: 2,
              401: 3,
              403: 4,
              404: 5,
              409: 6,
              422: 2,
              429: 8,
            } as Record<number, number>
          )[status] ?? 9);
    const message = (
      {
        2: "DeckBase 拒绝了请求参数",
        3: "DeckBase 认证失败",
        4: "DeckBase 拒绝访问",
        5: "资源不存在或不可访问",
        6: "资源状态冲突，请重新读取",
        7: "DeckBase 额度或计费限制",
        8: "DeckBase 请求过于频繁",
        9: "DeckBase 请求失败",
      } as Record<number, string>
    )[exit];
    return { exit, body: { code, message, details: { status, ...details } } };
  }
  if (
    ["AbortError", "TimeoutError"].includes(e?.name ?? "") ||
    (e?.name === "TypeError" && e.cause)
  )
    return {
      exit: 8,
      body: {
        code: "NETWORK_ERROR",
        message: "网络请求失败或等待超时",
        details: details ?? {},
      },
    };
  if (e?.code === "EEXIST")
    return {
      exit: 6,
      body: {
        code: "OUTPUT_EXISTS",
        message: "目标已存在",
        details: details ?? {},
      },
    };
  if (
    e?.code &&
    ["ENOENT", "EISDIR", "EACCES", "EPERM", "ENOSPC", "ENOTDIR"].includes(
      e.code,
    )
  )
    return {
      exit: 2,
      body: {
        code: e.code,
        message: "无法访问本地文件或目录",
        details: details ?? {},
      },
    };
  return {
    exit: 1,
    body: {
      code: "INTERNAL_ERROR",
      message: "CLI 操作失败",
      details: details ?? {},
    },
  };
}
function display(result: unknown, json: boolean) {
  const safe = result ?? null;
  if (json)
    process.stdout.write(
      JSON.stringify({
        ok: true,
        data: safe,
        meta: {
          request_id: requestId,
          workspace_id: workspaceId,
        },
      }) + "\n",
    );
  else if (
    safe &&
    typeof safe === "object" &&
    "text" in safe &&
    typeof safe.text === "string"
  )
    process.stdout.write(safe.text);
  else if (
    safe &&
    typeof safe === "object" &&
    "viewer_url" in safe &&
    typeof safe.viewer_url === "string" &&
    "url_only" in safe
  )
    process.stdout.write(safe.viewer_url + "\n");
  else if (
    safe &&
    typeof safe === "object" &&
    "url" in safe &&
    typeof safe.url === "string"
  )
    process.stdout.write(safe.url + "\n");
  else
    process.stdout.write(
      inspect(safe, {
        colors: Boolean(process.stdout.isTTY),
        depth: null,
        compact: false,
      }) + "\n",
    );
}

let workspaceId: string | undefined;
const requestId = randomUUID();
const root = new Command()
  .name("deckflow")
  .description("DeckBase 云端文件命令行客户端")
  .version(__VERSION__)
  .option("--ws <id>", "可选：覆盖默认工作空间；使用 ws ls 获取 ID")
  .option("--quiet", "减少状态输出")
  .option("--json", "输出 JSON")
  .option("--no-input", "禁用隐式交互")
  .option("--yes", "确认此操作")
  .option("--dry-run", "只预检")
  .option("--timeout <seconds>", "请求超时秒数", "30")
  .option("--wait-timeout <duration>", "异步任务等待时限", "10m")
  .option("--verbose", "向 stderr 输出诊断")
  .configureOutput({ writeErr: () => {} })
  .exitOverride();

commands(root, (cmd, run) => {
  cmd.action(async (...values: unknown[]) => {
    const command = values.at(-1) as Command;
    const options = command.opts() as Record<string, string | undefined>;
    const global = root.opts<Globals>();
    if (!/^\d+$/.test(global.timeout ?? "30") || Number(global.timeout) <= 0)
      throw new CliError("INVALID_ARGUMENT", "--timeout 必须为正整数秒", 2);
    const ctx = new Context(global);
    workspaceId = (await ctx.spaceInfo()).id;
    await ctx.initialize();
    const result = await run(ctx, values.slice(0, -2) as string[], options);
    workspaceId = (await ctx.spaceInfo()).id;
    if (
      result &&
      typeof result === "object" &&
      "batch" in result &&
      result.batch
    ) {
      const batch = result as {
        batch: true;
        baseSucceeded?: boolean;
        results: ({ ok: true } | { ok: false; error: unknown })[];
      };
      const results = batch.results.map((item) => {
        if (item.ok) return item;
        const error = failure(item.error);
        return { ...item, error: error.body, exitCode: error.exit };
      });
      const first = results.find((item) => !item.ok);
      if (first && "exitCode" in first) {
        const exit =
          batch.baseSucceeded || results.some((item) => item.ok)
            ? 10
            : first.exitCode;
        throw new CliError(
          "BATCH_FAILED",
          exit === 10 ? "批量操作部分成功" : "批量操作失败",
          exit,
          { ...result, results },
        );
      }
      display({ ...result, results }, Boolean(global.json));
    } else display(result, Boolean(global.json));
  });
});

try {
  await root.parseAsync();
} catch (e) {
  if (e instanceof CommanderError && e.exitCode === 0) process.exitCode = 0;
  else {
    const { exit, body } = failure(e);
    const safe = redact(body) as typeof body;
    const mapped =
      exit === 11
        ? 2
        : exit === 4
          ? 3
          : [5, 6].includes(exit)
            ? 4
            : exit >= 7
              ? 5
              : exit;
    const status = (safe.details as { status?: number })?.status;
    const codeMap: Record<string, string> = {
      AUTH_REQUIRED: "UNAUTHENTICATED",
      FOLDER_NOT_FOUND: "OBJECT_NOT_FOUND",
      NOT_FOUND: "OBJECT_NOT_FOUND",
      OUTPUT_EXISTS: "OBJECT_EXISTS",
      NETWORK_ERROR: "BACKEND_UNAVAILABLE",
    };
    safe.code =
      (billingCodes.has(safe.code) ? safe.code : undefined) ??
      codeMap[safe.code] ??
      (
        {
          401: "UNAUTHENTICATED",
          403: "PERMISSION_DENIED",
          404: "OBJECT_NOT_FOUND",
          409: "VERSION_CONFLICT",
          429: "RATE_LIMITED",
        } as Record<number, string>
      )[status ?? 0] ??
      safe.code;
    process.exitCode = mapped;
    const json =
      root.opts<Globals>().json ||
      process.argv
        .slice(
          2,
          process.argv.indexOf("--") < 0
            ? undefined
            : process.argv.indexOf("--"),
        )
        .includes("--json");
    (json ? process.stdout : process.stderr).write(
      json
        ? JSON.stringify({
            ok: false,
            error: {
              ...safe,
              retryable:
                typeof (safe.details as { retryable?: boolean }).retryable ===
                "boolean"
                  ? (safe.details as { retryable: boolean }).retryable
                  : [429, 502, 503, 504].includes(status ?? 0) ||
                    safe.code === "BACKEND_UNAVAILABLE",
            },
            meta: { request_id: requestId },
          }) + "\n"
        : `${safe.code}: ${safe.message}\n${Object.keys(safe.details ?? {}).length ? inspect(safe.details, { depth: null }) + "\n" : ""}`,
    );
  }
}
