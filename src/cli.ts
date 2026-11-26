import helpOptions from "./help-options.mjs";
import {
  resolveLanguage,
  setLanguage,
  localize,
  getLanguage,
  t,
  type MessageKey,
} from "./i18n.mjs";
import { Command, CommanderError, Help, Option } from "commander";
import { inspect } from "node:util";
import { commands } from "./runtime.js";
import { randomUUID } from "node:crypto";
import { CliError, Context, redactCredentials, type Globals } from "./core.js";

declare const __VERSION__: string;

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  process.stderr.write(`OUTPUT_IO_ERROR: ${error.code ?? "UNKNOWN"}\n`, () =>
    process.exit(1),
  );
});

const billingCodes = new Set([
  "EGRESS_CREDIT_EXHAUSTED",
  "BILLING_SUSPENDED",
  "STORAGE_WRITE_RESTRICTED",
  "INSUFFICIENT_CREDIT",
]);
function redact(value: unknown, token = process.env.DECKFLOW_TOKEN): unknown {
  if (typeof value === "string") {
    const safe = redactCredentials(
      token ? value.split(token).join("[REDACTED]") : value,
    );
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
function commanderMessage(message: string) {
  const patterns: [RegExp, MessageKey][] = [
    [/^error: missing required argument '([^']+)'$/, "缺少必需参数 {0}"],
    [/^error: option '([^']+)' argument missing$/, "选项 {0} 缺少参数"],
    [/^error: required option '([^']+)' not specified$/, "缺少必需选项 {0}"],
    [/^error: unknown option '([^']+)'/, "未知选项 {0}"],
    [/^error: unknown command '([^']+)'/, "未知命令 {0}"],
  ];
  for (const [pattern, key] of patterns) {
    const match = pattern.exec(message);
    if (match) {
      const suggestion = /\(Did you mean ([^)]+)\?\)/.exec(message);
      return (
        t(key, [match[1]]) +
        (suggestion ? "\n" + t("您是否想使用 {0}？", [suggestion[1]]) : "")
      );
    }
  }
  const excess =
    /^error: too many arguments(?: for '([^']+)')?\. Expected (\d+) arguments? but got (\d+)\.$/.exec(
      message,
    );
  if (excess)
    return t("{0} 参数过多：需要 {1} 个，收到 {2} 个", [
      excess[1] ?? "deckflow",
      excess[2],
      excess[3],
    ]);
  return message;
}
function failure(error: unknown) {
  const e = error as
    | (Error & {
        code?: string;
        status?: number;
        operation?: unknown;
        cause?: unknown;
        data?: unknown;
        transientNetwork?: boolean;
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
      body: {
        code: "INVALID_ARGUMENT",
        message: commanderMessage(e.message),
        details: {},
      },
    };
  const status = e?.status;
  if (status) {
    const code =
      e.code === "INDEX_PROFILE_MISMATCH" ||
      (Array.isArray(e.data) && e.data.includes("INDEX_PROFILE_MISMATCH"))
        ? "INDEX_PROFILE_MISMATCH"
        : typeof e.code === "string" && /^[a-z0-9_]{1,80}$/i.test(e.code)
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
    const message =
      code === "INDEX_PROFILE_MISMATCH"
        ? t("搜索索引模型配置不匹配")
        : (
            {
              2: t("DeckBase 拒绝了请求参数"),
              3: t(
                "认证已过期、被撤销或无效；请运行 deckflow auth login 重新认证。",
              ),
              4: t("DeckBase 拒绝访问"),
              5: t("资源不存在或不可访问"),
              6: t("资源状态冲突，请重新读取"),
              7: t("DeckBase 额度或计费限制"),
              8: t("DeckBase 请求过于频繁"),
              9: t("DeckBase 请求失败"),
            } as Record<number, string>
          )[exit];
    return {
      exit,
      body: {
        code,
        message,
        details: {
          status,
          server_code: e?.code,
          server_reason: e?.data ?? e?.message,
          ...(e?.transientNetwork ? { retryable: true } : {}),
          ...details,
        },
      },
    };
  }
  if (
    ["AbortError", "TimeoutError"].includes(e?.name ?? "") ||
    (e?.name === "TypeError" && e.cause)
  )
    return {
      exit: 8,
      body: {
        code: "NETWORK_ERROR",
        message: t("网络请求失败或等待超时"),
        details: details ?? {},
      },
    };
  if (e?.code === "EEXIST")
    return {
      exit: 6,
      body: {
        code: "OUTPUT_EXISTS",
        message: t("目标已存在"),
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
        message: t("无法访问本地文件或目录"),
        details: details ?? {},
      },
    };
  return {
    exit: 1,
    body: {
      code: "INTERNAL_ERROR",
      message: t("CLI 操作失败"),
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
    "text_chunks" in safe &&
    Array.isArray(safe.text_chunks)
  ) {
    for (const chunk of safe.text_chunks) process.stdout.write(chunk);
  } else if (
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
  .description(t("DeckBase 云端文件命令行客户端"))
  .version(__VERSION__)
  .option("--lang <en|zh|auto>", t("选择语言：en、zh 或 auto"))
  .option("--ws <id>", t("可选：覆盖默认工作空间；使用 ws ls 获取 ID"))
  .option("--quiet", t("减少状态输出"))
  .option("--json", t("输出 JSON"))
  .option("--no-input", t("禁用隐式交互"))
  .option("--yes", t("确认此操作"))
  .option("--dry-run", t("只预检"))
  .option("--timeout <seconds>", t("请求超时秒数"), "30")
  .option("--wait-timeout <duration>", t("异步任务等待时限"), "10m")
  .option("--verbose", t("向 stderr 输出诊断"))
  .configureOutput({ writeErr: () => {} })
  .exitOverride();

commands(root, (cmd, run) => {
  cmd.action(async (...values: unknown[]) => {
    const command = values.at(-1) as Command;
    const options = command.opts() as Record<string, string | undefined>;
    const global = root.opts<Globals>();
    if (!/^\d+$/.test(global.timeout ?? "30") || Number(global.timeout) <= 0)
      throw new CliError("INVALID_ARGUMENT", t("--timeout 必须为正整数秒"), 2);
    const ctx = new Context(global);
    if (cmd.name() === "doctor") {
      const report = (await run(ctx, [], options)) as { exit_code: number };
      display(report, Boolean(global.json));
      process.exitCode = report.exit_code;
      return;
    }
    workspaceId = (await ctx.spaceInfo()).id;
    if (cmd.name() !== "capabilities" && cmd.parent?.name() !== "config")
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
          exit === 10 ? t("批量操作部分成功") : t("批量操作失败"),
          exit,
          { ...result, results },
        );
      }
      display({ ...result, results }, Boolean(global.json));
    } else display(result, Boolean(global.json));
  });
});

for (const group of root.commands.filter(
  (command) => command.commands.length > 0,
))
  group.action(() => {
    throw new CliError(
      "INVALID_ARGUMENT",
      t("{0} 需要子命令；使用 {1} --help 查看可用命令", [
        group.name(),
        group.name(),
      ]),
      2,
    );
  });

try {
  const argv = process.argv.slice(2);
  const optionDefinitions = new Map<
    string,
    { required: boolean; optional: boolean }
  >();
  function collect(command: Command) {
    for (const option of command.options) {
      if (option.long) optionDefinitions.set(option.long, option);
      if (option.short) optionDefinitions.set(option.short, option);
    }
    for (const child of command.commands) collect(child);
  }
  collect(root);
  const globals = [...root.options];
  function inheritOptions(command: Command) {
    command.enablePositionalOptions();
    if (command !== root)
      for (const option of globals) {
        if (command.options.some((existing) => existing.long === option.long))
          continue;
        command.addOption(
          new Option(option.flags, option.description).hideHelp(),
        );
        command.on(`option:${option.name()}`, () =>
          root.setOptionValue(
            option.attributeName(),
            command.getOptionValue(option.attributeName()),
          ),
        );
      }
    for (const child of command.commands) inheritOptions(child);
  }
  inheritOptions(root);
  let preference: string | undefined;
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    const flag = argv[i].split("=")[0];
    if (flag === "--lang") {
      preference = argv[i].includes("=") ? argv[i].slice(7) : argv[++i];
      if (!preference)
        throw new CliError("INVALID_ARGUMENT", t("语言必须是 en、zh 或 auto"));
    } else {
      const option = optionDefinitions.get(flag);
      if (option?.required && !argv[i].includes("=")) i++;
    }
  }
  try {
    setLanguage(resolveLanguage(preference));
  } catch {
    throw new CliError("INVALID_ARGUMENT", t("语言必须是 en、zh 或 auto"));
  }
  function translate(command: Command) {
    command.configureOutput({ writeErr: () => {} }).exitOverride();
    command.description(localize(command.description()));
    command.helpOption("-h, --help", t("显示帮助"));
    if (command.commands.length)
      command.helpCommand("help [command]", t("显示命令帮助"));
    for (const option of command.options)
      option.description = option.description
        ? localize(option.description)
        : helpOptions[option.long ?? ""]
          ? t(helpOptions[option.long!])
          : "";
    command.configureHelp({
      styleTitle: (title: string) =>
        getLanguage() === "zh"
          ? ({
              "Usage:": "用法：",
              "Options:": "选项：",
              "Commands:": "命令：",
              "Arguments:": "参数：",
              "Global Options:": "全局选项：",
            }[title] ?? title)
          : title,
      optionDescription: (option) => {
        const text = Help.prototype.optionDescription.call(new Help(), option);
        return getLanguage() === "zh"
          ? text.replace(
              /\b(default|choices|preset|env):/g,
              (label) =>
                ({
                  "default:": "默认值：",
                  "choices:": "取值：",
                  "preset:": "预设值：",
                  "env:": "环境变量：",
                })[label]!,
            )
          : text;
      },
      showGlobalOptions: command !== root,
    });
    for (const child of command.commands) translate(child);
  }
  translate(root);
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
      INDEX_PROFILE_MISMATCH: "INDEX_PROFILE_MISMATCH",
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
