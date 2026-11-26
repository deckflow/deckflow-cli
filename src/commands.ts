import { t } from "./i18n.mjs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Method, Params } from "@deckflow/deckbase-sdk";
import type { Command } from "commander";
import openBrowser from "open";
import { createInterface } from "node:readline/promises";
import { authorizationMode, browserLogin } from "./auth.js";
import {
  CliError,
  Context,
  configFields,
  configKey,
  endpoint,
  inputJson,
  integer,
  isRead,
  methodOf,
  page,
  readJson,
  type Config,
  saveJson,
  selectAccount,
  stdinText,
  unsupported,
  usage,
} from "./core.js";
import {
  convert,
  download,
  folderPath,
  upload,
  type UploadOptions,
} from "./files.js";

type Options = Record<string, string | undefined>;
type Register = (
  cmd: Command,
  run: (ctx: Context, args: string[], opts: Options) => Promise<unknown>,
) => void;
const paginate = (c: Command) =>
  c
    .option("--limit <n>", t("每页条数，1–100"))
    .option("--offset <n>", t("分页偏移"));
const payload = (c: Command) =>
  c.option("--input <json-file|->", t("从文件或标准输入读取 JSON"));
function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw usage(t("缺少 {0}", [option]));
  return value;
}
function withOptions(
  data: Record<string, unknown>,
  options: Record<string, unknown>,
) {
  return {
    ...data,
    ...Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ),
  };
}
const modernPage = (o: Options) => {
  const p = page(o);
  return { limit: p._maxResults, offset: p._startIndex };
};

function configHelp(action: "get" | "set") {
  const fields = Object.entries(configFields);
  const lines = fields.map(([key, field]) => {
    const label = action === "set" ? `${key} <${field.format}>` : key;
    return `  ${label.padEnd(16)} ${t(field.description)}`;
  });
  if (action === "set") {
    lines.push(
      "",
      t(
        "URL 必须是完整的 HTTP(S) 地址，不可包含用户名、密码、查询参数或片段。",
      ),
      t("空间 ID 可从 deckflow ws ls 获取，保存时会验证当前凭据的访问权限。"),
      "",
      t("示例："),
      ...fields.map(
        ([key, field]) => `  deckflow config set ${key} ${field.example}`,
      ),
    );
  }
  return `
${t("支持的配置项（键名区分大小写）：")}
${lines.join("\n")}`;
}

async function openResource(
  ctx: Context,
  id: string,
  o: Options,
  forceShare = false,
) {
  if (o.page !== undefined || o.revision !== undefined || o.block !== undefined)
    throw unsupported(t("文件版本或页面深链接"));
  const type = forceShare ? "share" : o.type;
  const types = ["file", "share", "album"] as const;
  if (type && !types.includes(type as (typeof types)[number]))
    throw usage(t("--type 必须是 file、share 或 album"));
  const web = await ctx.webUrl();
  const spaceId = await ctx.space();
  const api = await ctx.client();
  const enc = encodeURIComponent;
  const lookup = {
    file: async () => {
      await api("file.detail", { spaceId, fileId: id });
      return `/s/${enc(spaceId)}/files/${enc(id)}`;
    },
    share: async () => {
      const page = await api("sharePage.detail", { spaceId, id });
      return `/share/${enc(page.page.slug)}`;
    },
    album: async () => {
      await api("album.detail", { spaceId, albumId: id });
      return `/albums/${enc(id)}`;
    },
  };
  const paths = await Promise.all(
    types
      .filter((key) => !type || type === key)
      .map(async (key) => {
        try {
          return await lookup[key]();
        } catch (e) {
          if ((e as { status?: number }).status === 404) return null;
          throw e;
        }
      }),
  );
  const hits = paths.filter((p) => p !== null);
  if (!hits.length)
    throw new CliError("NOT_FOUND", t("当前工作空间找不到资源"), 5);
  if (hits.length > 1)
    throw new CliError(
      "AMBIGUOUS_RESOURCE",
      t("资源 ID 有歧义，请指定 --type"),
      6,
    );
  const url = web + hits[0];
  const opened = !o.url && ctx.canOpen && !ctx.opts.dryRun;
  if (opened) {
    try {
      await openBrowser(url);
    } catch {
      throw new CliError(
        "BROWSER_OPEN_FAILED",
        t("无法启动浏览器，请使用 --url"),
        8,
        { url },
      );
    }
  }
  return { url, opened };
}

export function commands(root: Command, register: Register) {
  const add = (
    parent: Command,
    syntax: string,
    desc: string,
    run: Parameters<Register>[1],
    configure?: (cmd: Command) => Command,
  ) => {
    const cmd = parent.command(syntax).description(desc);
    register(configure ? configure(cmd) : cmd, run);
  };
  const group = (name: string, description: string) =>
    root.command(name).description(description);
  const config = group("config", t("管理本地配置"));
  add(config, "list", t("列出用户配置"), (ctx) => ctx.config());
  add(
    config,
    "get <key>",
    t("读取配置"),
    async (ctx, [key]) => ({
      key,
      value: (await ctx.config())[configKey(key)] ?? null,
    }),
    (c) => c.addHelpText("after", () => configHelp("get")),
  );
  add(
    config,
    "set <key> <value>",
    t("保存配置"),
    async (ctx, [key, raw]) => {
      const field = configKey(key);
      const value =
        configFields[field].format === "url"
          ? endpoint(raw, key)
          : required(raw, key);
      if (field === "lang" && !["en", "zh", "auto"].includes(value))
        throw usage(t("语言必须是 en、zh 或 auto"));
      if (field === "space")
        await (
          await ctx.client()
        )("space.detail", { id: value });
      if (ctx.opts.dryRun) return { dryRun: true, key, value };
      await ctx.setConfig(field, value);
      return { key, value };
    },
    (c) => c.addHelpText("after", () => configHelp("set")),
  );

  const identity = async (ctx: Context, token?: string, apiUrl?: string) => {
    const api = await ctx.client(token, apiUrl);
    try {
      const user = await api("user.self", { _full: "no" });
      return { id: user.id, name: user.name };
    } catch (error) {
      if ((error as { status?: number }).status !== 403) throw error;
      await api("my.spaces", {});
      return null;
    }
  };
  const credentialExpiry = async (
    ctx: Context,
    token: string,
    apiUrl?: string,
  ) => {
    if (!token || token.startsWith("dbk_")) return null;
    try {
      const detail = (await (
        await ctx.client(token, apiUrl)
      )("auth.detail", undefined)) as unknown as { expiredAt?: unknown };
      return typeof detail?.expiredAt === "string" ? detail.expiredAt : null;
    } catch (error) {
      if ((error as { status?: number }).status === 401) throw error;
      return null;
    }
  };
  const auth = group("auth", t("管理 DeckBase 身份"));
  add(
    auth,
    "login",
    t("通过浏览器授权登录，或导入 API Key / Token"),
    async (ctx, _, o) => {
      if (ctx.env.DECKFLOW_TOKEN)
        throw new CliError(
          "AUTH_ENV_OVERRIDE",
          t(
            "DECKFLOW_TOKEN 当前生效；请清除该环境变量后再登录。本地凭据未修改。",
          ),
          2,
          { source: "environment" },
        );
      const importToken = Boolean(o.withToken || o.tokenStdin);
      const requestedMode = authorizationMode(o.mode);
      if (requestedMode)
        process.stderr.write(
          t(
            "警告：--mode 已弃用。浏览器登录将签发独立的 CLI Token，30 天有效，授权工作空间读写。请使用 --with-token 导入已有凭据。\n",
          ),
        );
      if (requestedMode === "apikey")
        throw usage(
          t("不再支持 --mode apikey；请使用 --with-token 导入 API Key"),
        );
      const mode = "token" as const;
      if (importToken && requestedMode)
        throw usage(t("--mode 不能与 --with-token 或 --token-stdin 同时使用"));
      const apiUrl = await ctx.apiUrl();
      if (ctx.opts.dryRun) return { dryRun: true, apiUrl };
      if (!importToken)
        return browserLogin(
          ctx,
          apiUrl,
          mode,
          o.browser === undefined || Boolean(o.browser),
        );
      const token = (await stdinText()).trim();
      if (!token || /\s/.test(token))
        throw new CliError(
          "AUTH_REQUIRED",
          t("请通过 --with-token 从标准输入提供有效 Token 或 API Key"),
          3,
        );
      const user = await identity(ctx, token, apiUrl);
      await ctx.saveToken(apiUrl, token, {
        id:
          user?.id ||
          "credential-" +
            createHash("sha256").update(token).digest("hex").slice(0, 16),
        name: user?.name,
        expiredAt: await credentialExpiry(ctx, token, apiUrl),
        kind: token.startsWith("dbk_") ? "apikey" : "token",
      });
      return {
        authenticated: true,
        user,
        environmentTokenActive: !!ctx.env.DECKFLOW_TOKEN,
      };
    },
    (c) =>
      c
        .option(
          "--mode <mode>",
          t(
            "已弃用：token 显示警告，apikey 拒绝执行；请使用 --with-token 导入",
          ),
        )
        .option("--no-browser", t("只显示授权链接，不自动打开浏览器"))
        .option("--with-token", t("从标准输入导入 API Key 或 Token"))
        .option("--token-stdin", t("从标准输入读入 API Key 或 Token")),
  );
  add(auth, "accounts", t("列出本地保存的账号，隐藏凭据值"), (ctx) =>
    ctx.accountList(),
  );
  add(
    auth,
    "switch",
    t("切换当前 API 实例的活动账号"),
    async (ctx, _, o) => {
      if (ctx.env.DECKFLOW_TOKEN)
        throw new CliError(
          "AUTH_ENV_OVERRIDE",
          t(
            "DECKFLOW_TOKEN 当前生效；请清除该环境变量后再切换账号。本地凭据未修改。",
          ),
          2,
          { source: "environment" },
        );
      const accounts = await ctx.accountList();
      let selector = o.user;
      if (!selector) {
        const alternatives = accounts.filter((a) => !a.active);
        if (alternatives.length === 1) selector = alternatives[0].id;
        else if (ctx.interactive && accounts.length) {
          const rl = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          try {
            selector =
              accounts[
                integer(
                  await rl.question(
                    accounts
                      .map((a, i) => `${i + 1}. ${a.name || a.id}`)
                      .join("\n") +
                      "\n" +
                      t("账号序号：") +
                      " ",
                  ),
                  1,
                  accounts.length,
                ) - 1
              ].id;
          } finally {
            rl.close();
          }
        } else
          throw usage(t("请通过 --user 指定账号 ID，可用 auth accounts 查看"));
      }
      if (ctx.opts.dryRun)
        return {
          dryRun: true,
          account_id: selectAccount(accounts, selector).id,
        };
      return {
        api_url: await ctx.apiUrl(),
        source: "credential-store",
        account: await ctx.switchAccount(selector),
      };
    },
    (c) => c.option("--user <id>", t("账号 ID 或唯一名称")),
  );
  add(auth, "status", t("验证当前身份"), async (ctx) => {
    const user = await identity(ctx);
    const local = ctx.env.DECKFLOW_TOKEN ? undefined : await ctx.localAccount();
    return {
      authenticated: true,
      user,
      api_url: await ctx.apiUrl(),
      account_id: user?.id ?? local?.id ?? null,
      expiredAt:
        (await credentialExpiry(
          ctx,
          ctx.env.DECKFLOW_TOKEN || local?.token || "",
        )) ??
        local?.expiredAt ??
        null,
      source: ctx.env.DECKFLOW_TOKEN ? "environment" : "credential-store",
    };
  });
  add(
    auth,
    "logout",
    t("清除本地凭据"),
    async (ctx, _, o) => {
      if (ctx.opts.dryRun) return { dryRun: true, apiUrl: await ctx.apiUrl() };
      if (o.revoke) {
        if (ctx.env.DECKFLOW_TOKEN)
          throw new CliError(
            "AUTH_ENV_OVERRIDE",
            t("请清除 DECKFLOW_TOKEN 环境变量后再撤销本地凭据"),
            2,
          );
        const account = await ctx.localAccount();
        if (!account) throw usage(t("没有活动的本地凭据"));
        if (account.kind === "apikey" || account.token.startsWith("dbk_"))
          throw usage(t("请在 WebUI 的 API Key 设置中撤销密钥"));
        await (
          await ctx.client(account.token)
        )("auth.remove", undefined);
      }
      const removed = await ctx.clearToken(await ctx.apiUrl());
      if (ctx.env.DECKFLOW_TOKEN)
        process.stderr.write(t("DECKFLOW_TOKEN 仍然生效。\n"));
      return {
        localCredentialRemoved: removed,
        environmentTokenActive: !!ctx.env.DECKFLOW_TOKEN,
      };
    },
    (c) => c.option("--revoke", t("先撤销活动 Token，再移除本地凭据")),
  );
  add(root, "status", t("显示身份、地址和工作空间"), async (ctx) => ({
    apiUrl: await ctx.apiUrl(),
    webUrl: ctx.env.DECKFLOW_WEB_URL || (await ctx.config()).webUrl || null,
    space: await ctx.spaceInfo(),
    user: await identity(ctx),
  }));

  const space = group("space", t("管理工作空间"));
  add(space, "list", t("列出可访问的工作空间"), async (ctx) =>
    (await ctx.client())("my.spaces", {}),
  );
  add(space, "get [id]", t("查看工作空间"), async (ctx, [id]) =>
    (await ctx.client())("space.detail", { id: id ?? (await ctx.space()) }),
  );
  add(
    space,
    "create <name>",
    t("创建工作空间"),
    async (ctx, [name], o) => {
      const regionId = required(o.region, "--region");
      return (
        (await ctx.confirm(t("创建工作空间"), { name, regionId }, true)) ??
        (await ctx.client())("my.addSpace", { name, regionId })
      );
    },
    (c) => c.requiredOption("--region <id>", t("区域 ID")),
  );
  add(
    space,
    "use <id>",
    t("保存默认工作空间"),
    async (ctx, [id], o) => {
      await (
        await ctx.client()
      )("space.detail", { id });
      if (!ctx.opts.dryRun) {
        if (o.local) {
          const path = join(ctx.cwd, ".deckflow.json");
          await saveJson(path, {
            ...(await readJson<Config>(path)),
            space: id,
          });
        } else {
          await ctx.setConfig("space", id);
        }
      }
      return {
        space: id,
        source: o.local ? "project" : "user",
        ...(ctx.opts.dryRun && { dryRun: true }),
      };
    },
    (c) => c.option("--local", t("写入当前项目配置")),
  );
  add(
    space,
    "members [id]",
    t("列出空间成员"),
    async (ctx, [id], o) =>
      (await ctx.client())("space.users", {
        spaceId: id ?? (await ctx.space()),
        ...page(o),
      }),
    paginate,
  );

  const file = group("file", t("管理云端文件"));
  for (const parent of [root, file]) {
    add(
      parent,
      "upload [path]",
      t("上传单文件或目录"),
      (ctx, [path], o) => upload(ctx, path, o as UploadOptions),
      (c) =>
        c
          .option("--folder <path-or-id>")
          .option("--recursive")
          .option("--create-folders")
          .option("--ttl-days <days>")
          .option("--resume <operation-id>"),
    );
    add(
      parent,
      "download <file-id>",
      t("下载原文件或指定版本"),
      (ctx, [id], o) =>
        download(ctx, id, { ...o, overwrite: Boolean(o.overwrite) }),
      (c) =>
        c
          .option("--output <path>")
          .option("--revision <id>")
          .option("--overwrite"),
    );
  }
  add(
    file,
    "list",
    t("列出目录中的文件"),
    async (ctx, _, o) => {
      const spaceId = await ctx.space();
      const api = await ctx.client();
      const folderId = o.folder
        ? await folderPath(api, spaceId, o.folder)
        : null;
      return api("file.list", {
        spaceId,
        folderId,
        ...page(o),
        name: o.name,
        format: o.format,
        createdAfter: o.createdAfter,
        createdBefore: o.createdBefore,
      });
    },
    (c) =>
      paginate(c)
        .option("--folder <path-or-id>")
        .option("--name <name>")
        .option("--format <format>")
        .option("--created-after <date>")
        .option("--created-before <date>"),
  );
  add(file, "get <file-id>", t("查看文件"), async (ctx, [fileId]) =>
    (await ctx.client())("file.detail", { spaceId: await ctx.space(), fileId }),
  );
  add(
    file,
    "update <file-id>",
    t("修改文件属性"),
    async (ctx, [fileId], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const { rowVersion } = await api("file.detail", { spaceId, fileId });
      if (o.name === undefined && o.description === undefined)
        throw usage(t("请指定 --name 或 --description"));
      const params = {
        spaceId,
        fileId,
        expectedRowVersion: rowVersion,
        name: o.name,
        description: o.description,
      };
      return ctx.opts.dryRun
        ? { dryRun: true, ...params }
        : api("file.modify", params);
    },
    (c) => c.option("--name <name>").option("--description <text>"),
  );
  add(
    file,
    "move <file-id>",
    t("移动文件"),
    async (ctx, [fileId], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const { rowVersion } = await api("file.detail", { spaceId, fileId });
      const folderId = await folderPath(
        api,
        spaceId,
        required(o.folder, "--folder"),
      );
      const params = {
        spaceId,
        fileId,
        folderId,
        expectedRowVersion: rowVersion,
      };
      return ctx.opts.dryRun
        ? { dryRun: true, ...params }
        : api("file.move", params);
    },
    (c) => c.requiredOption("--folder <path-or-id>"),
  );
  add(
    file,
    "delete <file-id>",
    t("删除文件，返回删除任务"),
    async (ctx, [fileId]) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const { name, rowVersion } = await api("file.detail", {
        spaceId,
        fileId,
      });
      return (
        (await ctx.confirm(t("删除文件"), {
          spaceId,
          fileId,
          name,
          affects: ["revisions", "attachments"],
        })) ??
        api("file.remove", { spaceId, fileId, expectedRowVersion: rowVersion })
      );
    },
  );
  add(
    file,
    "convert [file-id]",
    t("转换为独立 PDF 文件"),
    (ctx, [id], o) => convert(ctx, id, o),
    (c) =>
      c
        .option("--to <format>")
        .option("--folder <path-or-id>")
        .option("--name <name>")
        .option("--revision <id>")
        .option("--resume <operation-id>"),
  );
  const conversions = file.command("conversion").description(t("查询转换任务"));
  add(
    conversions,
    "list <file-id>",
    t("列出文件版本的转换任务"),
    async (ctx, [fileId], o) =>
      (await ctx.client())("conversion.list", {
        spaceId: await ctx.space(),
        fileId,
        revisionId: required(o.revision, "--revision"),
      }),
    (c) => c.requiredOption("--revision <id>"),
  );
  add(
    conversions,
    "get <operation-id>",
    t("查询转换任务"),
    async (ctx, [operationId], o) =>
      (await ctx.client())("conversion.detail", {
        spaceId: await ctx.space(),
        fileId: required(o.file, "--file"),
        revisionId: required(o.revision, "--revision"),
        operationId,
      }),
    (c) => c.requiredOption("--file <id>").requiredOption("--revision <id>"),
  );
  add(
    file.command("creation"),
    "get <operation-id>",
    t("查询文件创建任务"),
    async (ctx, [operationId]) =>
      (await ctx.client())("file.creationDetail", {
        spaceId: await ctx.space(),
        operationId,
      }),
  );
  add(
    file.command("deletion"),
    "get <id>",
    t("查询删除任务"),
    async (ctx, [id]) =>
      (await ctx.client())("deletionJob.detail", {
        spaceId: await ctx.space(),
        id,
      }),
  );

  const rev = group("revision", t("管理文件版本"));
  add(
    rev,
    "list <file-id>",
    t("列出版本"),
    async (ctx, [fileId], o) =>
      (await ctx.client())("revision.list", {
        spaceId: await ctx.space(),
        fileId,
        ...page(o),
      }),
    paginate,
  );
  add(
    rev,
    "get <revision-id>",
    t("查看版本"),
    async (ctx, [revisionId], o) =>
      (await ctx.client())("revision.detail", {
        spaceId: await ctx.space(),
        fileId: required(o.file, "--file"),
        revisionId,
      }),
    (c) => c.requiredOption("--file <id>"),
  );
  add(rev, "upload <file-id> <path>", t("上传新版本"), (ctx, [fileId, path]) =>
    upload(ctx, path, {}, fileId),
  );
  for (const action of ["restore", "delete"] as const) {
    add(
      rev,
      `${action} <revision-id>`,
      action === "restore"
        ? t("用历史版本创建新的当前版本")
        : t("删除版本，返回删除任务"),
      async (ctx, [revisionId], o) => {
        const api = await ctx.client(),
          spaceId = await ctx.space(),
          fileId = required(o.file, "--file");
        const base = { spaceId, fileId, revisionId };
        const file = await api("file.detail", { spaceId, fileId });
        await api("revision.detail", base);
        if (o.replacement)
          await api("revision.detail", { ...base, revisionId: o.replacement });
        const params = {
          ...base,
          expectedCurrentRevisionId: file.currentRevisionId ?? null,
        };
        return (
          (await ctx.confirm(
            action === "restore" ? t("恢复为新版本") : t("删除版本"),
            { ...params, replacementRevisionId: o.replacement },
          )) ??
          (action === "restore"
            ? api("revision.restore", {
                ...params,
                changeSummary: o.summary,
                idempotencyKey: randomUUID(),
              })
            : api("revision.remove", {
                ...params,
                replacementRevisionId: o.replacement,
              }))
        );
      },
      (c) =>
        c
          .requiredOption("--file <id>")
          .option(
            action === "restore"
              ? "--summary <text>"
              : "--replacement <revision-id>",
          ),
    );
  }

  const folder = group("folder", t("管理文件夹"));
  add(
    folder,
    "list",
    t("列出子文件夹"),
    async (ctx, _, o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const parentId = o.parent
        ? await folderPath(api, spaceId, o.parent)
        : null;
      return api("folder.list", { spaceId, parentId, ...page(o) });
    },
    (c) => paginate(c).option("--parent <path-or-id>"),
  );
  add(folder, "get <path-or-id>", t("查看文件夹"), async (ctx, [id]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    return api("folder.detail", {
      spaceId,
      folderId: required(
        (await folderPath(api, spaceId, id)) ?? undefined,
        t("非根目录"),
      ),
    });
  });
  add(
    folder,
    "create <name-or-path>",
    t("创建文件夹"),
    async (ctx, [value], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      if (value.startsWith("/") && o.parent)
        throw usage(t("绝对目录路径不能与 --parent 合用"));
      const name = value.startsWith("/") ? basename(value) : value;
      if (!name || [".", ".."].includes(name) || name.includes("/"))
        throw usage(t("无效文件夹名称"));
      const parent = value.startsWith("/") ? dirname(value) : o.parent;
      const parentId = parent ? await folderPath(api, spaceId, parent) : null;
      const params = { spaceId, parentId, name, description: o.description };
      return ctx.opts.dryRun
        ? { dryRun: true, ...params }
        : api("folder.add", params);
    },
    (c) => c.option("--parent <path-or-id>").option("--description <text>"),
  );
  for (const action of ["update", "move", "delete"] as const) {
    add(
      folder,
      `${action} <path-or-id>`,
      {
        update: t("修改文件夹"),
        move: t("移动文件夹"),
        delete: t("删除文件夹"),
      }[action],
      async (ctx, [id], o) => {
        const api = await ctx.client(),
          spaceId = await ctx.space();
        const folderId = required(
          (await folderPath(api, spaceId, id)) ?? undefined,
          t("非根目录"),
        );
        const { rowVersion, name } = await api("folder.detail", {
          spaceId,
          folderId,
        });
        const base = { spaceId, folderId, expectedRowVersion: rowVersion };
        if (action === "update") {
          if (o.name === undefined && o.description === undefined)
            throw usage(t("请指定 --name 或 --description"));
          const params = { ...base, name: o.name, description: o.description };
          return ctx.opts.dryRun
            ? { dryRun: true, ...params }
            : api("folder.modify", params);
        }
        if (action === "move") {
          const parentId = await folderPath(
            api,
            spaceId,
            required(o.parent, "--parent"),
          );
          const params = { ...base, parentId };
          return ctx.opts.dryRun
            ? { dryRun: true, ...params }
            : api("folder.move", params);
        }
        const recursive = Boolean(o.recursive);
        return (
          (await ctx.confirm(t("删除文件夹"), {
            spaceId,
            folderId,
            name,
            recursive,
          })) ?? api("folder.remove", { ...base, recursive })
        );
      },
      (c) =>
        action === "update"
          ? c.option("--name <name>").option("--description <text>")
          : action === "move"
            ? c.requiredOption("--parent <path-or-id>")
            : c.option("--recursive"),
    );
  }

  add(
    root,
    "open <id>",
    t("打开 WebUI 文件、分享或专辑"),
    (ctx, [id], o) => openResource(ctx, id, o),
    (c) =>
      c
        .option("--type <type>")
        .option("--url")
        .option("--page <n>")
        .option("--revision <id>")
        .option("--block <id>"),
  );
  const share = group("share", t("管理分享页"));
  add(
    share,
    "open <id>",
    t("打开分享页"),
    (ctx, [id], o) => openResource(ctx, id, o, true),
    (c) => c.option("--url"),
  );
  add(
    share,
    "list",
    t("列出分享页"),
    async (ctx, _, o) =>
      (await ctx.client())("sharePage.list", {
        spaceId: await ctx.space(),
        ...modernPage(o),
      }),
    paginate,
  );
  add(share, "get <id>", t("查看分享页"), async (ctx, [id]) =>
    (await ctx.client())("sharePage.detail", {
      spaceId: await ctx.space(),
      id,
    }),
  );
  add(
    share,
    "create",
    t("创建分享并添加文件"),
    async (ctx, _, o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const input = await inputJson(o.input);
      const title = required(
        o.title ?? (typeof input.title === "string" ? input.title : undefined),
        "--title",
      );
      const files = [
        ...new Set(
          (o.files ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      for (const fileId of files) await api("file.detail", { spaceId, fileId });
      const preview = await ctx.confirm(
        t("创建分享页"),
        { spaceId, title, files },
        true,
      );
      if (preview) return preview;
      const created = await api("sharePage.add", {
        ...input,
        spaceId,
        title,
        idempotencyKey: randomUUID(),
      });
      let rowVersion = created.rowVersion;
      const results = [];
      for (const fileId of files) {
        try {
          const item = await api("sharePage.addItem", {
            spaceId,
            id: created.id,
            fileId,
            rowVersion,
            type: "document",
          });
          rowVersion = item.rowVersion;
          results.push({ fileId, ok: true, result: item.item });
        } catch (error) {
          results.push({ fileId, ok: false, error });
          // A failed request can have committed. Preserve the visible progress and stop.
          for (const remaining of files.slice(results.length))
            results.push({
              fileId: remaining,
              ok: false,
              error: new CliError(
                "NOT_ATTEMPTED",
                t("前序条目失败，未添加此条目"),
                10,
              ),
            });
          break;
        }
      }
      return {
        batch: true as const,
        baseSucceeded: true,
        id: created.id,
        slug: created.slug,
        results,
      };
    },
    (c) => payload(c).option("--title <title>").option("--files <id,id>"),
  );
  add(
    share,
    "update <id>",
    t("更新分享页属性或策略"),
    async (ctx, [id], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const input = withOptions(await inputJson(o.input), {
        title: o.title,
        description: o.description,
      });
      if (!Object.keys(input).length)
        throw usage(t("请通过 --input 或选项指定要更新的属性"));
      const {
        page: { rowVersion },
      } = await api("sharePage.detail", { spaceId, id });
      return (
        (await ctx.confirm(t("更新分享页"), {
          spaceId,
          id,
          fields: Object.keys(input),
        })) ?? api("sharePage.modify", { ...input, spaceId, id, rowVersion })
      );
    },
    (c) => payload(c).option("--title <title>").option("--description <text>"),
  );
  add(share, "revoke <id>", t("禁用分享页"), async (ctx, [id]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    const {
      page: { rowVersion, slug },
    } = await api("sharePage.detail", { spaceId, id });
    return (
      (await ctx.confirm(t("禁用分享页"), { spaceId, id, slug })) ??
      api("sharePage.modify", { spaceId, id, rowVersion, status: "disabled" })
    );
  });

  const album = group("album", t("管理文件夹专辑"));
  add(
    album,
    "list",
    t("列出专辑"),
    async (ctx, _, o) =>
      (await ctx.client())("album.list", {
        spaceId: await ctx.space(),
        ...modernPage(o),
      }),
    paginate,
  );
  add(album, "get <id>", t("查看专辑"), async (ctx, [albumId]) =>
    (await ctx.client())("album.detail", {
      spaceId: await ctx.space(),
      albumId,
    }),
  );
  add(
    album,
    "subscribers <id>",
    t("列出订阅"),
    async (ctx, [albumId], o) =>
      (await ctx.client())("album.subscriptions", {
        spaceId: await ctx.space(),
        albumId,
        ...modernPage(o),
      }),
    paginate,
  );
  add(
    album,
    "create",
    t("创建动态专辑"),
    async (ctx, _, o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const input = await inputJson(o.input);
      const title = required(
        o.name ?? (typeof input.title === "string" ? input.title : undefined),
        "--name",
      );
      const folderId = required(
        (await folderPath(
          api,
          spaceId,
          required(
            o.folder ??
              (typeof input.folderId === "string" ? input.folderId : undefined),
            "--folder",
          ),
        )) ?? undefined,
        t("非根目录"),
      );
      const config = {
        description: "",
        coverAssetId: null,
        previewMode: "disabled",
        previewValue: null,
        downloadPolicy: "disabled",
        watermarkMode: "disabled",
        watermarkText: null,
        paymentEnabled: false,
        voucherEnabled: false,
        customerEnabled: false,
        allowedCustomerLevelIds: [],
        freeFileIds: [],
        plans: [],
        publicEnabled: false,
        ...input,
        title,
        folderId,
      } as Params<"album.add">["config"];
      return (
        (await ctx.confirm(
          t("创建专辑"),
          { spaceId, folderId, title },
          true,
        )) ??
        api("album.add", { spaceId, config, idempotencyKey: randomUUID() })
      );
    },
    (c) => payload(c).option("--name <name>").option("--folder <path-or-id>"),
  );
  add(
    album,
    "update <id>",
    t("替换专辑配置"),
    async (ctx, [albumId], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const config = (await inputJson(
        required(o.input, "--input"),
      )) as Params<"album.modify">["config"];
      const { rowVersion } = await api("album.detail", { spaceId, albumId });
      if (typeof rowVersion !== "number")
        throw new CliError("INVALID_ALBUM_VERSION", t("服务端缺少专辑版本"), 9);
      return (
        (await ctx.confirm(t("替换专辑配置"), {
          spaceId,
          albumId,
          fields: Object.keys(config),
        })) ?? api("album.modify", { spaceId, albumId, rowVersion, config })
      );
    },
    payload,
  );
  add(album, "delete <id>", t("删除专辑"), async (ctx, [albumId]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    const current = await api("album.detail", { spaceId, albumId });
    return (
      (await ctx.confirm(t("删除专辑"), {
        spaceId,
        albumId,
        title: current.title,
        affects: ["subscriptions", "public access"],
      })) ?? api("album.remove", { spaceId, albumId })
    );
  });

  const billing = group("usage", t("查看服务端用量"));
  const usageCommand = (mode: string) => async (ctx: Context) => {
    const result = await (
      await ctx.client()
    )("billing.detail", { spaceId: await ctx.space() });
    const fields =
      {
        summary: [
          "plan",
          "period",
          "balance_units",
          "balance",
          "storage_bytes",
          "egress_used_bytes",
          "billing_suspended",
        ],
        storage: [
          "storage_bytes",
          "storage_excess_bytes",
          "storage_debt_units",
          "storage_write_restricted",
        ],
        traffic: [
          "egress_used_bytes",
          "egress_pending_bytes",
          "egress_excess_bytes",
          "egress_frozen_units",
        ],
        credits: [
          "available_units",
          "frozen_units",
          "balance_units",
          "balance",
        ],
      }[mode] ?? [];
    return Object.fromEntries(
      Object.entries(result).filter(([key]) => fields.includes(key)),
    );
  };
  register(billing, usageCommand("summary"));
  for (const mode of ["summary", "storage", "traffic", "credits"])
    add(billing, mode, t("查看用量"), usageCommand(mode));

  add(
    root,
    "api <sdk-method>",
    t("直接调用 DeckBase SDK 方法"),
    async (ctx, [name], o) => {
      const method = methodOf(name);
      const params = await inputJson(o.input);
      if (ctx.opts.dryRun)
        return {
          dryRun: true,
          method,
          fields: Object.keys(params),
          writes: !isRead(method),
        };
      if (!isRead(method) && !ctx.opts.yes)
        throw usage(t("非只读 SDK 调用需要显式 --yes"));
      return (await ctx.client())(method, params as Params<Method>);
    },
    (c) => c.option("--input <json-file|->", t("读取 SDK 参数 JSON")),
  );

  function placeholder(parent: Command, name: string, label = name) {
    add(
      parent,
      `${name} [args...]`,
      t("后续支持"),
      async () => {
        throw unsupported(label);
      },
      (c) => c.allowUnknownOption().allowExcessArguments(),
    );
  }
  for (const name of ["find", "search", "ask"]) placeholder(root, name);
  for (const name of ["archive", "restore"])
    placeholder(file, name, `file ${name}`);
  placeholder(rev, "activate", "revision activate");
  const action = group("action", t("通用任务，后续支持"));
  for (const name of ["list", "run", "status", "cancel"])
    placeholder(action, name, `action ${name}`);
}
