import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Method, Params } from "@deckflow/deckbase-sdk";
import type { Command } from "commander";
import openBrowser from "open";
import {
  CliError,
  Context,
  configFields,
  configKey,
  endpoint,
  hiddenToken,
  inputJson,
  isRead,
  methodOf,
  page,
  saveJson,
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
  c.option("--limit <n>", "每页条数，1–100").option("--offset <n>", "分页偏移");
const payload = (c: Command) =>
  c.option("--input <json-file|->", "从文件或标准输入读取 JSON");
function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw usage(`缺少 ${option}`);
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
    return `  ${label.padEnd(16)} ${field.description}`;
  });
  if (action === "set") {
    lines.push(
      "",
      "URL 必须是完整的 HTTP(S) 地址，不可包含用户名、密码、查询参数或片段。",
      "空间 ID 可从 deckflow space list 获取，保存时会验证当前凭据的访问权限。",
      "",
      "示例：",
      ...fields.map(
        ([key, field]) => `  deckflow config set ${key} ${field.example}`,
      ),
    );
  }
  return `
支持的配置项（键名区分大小写）：
${lines.join("\n")}`;
}

async function openResource(
  ctx: Context,
  id: string,
  o: Options,
  forceShare = false,
) {
  if (o.page !== undefined || o.revision !== undefined || o.block !== undefined)
    throw unsupported("文件版本或页面深链接");
  const type = forceShare ? "share" : o.type;
  const types = ["file", "share", "album"] as const;
  if (type && !types.includes(type as (typeof types)[number]))
    throw usage("--type 必须是 file、share 或 album");
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
    throw new CliError("NOT_FOUND", "当前工作空间找不到资源", 5);
  if (hits.length > 1)
    throw new CliError(
      "AMBIGUOUS_RESOURCE",
      "资源 ID 有歧义，请指定 --type",
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
        "无法启动浏览器，请使用 --url",
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
  const config = group("config", "管理本地配置");
  add(config, "list", "列出用户配置", (ctx) => ctx.config());
  add(
    config,
    "get <key>",
    "读取配置",
    async (ctx, [key]) => ({
      key,
      value: (await ctx.config())[configKey(key)] ?? null,
    }),
    (c) => c.addHelpText("after", configHelp("get")),
  );
  add(
    config,
    "set <key> <value>",
    "保存配置",
    async (ctx, [key, raw]) => {
      const field = configKey(key);
      const value =
        configFields[field].format === "url"
          ? endpoint(raw, key)
          : required(raw, key);
      if (field === "space")
        await (
          await ctx.client()
        )("space.detail", { id: value });
      if (ctx.opts.dryRun) return { dryRun: true, key, value };
      await saveJson(ctx.configPath, {
        ...(await ctx.config()),
        [field]: value,
      });
      return { key, value };
    },
    (c) => c.addHelpText("after", configHelp("set")),
  );

  const identity = async (ctx: Context, token?: string) => {
    const user = await (await ctx.client(token))("user.self", { _full: "no" });
    return { id: user.id, name: user.name };
  };
  const auth = group("auth", "管理 DeckBase 身份");
  add(
    auth,
    "login",
    "导入并验证 API Key 或 Token",
    async (ctx, _, o) => {
      if (ctx.opts.dryRun) return { dryRun: true, apiUrl: await ctx.apiUrl() };
      const token = (
        o.tokenStdin
          ? await stdinText()
          : ctx.env.DECKFLOW_TOKEN ||
            (ctx.interactive ? await hiddenToken() : "")
      ).trim();
      if (!token || /\s/.test(token))
        throw new CliError(
          "AUTH_REQUIRED",
          "请提供有效 Token，使用 --token-stdin 或 DECKFLOW_TOKEN",
          3,
        );
      const user = await identity(ctx, token);
      await ctx.credentialStore(await ctx.apiUrl()).set(token);
      return {
        authenticated: true,
        user,
        environmentTokenActive: !!ctx.env.DECKFLOW_TOKEN,
      };
    },
    (c) => c.option("--token-stdin", "从标准输入读入 Token"),
  );
  add(auth, "status", "验证当前身份", async (ctx) => ({
    authenticated: true,
    user: await identity(ctx),
    source: ctx.env.DECKFLOW_TOKEN ? "environment" : "credential-store",
  }));
  add(auth, "logout", "清除本地凭据", async (ctx) => {
    if (ctx.opts.dryRun) return { dryRun: true, apiUrl: await ctx.apiUrl() };
    await ctx.credentialStore(await ctx.apiUrl()).clear();
    if (ctx.env.DECKFLOW_TOKEN)
      process.stderr.write("DECKFLOW_TOKEN 仍然生效。\n");
    return {
      localCredentialRemoved: true,
      environmentTokenActive: !!ctx.env.DECKFLOW_TOKEN,
    };
  });
  add(root, "status", "显示身份、地址和工作空间", async (ctx) => ({
    apiUrl: await ctx.apiUrl(),
    webUrl: ctx.env.DECKFLOW_WEB_URL || (await ctx.config()).webUrl || null,
    space: await ctx.spaceInfo(),
    user: await identity(ctx),
  }));

  const space = group("space", "管理工作空间");
  add(space, "list", "列出可访问的工作空间", async (ctx) =>
    (await ctx.client())("my.spaces", {}),
  );
  add(space, "get [id]", "查看工作空间", async (ctx, [id]) =>
    (await ctx.client())("space.detail", { id: id ?? (await ctx.space()) }),
  );
  add(
    space,
    "create <name>",
    "创建工作空间",
    async (ctx, [name], o) => {
      const regionId = required(o.region, "--region");
      return (
        (await ctx.confirm("创建工作空间", { name, regionId }, true)) ??
        (await ctx.client())("my.addSpace", { name, regionId })
      );
    },
    (c) => c.requiredOption("--region <id>", "区域 ID"),
  );
  add(
    space,
    "use <id>",
    "保存默认工作空间",
    async (ctx, [id], o) => {
      await (
        await ctx.client()
      )("space.detail", { id });
      const path = o.local ? join(ctx.cwd, ".deckflow.json") : ctx.configPath;
      if (!ctx.opts.dryRun)
        await saveJson(path, {
          ...(await ctx.config(path)),
          space: id,
        });
      return {
        space: id,
        source: o.local ? "project" : "user",
        ...(ctx.opts.dryRun && { dryRun: true }),
      };
    },
    (c) => c.option("--local", "写入当前项目配置"),
  );
  add(
    space,
    "members [id]",
    "列出空间成员",
    async (ctx, [id], o) =>
      (await ctx.client())("space.users", {
        spaceId: id ?? (await ctx.space()),
        ...page(o),
      }),
    paginate,
  );

  const file = group("file", "管理云端文件");
  for (const parent of [root, file]) {
    add(
      parent,
      "upload [path]",
      "上传单文件或目录",
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
      "下载原文件或指定版本",
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
    "列出目录中的文件",
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
  add(file, "get <file-id>", "查看文件", async (ctx, [fileId]) =>
    (await ctx.client())("file.detail", { spaceId: await ctx.space(), fileId }),
  );
  add(
    file,
    "update <file-id>",
    "修改文件属性",
    async (ctx, [fileId], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const { rowVersion } = await api("file.detail", { spaceId, fileId });
      if (o.name === undefined && o.description === undefined)
        throw usage("请指定 --name 或 --description");
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
    "移动文件",
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
    "删除文件，返回删除任务",
    async (ctx, [fileId]) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const { name, rowVersion } = await api("file.detail", {
        spaceId,
        fileId,
      });
      return (
        (await ctx.confirm("删除文件", {
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
    "转换为独立 PDF 文件",
    (ctx, [id], o) => convert(ctx, id, o),
    (c) =>
      c
        .option("--to <format>")
        .option("--folder <path-or-id>")
        .option("--name <name>")
        .option("--revision <id>")
        .option("--resume <operation-id>"),
  );
  const conversions = file.command("conversion").description("查询转换任务");
  add(
    conversions,
    "list <file-id>",
    "列出文件版本的转换任务",
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
    "查询转换任务",
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
    "查询文件创建任务",
    async (ctx, [operationId]) =>
      (await ctx.client())("file.creationDetail", {
        spaceId: await ctx.space(),
        operationId,
      }),
  );
  add(file.command("deletion"), "get <id>", "查询删除任务", async (ctx, [id]) =>
    (await ctx.client())("deletionJob.detail", {
      spaceId: await ctx.space(),
      id,
    }),
  );

  const rev = group("revision", "管理文件版本");
  add(
    rev,
    "list <file-id>",
    "列出版本",
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
    "查看版本",
    async (ctx, [revisionId], o) =>
      (await ctx.client())("revision.detail", {
        spaceId: await ctx.space(),
        fileId: required(o.file, "--file"),
        revisionId,
      }),
    (c) => c.requiredOption("--file <id>"),
  );
  add(rev, "upload <file-id> <path>", "上传新版本", (ctx, [fileId, path]) =>
    upload(ctx, path, {}, fileId),
  );
  for (const action of ["restore", "delete"] as const) {
    add(
      rev,
      `${action} <revision-id>`,
      action === "restore"
        ? "用历史版本创建新的当前版本"
        : "删除版本，返回删除任务",
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
            action === "restore" ? "恢复为新版本" : "删除版本",
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

  const folder = group("folder", "管理文件夹");
  add(
    folder,
    "list",
    "列出子文件夹",
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
  add(folder, "get <path-or-id>", "查看文件夹", async (ctx, [id]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    return api("folder.detail", {
      spaceId,
      folderId: required(
        (await folderPath(api, spaceId, id)) ?? undefined,
        "非根目录",
      ),
    });
  });
  add(
    folder,
    "create <name-or-path>",
    "创建文件夹",
    async (ctx, [value], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      if (value.startsWith("/") && o.parent)
        throw usage("绝对目录路径不能与 --parent 合用");
      const name = value.startsWith("/") ? basename(value) : value;
      if (!name || [".", ".."].includes(name) || name.includes("/"))
        throw usage("无效文件夹名称");
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
      { update: "修改文件夹", move: "移动文件夹", delete: "删除文件夹" }[
        action
      ],
      async (ctx, [id], o) => {
        const api = await ctx.client(),
          spaceId = await ctx.space();
        const folderId = required(
          (await folderPath(api, spaceId, id)) ?? undefined,
          "非根目录",
        );
        const { rowVersion, name } = await api("folder.detail", {
          spaceId,
          folderId,
        });
        const base = { spaceId, folderId, expectedRowVersion: rowVersion };
        if (action === "update") {
          if (o.name === undefined && o.description === undefined)
            throw usage("请指定 --name 或 --description");
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
          (await ctx.confirm("删除文件夹", {
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
    "打开 WebUI 文件、分享或专辑",
    (ctx, [id], o) => openResource(ctx, id, o),
    (c) =>
      c
        .option("--type <type>")
        .option("--url")
        .option("--page <n>")
        .option("--revision <id>")
        .option("--block <id>"),
  );
  const share = group("share", "管理分享页");
  add(
    share,
    "open <id>",
    "打开分享页",
    (ctx, [id], o) => openResource(ctx, id, o, true),
    (c) => c.option("--url"),
  );
  add(
    share,
    "list",
    "列出分享页",
    async (ctx, _, o) =>
      (await ctx.client())("sharePage.list", {
        spaceId: await ctx.space(),
        ...modernPage(o),
      }),
    paginate,
  );
  add(share, "get <id>", "查看分享页", async (ctx, [id]) =>
    (await ctx.client())("sharePage.detail", {
      spaceId: await ctx.space(),
      id,
    }),
  );
  add(
    share,
    "create",
    "创建分享并添加文件",
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
        "创建分享页",
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
                "前序条目失败，未添加此条目",
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
    "更新分享页属性或策略",
    async (ctx, [id], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const input = withOptions(await inputJson(o.input), {
        title: o.title,
        description: o.description,
      });
      if (!Object.keys(input).length)
        throw usage("请通过 --input 或选项指定要更新的属性");
      const {
        page: { rowVersion },
      } = await api("sharePage.detail", { spaceId, id });
      return (
        (await ctx.confirm("更新分享页", {
          spaceId,
          id,
          fields: Object.keys(input),
        })) ?? api("sharePage.modify", { ...input, spaceId, id, rowVersion })
      );
    },
    (c) => payload(c).option("--title <title>").option("--description <text>"),
  );
  add(share, "revoke <id>", "禁用分享页", async (ctx, [id]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    const {
      page: { rowVersion, slug },
    } = await api("sharePage.detail", { spaceId, id });
    return (
      (await ctx.confirm("禁用分享页", { spaceId, id, slug })) ??
      api("sharePage.modify", { spaceId, id, rowVersion, status: "disabled" })
    );
  });

  const album = group("album", "管理文件夹专辑");
  add(
    album,
    "list",
    "列出专辑",
    async (ctx, _, o) =>
      (await ctx.client())("album.list", {
        spaceId: await ctx.space(),
        ...modernPage(o),
      }),
    paginate,
  );
  add(album, "get <id>", "查看专辑", async (ctx, [albumId]) =>
    (await ctx.client())("album.detail", {
      spaceId: await ctx.space(),
      albumId,
    }),
  );
  add(
    album,
    "subscribers <id>",
    "列出订阅",
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
    "创建动态专辑",
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
        "非根目录",
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
        (await ctx.confirm("创建专辑", { spaceId, folderId, title }, true)) ??
        api("album.add", { spaceId, config, idempotencyKey: randomUUID() })
      );
    },
    (c) => payload(c).option("--name <name>").option("--folder <path-or-id>"),
  );
  add(
    album,
    "update <id>",
    "替换专辑配置",
    async (ctx, [albumId], o) => {
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const config = (await inputJson(
        required(o.input, "--input"),
      )) as Params<"album.modify">["config"];
      const { rowVersion } = await api("album.detail", { spaceId, albumId });
      if (typeof rowVersion !== "number")
        throw new CliError("INVALID_ALBUM_VERSION", "服务端缺少专辑版本", 9);
      return (
        (await ctx.confirm("替换专辑配置", {
          spaceId,
          albumId,
          fields: Object.keys(config),
        })) ?? api("album.modify", { spaceId, albumId, rowVersion, config })
      );
    },
    payload,
  );
  add(album, "delete <id>", "删除专辑", async (ctx, [albumId]) => {
    const api = await ctx.client(),
      spaceId = await ctx.space();
    const current = await api("album.detail", { spaceId, albumId });
    return (
      (await ctx.confirm("删除专辑", {
        spaceId,
        albumId,
        title: current.title,
        affects: ["subscriptions", "public access"],
      })) ?? api("album.remove", { spaceId, albumId })
    );
  });

  const billing = group("usage", "查看服务端用量");
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
    add(billing, mode, "查看用量", usageCommand(mode));

  add(
    root,
    "api <sdk-method>",
    "直接调用 DeckBase SDK 方法",
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
        throw usage("非只读 SDK 调用需要显式 --yes");
      return (await ctx.client())(method, params as Params<Method>);
    },
    (c) => c.option("--input <json-file|->", "读取 SDK 参数 JSON"),
  );

  function placeholder(parent: Command, name: string, label = name) {
    add(
      parent,
      `${name} [args...]`,
      "后续支持",
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
  const action = group("action", "通用任务，后续支持");
  for (const name of ["list", "run", "status", "cancel"])
    placeholder(action, name, `action ${name}`);
}
