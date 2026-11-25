import { Command } from "commander";
import { basename, dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { commands as legacy } from "./commands.js";
import {
  CliError,
  Context,
  integer,
  poll,
  unsupported,
  usage,
  type ApiCall,
} from "./core.js";
import { upload, download, finishFile } from "./files.js";

type Options = Record<string, string | undefined>;
type Run = (ctx: Context, args: string[], opts: Options) => Promise<unknown>;
type Register = (cmd: Command, run: Run) => void;
type ObjectRow = {
  id: string;
  name: string;
  kind: "file" | "directory";
  path: string;
  workspace_id: string;
  version?: string;
  rowVersion?: number;
  currentRevisionId?: string | null;
  [key: string]: unknown;
};
const fail = (code: string, message: string, exit = 2): never => {
  throw new CliError(code, message, exit);
};
function remote(value: string) {
  if (value.startsWith("id:")) {
    if (!/^[A-Za-z0-9_]+$/.test(value.slice(3))) throw usage("无效对象 ID");
    return value;
  }
  if (
    !value.startsWith("/") ||
    /[\\\x00-\x1f]/.test(value) ||
    value.split("/").some((x) => x === "." || x === "..") ||
    value.includes("//")
  )
    throw usage("远端对象需要绝对路径或 id:<id>");
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}
async function all(api: ApiCall, ws: string, parent: string | null) {
  const result: ObjectRow[] = [];
  for (const kind of ["directory", "file"] as const) {
    for (let offset = 0; ;) {
      const page =
        kind === "file"
          ? await api("file.list", {
              spaceId: ws,
              folderId: parent,
              _startIndex: offset,
              _maxResults: 100,
            })
          : await api("folder.list", {
              spaceId: ws,
              parentId: parent,
              _startIndex: offset,
              _maxResults: 100,
            });
      result.push(
        ...page.rows.map((row) => ({
          ...row,
          kind,
          workspace_id: ws,
          path: "",
          version: Buffer.from(
            JSON.stringify({
              id: row.id,
              row: row.rowVersion,
              revision:
                "currentRevisionId" in row ? row.currentRevisionId : null,
            }),
          ).toString("base64url"),
        })),
      );
      offset += page.rows.length;
      if (!page.rows.length || offset >= page.count) break;
    }
  }
  return result.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id),
  );
}
async function canonical(
  api: ApiCall,
  ws: string,
  row: ObjectRow,
): Promise<ObjectRow> {
  const names = [row.name];
  let parent = (row.kind === "file" ? row.folderId : row.parentId) as
    string | null;
  const seen = new Set<string>();
  let pathAvailable = true;
  while (parent) {
    if (seen.has(parent)) throw usage("目录层级循环");
    seen.add(parent);
    try {
      const p = await api("folder.detail", { spaceId: ws, folderId: parent });
      names.unshift(p.name);
      parent = p.parentId ?? null;
    } catch (error) {
      if (
        row.kind !== "file" ||
        ![403, 404].includes((error as { status?: number }).status ?? 0)
      )
        throw error;
      pathAvailable = false;
      break;
    }
  }
  return {
    ...row,
    path: pathAvailable ? "/" + names.join("/") : "id:" + row.id,
    ...(pathAvailable ? {} : { path_status: "unavailable" }),
    workspace_id: ws,
    version: Buffer.from(
      JSON.stringify({
        id: row.id,
        row: row.rowVersion,
        revision: row.currentRevisionId ?? null,
      }),
    ).toString("base64url"),
  };
}
async function resolveObject(
  ctx: Context,
  value: string,
  expectedKind?: "file" | "directory",
): Promise<ObjectRow> {
  value = remote(value);
  const ws = await ctx.space(),
    api = await ctx.client();
  if (value === "/" || value === "id:root")
    return {
      id: "root",
      name: "",
      kind: "directory",
      path: "/",
      workspace_id: ws,
    };
  if (value.startsWith("id:")) {
    const hits: ObjectRow[] = [];
    for (const kind of expectedKind
      ? [expectedKind]
      : (["file", "directory"] as const))
      try {
        const row =
          kind === "file"
            ? await api("file.detail", { spaceId: ws, fileId: value.slice(3) })
            : await api("folder.detail", {
                spaceId: ws,
                folderId: value.slice(3),
              });
        hits.push(
          await canonical(api, ws, {
            ...row,
            kind,
            path: "",
            workspace_id: ws,
          }),
        );
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
    if (hits.length !== 1)
      return fail(
        hits.length ? "TYPE_MISMATCH" : "OBJECT_NOT_FOUND",
        "对象不存在或 ID 有歧义",
        5,
      );
    return hits[0];
  }
  let parent: string | null = null,
    current: ObjectRow | undefined;
  let path = "";
  const parts = value.slice(1).split("/");
  for (let i = 0; i < parts.length; i++) {
    const hits: ObjectRow[] = (await all(api, ws, parent)).filter(
      (r) => r.name === parts[i],
    );
    if (hits.length !== 1)
      return fail(
        hits.length ? "TYPE_MISMATCH" : "OBJECT_NOT_FOUND",
        "路径不存在或存在歧义",
        5,
      );
    current = hits[0];
    path += "/" + current.name;
    current.path = path;
    if (i < parts.length - 1 && current.kind !== "directory")
      return fail("NOT_A_DIRECTORY", "路径经过文件");
    parent = current.id;
  }
  return current!;
}
async function maybe(ctx: Context, path: string) {
  try {
    return await resolveObject(ctx, path);
  } catch (e) {
    if (e instanceof CliError && e.code === "OBJECT_NOT_FOUND") return;
    throw e;
  }
}
async function directory(ctx: Context, path: string) {
  const row = await resolveObject(ctx, path, "directory");
  if (row.kind !== "directory") return fail("NOT_A_DIRECTORY", "目标不是目录");
  return row;
}
async function file(ctx: Context, path: string) {
  const row = await resolveObject(ctx, path, "file");
  if (row.kind !== "file") return fail("TYPE_MISMATCH", "需要文件");
  return row;
}
async function destination(ctx: Context, path: string, name: string) {
  remote(path);
  let target = await maybe(ctx, path);
  if (!target && path.endsWith("/"))
    fail("OBJECT_NOT_FOUND", "目标目录不存在", 5);
  if (target?.kind === "file" && path.startsWith("id:")) path = target.path;
  if (target?.kind === "directory") {
    path = target.path.replace(/\/$/, "") + "/" + name;
    target = await maybe(ctx, path);
  }
  const parent = await directory(ctx, dirname(path));
  return {
    path,
    name: basename(path),
    parentId: parent.id === "root" ? null : parent.id,
    target,
  };
}
function guard(row: ObjectRow, o: Options) {
  if (o.ifVersion !== undefined && o.ifVersion !== row.version)
    fail("VERSION_CONFLICT", "对象版本已变化", 6);
}
function paginate(c: Command) {
  return c
    .option("--limit <n>", "每页条数", "50")
    .option("--cursor <token>", "继续游标");
}
function pagination(o: Options, key: string) {
  const limit = integer(o.limit ?? "50", 1, 100);
  let offset = 0;
  if (o.cursor) {
    try {
      const c = JSON.parse(Buffer.from(o.cursor, "base64url").toString());
      if (c.key !== key) throw Error();
      offset = integer(String(c.offset), 0);
    } catch {
      throw usage("无效或范围不符的 cursor");
    }
  }
  return { limit, offset };
}
function listing(items: unknown[], o: Options, key: string) {
  const { limit, offset } = pagination(o, key);
  return {
    items: items.slice(offset, offset + limit),
    next_cursor:
      offset + limit < items.length
        ? Buffer.from(JSON.stringify({ key, offset: offset + limit })).toString(
            "base64url",
          )
        : null,
  };
}
async function tree(
  ctx: Context,
  row: ObjectRow,
  recursive: boolean,
): Promise<ObjectRow[]> {
  const api = await ctx.client();
  const rows = await all(
    api,
    await ctx.space(),
    row.id === "root" ? null : row.id,
  );
  const result: ObjectRow[] = [];
  for (const item of rows) {
    item.path = row.path.replace(/\/$/, "") + "/" + item.name;
    result.push(item);
    if (recursive && item.kind === "directory")
      result.push(...(await tree(ctx, item, true)));
  }
  return result;
}
function jobId(data: Record<string, unknown>) {
  return "dfj1." + Buffer.from(JSON.stringify(data)).toString("base64url");
}
function jobData(id: string) {
  try {
    if (!id.startsWith("dfj1.")) throw Error();
    const p = JSON.parse(Buffer.from(id.slice(5), "base64url").toString());
    if (
      !p ||
      !["conversion", "deletion"].includes(p.type) ||
      typeof p.spaceId !== "string" ||
      !p.spaceId ||
      (p.type === "conversion" &&
        ![p.fileId, p.revisionId, p.operationId].every(
          (x) => typeof x === "string" && /^[A-Za-z0-9_]+$/.test(x),
        )) ||
      (p.type === "deletion" && typeof p.id !== "string")
    )
      throw Error();
    return p;
  } catch {
    throw usage("无效任务句柄");
  }
}
export function commands(root: Command, register: Register) {
  const isolated = new Command();
  legacy(isolated, (cmd, run) => {
    if (
      ["auth", "config"].includes(cmd.parent?.name() ?? "") ||
      cmd.name() === "status"
    )
      register(cmd, run);
  });
  for (const cmd of isolated.commands.filter((c) =>
    ["auth", "config", "status"].includes(c.name()),
  ))
    root.addCommand(cmd);
  const add = (
    parent: Command,
    syntax: string,
    description: string,
    run: Run,
    options?: (c: Command) => Command,
  ) => {
    let c = parent.command(syntax).description(description);
    if (options) c = options(c);
    register(c, async (ctx, args, o) => {
      if (o.role && !["manager", "teammate"].includes(o.role))
        throw usage("角色必须是 manager 或 teammate");
      if (o.set && !["manager", "teammate"].includes(o.set))
        throw usage("角色必须是 manager 或 teammate");
      if (o.mode && !["lexical", "hybrid"].includes(o.mode))
        throw usage("搜索模式必须是 lexical 或 hybrid");
      if (o.ifVersion !== undefined && !o.ifVersion)
        throw usage("--if-version 不能为空");
      if (o.idempotencyKey !== undefined && !o.idempotencyKey)
        throw usage("--idempotency-key 不能为空");
      return run(ctx, args, o);
    });
  };
  const stub = (p: Command, s: string, opts?: (c: Command) => Command) =>
    add(
      p,
      s,
      "当前后端未提供此能力",
      async () => {
        throw new CliError("NOT_IMPLEMENTED", "当前后端未提供此能力", 2);
      },
      opts,
    );
  const mutate = (c: Command) =>
    c.option("--if-version <version>").option("--idempotency-key <key>");
  add(
    root,
    "ls [directory]",
    "列出文件与目录",
    async (ctx, [path = "/"], o) => {
      const scope = await directory(ctx, path);
      return listing(
        await tree(ctx, scope, !!o.recursive),
        o,
        JSON.stringify([
          await ctx.apiUrl(),
          await ctx.space(),
          scope.id,
          !!o.recursive,
        ]),
      );
    },
    (c) => paginate(c).option("--recursive"),
  );
  add(root, "info <object>", "读取对象信息", async (ctx, [path]) => {
    const row = await resolveObject(ctx, path);
    if (row.kind === "directory") return row;
    const api = await ctx.client();
    if (!row.currentRevisionId)
      return { ...row, content_status: "not_available" };
    const content = await api("revision.content", {
      spaceId: await ctx.space(),
      fileId: row.id,
      revisionId: row.currentRevisionId,
    });
    return { ...row, mime_type: content.mediaType, size_bytes: content.bytes };
  });
  add(root, "cat <file>", "读取已有 UTF-8 文本", async (ctx, [path]) => {
    const row = await file(ctx, path),
      api = await ctx.client();
    const c = await api("file.content", {
      spaceId: await ctx.space(),
      fileId: row.id,
    });
    if (ctx.opts.dryRun)
      return {
        dry_run: true,
        file_id: row.id,
        path: row.path,
        size_bytes: c.bytes,
        mime_type: c.mediaType,
      };
    if (!/^(text\/|application\/(json|xml))/.test(c.mediaType))
      fail("TEXT_NOT_AVAILABLE", "没有可读文本表示");
    const res = await ctx.fetch(c.url, {
      signal: AbortSignal.timeout(ctx.requestMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw Object.assign(new Error("文本读取失败"), { status: res.status });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (
      (typeof c.bytes === "number" && bytes.byteLength !== c.bytes) ||
      (c.sha256 &&
        createHash("sha256").update(bytes).digest("hex") !== c.sha256)
    )
      fail("DOWNLOAD_INTEGRITY_FAILED", "下载内容与服务端校验值不一致", 9);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      return fail("TEXT_NOT_AVAILABLE", "内容不是 UTF-8 文本");
    }
    return { text, file_id: row.id, path: row.path, source: "original_text" };
  });
  add(
    root,
    "mkdir <directory>",
    "创建目录",
    async (ctx, [path], o) => {
      path = remote(path).normalize("NFC");
      if (path.startsWith("id:")) throw usage("创建需要绝对路径");
      let parentId: string | null = null;
      let current = "";
      const parts = path.slice(1).split("/");
      if (parts.some((part) => !part || Array.from(part).length > 255))
        throw usage("目录名须为 1–255 个字符");
      for (let i = 0; i < parts.length; i++) {
        current += "/" + parts[i];
        let row = await maybe(ctx, current);
        if (row) {
          if (row.kind !== "directory") fail("NOT_A_DIRECTORY", "父级不是目录");
          if (i === parts.length - 1 && !o.parents)
            fail("OBJECT_EXISTS", "目标存在", 6);
          parentId = row.id;
        } else {
          if (i < parts.length - 1 && !o.parents)
            fail("OBJECT_NOT_FOUND", "父目录不存在", 5);
          if (ctx.opts.dryRun) continue;
          row = (await (
            await ctx.client()
          )("folder.add", {
            spaceId: await ctx.space(),
            parentId,
            name: parts[i],
          })) as unknown as ObjectRow;
          parentId = row.id;
        }
      }
      return ctx.opts.dryRun
        ? { dry_run: true, path }
        : resolveObject(ctx, path);
    },
    (c) => c.option("--parents"),
  );
  add(
    root,
    "get <source> <local-path>",
    "下载原始字节",
    async (ctx, [source, path], o) =>
      download(ctx, (await file(ctx, source)).id, {
        output: path,
        overwrite: !!o.force,
      }),
    (c) => c.option("--force"),
  );
  const put: Run = async (ctx, [local, path], o) => {
    if (o.resume) {
      if (o.ifVersion !== undefined || o.idempotencyKey !== undefined)
        throw usage("--resume 不能与 --if-version 或 --idempotency-key 合用");
      return upload(ctx, undefined, { resume: o.resume });
    }
    const d = await destination(ctx, path, basename(local));
    if (o.ifVersion !== undefined && !d.target)
      fail("VERSION_CONFLICT", "指定版本的目标已不存在", 6);
    if (d.target && !o.force) fail("OBJECT_EXISTS", "目标存在", 6);
    if (d.target) {
      guard(d.target, o);
      if (d.target.kind !== "file") throw unsupported("目录覆盖");
    }
    return upload(
      ctx,
      local,
      {
        folder: d.parentId ?? "/",
        name: d.name,
        resume: o.resume,
        idempotencyKey: o.idempotencyKey,
        ...(o.ifVersion !== undefined
          ? { expectedCurrentRevisionId: d.target?.currentRevisionId ?? null }
          : {}),
      },
      d.target?.id,
    );
  };
  add(root, "put <local-file> <destination>", "上传原始字节", put, (c) =>
    mutate(c).option("--force").option("--resume <id>"),
  );
  add(
    root,
    "new <file-path>",
    "创建受管文件",
    async (ctx, [path], o) => {
      if (o.content !== undefined && o.fromStdin)
        throw usage("--content 与 --from-stdin 互斥");
      remote(path);
      if ((await maybe(ctx, path))?.kind === "directory")
        fail("TYPE_MISMATCH", "文件路径指向已有目录");
      const dir = await mkdtemp(join(tmpdir(), "deckflow-new-"));
      try {
        const local = join(dir, "content");
        const chunks: Buffer[] = [];
        if (o.fromStdin)
          for await (const b of process.stdin) chunks.push(Buffer.from(b));
        const data = o.fromStdin
          ? Buffer.concat(chunks)
          : Buffer.from(o.content ?? "");
        if (o.type !== undefined)
          throw unsupported("创建时显式指定 MIME 类型；当前由服务端探测");
        await writeFile(local, data, { mode: 0o600 });
        return await put(ctx, [local, path], o);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    (c) =>
      mutate(c)
        .option("--type <mime>")
        .option("--content <text>")
        .option("--from-stdin"),
  );
  add(
    root,
    "mv <source> <destination>",
    "移动或重命名",
    async (ctx, [source, path], o) => {
      if (o.idempotencyKey !== undefined)
        throw unsupported("移动的调用方幂等键");
      const row = await resolveObject(ctx, source);
      if (row.id === "root") throw usage("不能移动根目录");
      guard(row, o);
      const d = await destination(ctx, path, row.name);
      if (d.target)
        fail(
          o.force ? "UNSUPPORTED_OPERATION" : "OBJECT_EXISTS",
          "目标已存在",
          o.force ? 2 : 6,
        );
      if (row.kind === "directory" && d.path.startsWith(row.path + "/"))
        throw usage("不能移动到自身后代");
      const parent = row.kind === "file" ? row.folderId : row.parentId;
      const renamed = d.name !== row.name,
        moved = (parent ?? null) !== d.parentId;
      if (renamed && moved) throw unsupported("同时移动和改名");
      if (ctx.opts.dryRun)
        return { dry_run: true, source: row.path, destination: d.path };
      const api = await ctx.client(),
        spaceId = await ctx.space();
      if (row.kind === "file") {
        if (renamed)
          await api("file.modify", {
            spaceId,
            fileId: row.id,
            expectedRowVersion: row.rowVersion!,
            name: d.name,
          });
        else
          await api("file.move", {
            spaceId,
            fileId: row.id,
            expectedRowVersion: row.rowVersion!,
            folderId: d.parentId,
          });
      } else if (renamed)
        await api("folder.modify", {
          spaceId,
          folderId: row.id,
          expectedRowVersion: row.rowVersion!,
          name: d.name,
        });
      else
        await api("folder.move", {
          spaceId,
          folderId: row.id,
          expectedRowVersion: row.rowVersion!,
          parentId: d.parentId,
        });
      return resolveObject(ctx, "id:" + row.id);
    },
    (c) => mutate(c).option("--force"),
  );
  add(
    root,
    "cp <source> <destination>",
    "复制文件与目录",
    async (ctx, [source, path], o) => {
      const row = await resolveObject(ctx, source);
      guard(row, o);
      const d = await destination(ctx, path, row.name);
      if (d.target)
        fail(
          o.force ? "UNSUPPORTED_OPERATION" : "OBJECT_EXISTS",
          "目标存在",
          o.force ? 2 : 6,
        );
      if (row.kind === "directory" && !o.recursive)
        throw usage("复制目录需要 --recursive");
      if (
        row.kind === "directory" &&
        (row.path === "/" ||
          d.path === row.path ||
          d.path.startsWith(row.path + "/"))
      )
        throw usage("不能复制到自身或后代");
      const entries =
        row.kind === "directory" ? await tree(ctx, row, true) : [];
      if (ctx.opts.dryRun)
        return { dry_run: true, destination: d.path, items: entries };
      const api = await ctx.client(),
        spaceId = await ctx.space();
      const copy = async (
        r: ObjectRow,
        parentId: string | null,
        name: string,
        key: string,
      ) =>
        api("file.add", {
          spaceId,
          folderId: parentId,
          name,
          source: {
            type: "revision",
            sourceFileId: r.id,
            sourceRevisionId: r.currentRevisionId!,
          },
          refs: [
            {
              sourceFileId: r.id,
              sourceRevisionId: r.currentRevisionId!,
              operation: "copy",
            },
          ],
          idempotencyKey: key,
        });
      const key = o.idempotencyKey ?? randomUUID();
      if (row.kind === "file") return copy(row, d.parentId, d.name, key);
      const rootFolder = await api("folder.add", {
        spaceId,
        parentId: d.parentId,
        name: d.name,
      });
      const parents = new Map([[row.path, rootFolder.id]]);
      const results: unknown[] = [
        { ok: true, id: rootFolder.id, path: d.path },
      ];
      for (const entry of entries)
        try {
          const parent = parents.get(dirname(entry.path));
          if (!parent) throw usage("父目录复制失败");
          const created =
            entry.kind === "directory"
              ? await api("folder.add", {
                  spaceId,
                  parentId: parent,
                  name: entry.name,
                })
              : await copy(
                  entry,
                  parent,
                  entry.name,
                  createHash("sha256")
                    .update(JSON.stringify([key, entry.id]))
                    .digest("hex"),
                );
          if (entry.kind === "directory" && "id" in created)
            parents.set(entry.path, created.id);
          results.push({
            ok: true,
            path: d.path + entry.path.slice(row.path.length),
            result: created,
          });
        } catch (error) {
          results.push({ ok: false, path: entry.path });
          throw new CliError("PARTIAL_FAILURE", "目录复制部分成功", 9, {
            results,
            cause:
              error instanceof CliError ? error.code : "BACKEND_UNAVAILABLE",
          });
        }
      return { items: results, next_cursor: null };
    },
    (c) => mutate(c).option("--force").option("--recursive"),
  );
  add(
    root,
    "rm <target>",
    "永久删除或报告软删除缺失",
    async (ctx, [path], o) => {
      remote(path);
      if (o.idempotencyKey !== undefined)
        throw unsupported("永久删除的调用方幂等键");
      if (path === "/") throw usage("禁止删除根目录");
      if (!o.permanent) throw unsupported("回收站软删除");
      const row = await resolveObject(ctx, path);
      if (row.id === "root") throw usage("禁止删除根目录");
      guard(row, o);
      const api = await ctx.client(),
        spaceId = await ctx.space();
      if (
        row.kind === "directory" &&
        !o.recursive &&
        (await all(api, spaceId, row.id)).length
      )
        fail("DIRECTORY_NOT_EMPTY", "目录非空，需要 --recursive", 6);
      const preview = await ctx.confirm("永久删除", {
        id: row.id,
        path: row.path,
      });
      if (preview) return preview;
      const result =
        row.kind === "file"
          ? await api("file.remove", {
              spaceId,
              fileId: row.id,
              expectedRowVersion: row.rowVersion!,
            })
          : await api("folder.remove", {
              spaceId,
              folderId: row.id,
              expectedRowVersion: row.rowVersion!,
              recursive: !!o.recursive,
            });
      return {
        ...result,
        job_id: jobId({ type: "deletion", spaceId, id: result.id }),
      };
    },
    (c) => mutate(c).option("--recursive").option("--permanent"),
  );
  add(
    root,
    "view <file>",
    "读取已有视觉预览",
    async (ctx, [path], o) => {
      if (o.page && o.pages) throw usage("--page 与 --pages 互斥");
      integer(o.limit ?? "50", 1, 100);
      if (o.url && (o.page !== undefined || o.pages !== undefined))
        throw usage("--url 不支持页面选择");
      const row = await file(ctx, path);
      if (o.url)
        return {
          viewer_url:
            (await ctx.webUrl()) +
            `/s/${encodeURIComponent(await ctx.space())}/files/${encodeURIComponent(row.id)}`,
          url_only: true,
        };
      const api = await ctx.client(),
        spaceId = await ctx.space();
      if (!row.currentRevisionId)
        fail("PREVIEW_NOT_AVAILABLE", "没有当前版本预览");
      const representation = await api("file.content", {
        spaceId,
        fileId: row.id,
      });
      if (
        typeof representation.mediaType === "string" &&
        representation.mediaType.startsWith("image/")
      ) {
        if (o.page || o.pages) throw usage("单图不支持页面选择");
        if (o.cursor !== undefined) throw usage("单图不支持游标分页");
        if (representation.revisionId !== row.currentRevisionId)
          fail("PREVIEW_OUTDATED", "视觉资源版本已变化");
        return {
          file_id: row.id,
          path: row.path,
          revision: row.currentRevisionId,
          status: "ready",
          viewer_url: null,
          pages: [],
          next_cursor: null,
          image: {
            mime_type: representation.mediaType,
            retrieval: {
              method: "revision.content",
              params: {
                spaceId,
                fileId: row.id,
                revisionId: row.currentRevisionId,
              },
            },
          },
        };
      }
      const tasks = await api("conversion.list", {
        spaceId,
        fileId: row.id,
        revisionId: row.currentRevisionId!,
      });
      const task = tasks.items.find(
        (t) =>
          t.target === "screenshots" &&
          t.status === "succeeded" &&
          t.outputs.length > 0,
      );
      if (!task) fail("PREVIEW_NOT_AVAILABLE", "没有当前版本预览");
      const pages = task!.outputs.map((x) => ({
        page: x.ordinal + 1,
        artifact_id: x.artifactId,
        retrieval: {
          method: "conversion.content",
          params: {
            spaceId,
            fileId: row.id,
            revisionId: row.currentRevisionId,
            operationId: task!.operationId,
            artifactId: x.artifactId,
            itemId: x.itemId,
          },
        },
        mime_type: x.mediaType,
      }));
      let selected = pages;
      if (o.page) {
        const n = integer(o.page, 1);
        selected = pages.filter((x) => x.page === n);
      }
      if (o.pages) {
        if (!/^\d+-\d+$/.test(o.pages)) throw usage("页范围需要 N-M");
        const [a, b] = o.pages.split("-").map((x) => integer(x, 1));
        if (a > b) throw usage("无效页范围");
        selected = pages.filter((x) => x.page >= a && x.page <= b);
      }
      if (!selected.length) throw usage("页码超出范围");
      if (
        (await file(ctx, "id:" + row.id)).currentRevisionId !==
        row.currentRevisionId
      )
        fail("PREVIEW_OUTDATED", "预览版本已变化");
      return {
        file_id: row.id,
        path: row.path,
        revision: row.currentRevisionId,
        status: "ready",
        viewer_url: null,
        ...listing(
          selected,
          o,
          JSON.stringify([
            await ctx.apiUrl(),
            spaceId,
            row.id,
            row.currentRevisionId,
            task!.operationId,
            o.page,
            o.pages,
          ]),
        ),
        pages: listing(
          selected,
          o,
          JSON.stringify([
            await ctx.apiUrl(),
            spaceId,
            row.id,
            row.currentRevisionId,
            task!.operationId,
            o.page,
            o.pages,
          ]),
        ).items,
      };
    },
    (c) =>
      paginate(c)
        .option("--page <n>")
        .option("--pages <range>")
        .option("--url"),
  );
  add(
    root,
    "find [scope]",
    "元数据查询",
    async (ctx, [path = "/"], o) => {
      const scope = await resolveObject(ctx, path);
      if (
        o.type &&
        !["document", "image", "audio", "video"].includes(
          o.type.toLowerCase(),
        ) &&
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(o.type)
      )
        throw usage("--type 需要 document、image、audio、video 或 MIME 类型");
      let rows = scope.kind === "file" ? [scope] : await tree(ctx, scope, true);
      if (o.name) {
        const regex = new RegExp(
          "^" +
            o.name
              .split("*")
              .map((x) =>
                x
                  .split("?")
                  .map((y) => y.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                  .join("."),
              )
              .join(".*") +
            "$",
          "u",
        );
        rows = rows.filter((x) => regex.test(x.name));
      }
      if (o.type) {
        const matched: ObjectRow[] = [];
        for (const r of rows) {
          if (r.kind !== "file") continue;
          const c = await (
            await ctx.client()
          )("file.content", { spaceId: await ctx.space(), fileId: r.id });
          const t = o.type.toLowerCase();
          const mediaType = c.mediaType.toLowerCase();
          const yes = t.includes("/")
            ? mediaType === t
            : t === "document"
              ? /^(application\/(pdf|vnd\.|msword)|text\/)/.test(mediaType)
              : ["image", "audio", "video"].includes(t)
                ? mediaType.startsWith(t + "/")
                : false;
          if (yes) matched.push(r);
        }
        rows = matched;
      }
      for (const key of ["after", "before"] as const)
        if (o[key]) {
          const time = Date.parse(o[key]!);
          const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(o[key]!);
          if (
            !Number.isFinite(time) ||
            (date &&
              new Date(Date.parse(date[1])).toISOString().slice(0, 10) !==
                date[1])
          )
            throw usage("无效日期");
          rows = rows.filter((x) =>
            key === "before"
              ? Date.parse(String(x.createdAt)) < time
              : Date.parse(String(x.createdAt)) >= time,
          );
        }
      return listing(
        rows,
        o,
        JSON.stringify([
          await ctx.apiUrl(),
          await ctx.space(),
          scope.id,
          o.name,
          o.type,
          o.after,
          o.before,
        ]),
      );
    },
    (c) =>
      paginate(c)
        .option("--name <glob>")
        .option(
          "--type <type>",
          "document、image、audio、video 或完整 MIME 类型",
        )
        .option("--after <date>")
        .option("--before <date>"),
  );
  const scopeOf = async (ctx: Context, path: string) => {
    const row = await resolveObject(ctx, path);
    return row.id === "root"
      ? { type: "space" as const }
      : row.kind === "file"
        ? { type: "file" as const, fileId: row.id }
        : { type: "folder" as const, folderId: row.id };
  };
  for (const name of ["grep", "seek", "ask"]) {
    add(
      root,
      `${name} <query> [scope]`,
      "查询已建立的内容索引",
      async (ctx, [query, path = "/"], o) => {
        if (o.session) throw unsupported("问答会话");
        if (name === "seek" && o.ignoreCase)
          throw unsupported("语义搜索大小写控制");
        const api = await ctx.client(),
          spaceId = await ctx.space(),
          scope = await scopeOf(ctx, path);
        const params = {
          spaceId,
          scope,
          query,
          limit: integer(o.limit ?? "50", 1, 100),
          cursor: o.cursor,
        };
        if (name === "ask") {
          if (ctx.opts.dryRun) return { dry_run: true, query, scope };
          const idempotencyKey = o.idempotencyKey ?? randomUUID();
          const answered = await api("search.answer", {
            spaceId,
            scope,
            query,
            idempotencyKey,
          }).catch((error) => {
            throw Object.assign(
              error instanceof Error ? error : new Error("问答请求失败"),
              {
                operation: {
                  idempotency_key: idempotencyKey,
                  retry_hint: "使用相同查询、范围和此 --idempotency-key 重试",
                },
              },
            );
          });
          const citations = [];
          for (const citation of answered.citations ?? []) {
            const hit = (answered.hits ?? []).find(
              (h: Record<string, unknown>) => h.hitId === citation,
            );
            if (!hit) {
              citations.push({
                hit_id: citation,
                path: null,
                path_status: "unavailable",
                lookup_error: { code: "MISSING_EVIDENCE" },
              });
              continue;
            }
            try {
              const object = await file(ctx, "id:" + hit.fileId);
              citations.push({
                file_id: object.id,
                path: object.path,
                location: hit.location,
                hit_id: citation,
              });
            } catch (error) {
              citations.push({
                file_id: hit.fileId,
                path: null,
                path_status: "unavailable",
                location: hit.location,
                hit_id: citation,
                lookup_error: {
                  code:
                    error instanceof CliError
                      ? error.code
                      : "CITATION_LOOKUP_FAILED",
                  status: (error as { status?: number }).status,
                },
              });
            }
          }
          return {
            ...answered,
            raw_citations: answered.citations,
            citations,
            citation_status: citations.some((c) => "lookup_error" in c)
              ? "partial"
              : "complete",
          };
        }
        const raw =
          name === "grep"
            ? await api("search.find", {
                ...params,
                mode: "regex",
                caseSensitive: !o.ignoreCase,
              })
            : await api("search.query", { ...params, rewrite: false });
        const items = [];
        const objects = new Map<string, ObjectRow>();
        for (const hit of raw.hits ?? []) {
          let object = objects.get(hit.fileId);
          if (!object) {
            object = await file(ctx, "id:" + hit.fileId);
            objects.set(hit.fileId, object);
          }
          items.push({
            file_id: object.id,
            path: object.path,
            score: hit.ranking?.score,
            snippet: hit.evidence?.snippet,
            location: hit.location,
            retrieval_mode: name === "grep" ? "regex" : "semantic",
            index_provenance: raw.coverage,
            hit,
          });
        }
        return {
          items,
          next_cursor: raw.nextCursor ?? null,
          provenance: raw,
          retrieval_mode: name === "grep" ? "regex" : "semantic",
        };
      },
      (c) =>
        name === "ask"
          ? c.option("--session <id>").option("--idempotency-key <key>")
          : paginate(c).option("--ignore-case"),
    );
  }
  stub(root, "search <query> [scope]", (c) =>
    paginate(c).option("--mode <mode>", "lexical 或 hybrid", "lexical"),
  );
  const ws = root.command("ws").description("工作空间");
  add(
    ws,
    "ls",
    "列出空间",
    async (ctx, _, o) => {
      const raw = await (await ctx.client())("my.spaces", {});
      const items = Array.isArray(raw)
        ? raw
        : ((raw as unknown as { rows: unknown[] }).rows ?? []);
      return listing(items, o, "workspaces");
    },
    paginate,
  );
  for (const action of [
    "info",
    "use",
    "members",
    "usage",
    "quota",
    "balance",
    "edit",
  ]) {
    add(
      ws,
      action === "use" ? "use <workspace>" : `${action} [workspace]`,
      "读取或管理工作空间",
      async (ctx, [selector], o) => {
        const id = selector ?? (await ctx.space()),
          api = await ctx.client();
        ctx.opts.ws = id;
        if (action === "info") return api("space.detail", { id });
        if (action === "use") {
          await api("space.detail", { id });
          if (!ctx.opts.dryRun) await ctx.setConfig("space", id);
          return { workspace_id: id, dry_run: !!ctx.opts.dryRun };
        }
        if (action === "members") {
          const items: unknown[] = [];
          for (let offset = 0; ;) {
            const page = await api("space.users", {
              spaceId: id,
              _startIndex: offset,
              _maxResults: 100,
            });
            items.push(...page.rows);
            offset += page.rows.length;
            if (!page.rows.length || offset >= page.count) break;
          }
          return listing(items, o, JSON.stringify([id, "members"]));
        }
        if (action === "edit") {
          if (o.description !== undefined) throw unsupported("空间描述编辑");
          if (!o.name) throw usage("需要 --name");
          return ctx.opts.dryRun
            ? { dry_run: true }
            : api("space.rename", { id, name: o.name });
        }
        const b = await api("billing.detail", { spaceId: id });
        if (action === "balance")
          return {
            unit: "credit_unit",
            available: b.available_units,
            frozen: b.frozen_units,
            total: b.balance_units,
            display: b.balance,
          };
        if (action === "usage")
          return {
            storage_bytes: b.storage_bytes,
            egress_used_bytes: b.egress_used_bytes,
            period: b.period,
          };
        const limit = BigInt(b.plan.storageGB) * 1073741824n,
          used = BigInt(b.storage_bytes);
        return {
          storage_bytes: {
            limit: limit.toString(),
            used: used.toString(),
            remaining: (limit > used ? limit - used : 0n).toString(),
          },
          period: b.period,
        };
      },
      (c) =>
        action === "edit"
          ? c.option("--name <name>").option("--description <text>")
          : action === "members"
            ? paginate(c)
            : c,
    );
  }
  add(
    ws,
    "invite <email>",
    "邀请成员",
    async (ctx, [email], o) =>
      ctx.opts.dryRun
        ? { dry_run: true, email }
        : (await ctx.client())("space.addInvite", {
            spaceId: await ctx.space(),
            email,
            role: o.role as "manager" | "teammate",
          }),
    (c) => c.requiredOption("--role <role>"),
  );
  for (const action of ["remove", "role"]) {
    add(
      ws,
      `${action} <member-id-or-email>`,
      "管理成员",
      async (ctx, [userId], o) => {
        if (userId.includes("@")) throw unsupported("按邮箱解析成员");
        const api = await ctx.client(),
          spaceId = await ctx.space();
        if (ctx.opts.dryRun) return { dry_run: true, userId };
        return action === "remove"
          ? api("spaceUser.remove", { spaceId, userId })
          : api("spaceUser.changeRole", {
              spaceId,
              userId,
              role: o.set as "manager" | "teammate",
            });
      },
      (c) => (action === "role" ? c.requiredOption("--set <role>") : c),
    );
  }
  stub(ws, "new <slug>", (c) => c.option("--name <name>"));
  stub(ws, "rm <workspace>", (c) => c.requiredOption("--confirm <slug>"));
  stub(ws, "stats [workspace]");
  const ops = root.command("ops").description("整文件处理");
  add(
    ops,
    "capabilities",
    "已实现的格式矩阵",
    async (_ctx, _args, o) => ({
      items: [
        {
          action: "convert",
          input_formats: ["docx", "keynote"],
          output_formats: ["pdf"],
        },
        {
          action: "render",
          input_formats: ["pptx", "docx", "pdf", "keynote"],
          output_formats: ["webp"],
        },
      ].filter(
        (item) => !o.inputFormat || item.input_formats.includes(o.inputFormat),
      ),
      availability: "unknown",
      next_cursor: null,
    }),
    (c) => c.option("--input-format <format>"),
  );
  for (const action of ["convert", "render"]) {
    add(
      ops,
      `${action} <file>`,
      "提交处理任务",
      async (ctx, [path], o) => {
        const row = await file(ctx, path);
        guard(row, o);
        if (o.force) throw unsupported("处理产物覆盖");
        if (o.idempotencyKey !== undefined)
          throw unsupported("处理任务的调用方幂等键");
        if (o.output !== undefined && !o.output.trim())
          throw usage("--output 不能为空");
        if (!row.currentRevisionId)
          fail("CONTENT_NOT_AVAILABLE", "文件尚无可处理的版本", 6);
        const format = String(row.format ?? row.name.split(".").at(-1))
          .toLowerCase()
          .replace(/^key$/, "keynote");
        const supported =
          action === "convert"
            ? ["docx", "keynote"]
            : ["pptx", "docx", "pdf", "keynote"];
        if (!supported.includes(format))
          fail("UNSUPPORTED_FORMAT", "不支持的输入格式");
        let target: Awaited<ReturnType<typeof destination>> | undefined;
        let outputDir: ObjectRow | undefined;
        if (o.output) {
          if (action === "render") outputDir = await directory(ctx, o.output);
          else {
            target = await destination(
              ctx,
              o.output,
              row.name.replace(/\.[^.]+$/, "") + ".pdf",
            );
            if (target.target) fail("OBJECT_EXISTS", "输出目标存在", 6);
          }
        }
        if (
          (action === "convert" && o.to !== "pdf") ||
          (action === "render" && o.to !== "webp")
        )
          fail("UNSUPPORTED_FORMAT", "不支持的输出格式");
        if (o.pages) throw unsupported("渲染页范围");
        if (ctx.opts.dryRun) return { dry_run: true, file_id: row.id };
        const p = {
          spaceId: await ctx.space(),
          fileId: row.id,
          revisionId: row.currentRevisionId!,
        };
        const task = await (
          await ctx.client()
        )("conversion.add", {
          ...p,
          target: action === "convert" ? "pdf" : "screenshots",
          options: action === "render" ? { resolution: 720 } : {},
        });
        const handle = jobId({
          ...p,
          type: "conversion",
          operationId: task.operationId,
        });
        if (["failed", "cancelled"].includes(task.status))
          throw new CliError("JOB_FAILED", "处理任务失败", 9, {
            job_id: handle,
            state: task.status,
            serverCode: task.errorCode,
            retryable: task.retryable,
          });
        if (!o.output)
          return {
            job_id: handle,
            state: task.status,
            output: task.outputs.length ? task.outputs : null,
          };
        try {
          const done = await poll(
            (signal) =>
              ctx
                .client()
                .then((api) =>
                  api(
                    "conversion.detail",
                    { ...p, operationId: task.operationId },
                    signal,
                  ),
                ),
            (v) => ["succeeded", "failed", "cancelled"].includes(v.status),
            ctx.waitMs,
          );
          if (done.status !== "succeeded")
            throw new CliError("JOB_FAILED", "处理任务失败", 9, {
              job_id: handle,
              state: done.status,
              serverCode: done.errorCode,
              retryable: done.retryable,
            });
          const outputs = done.outputs;
          if (!outputs.length)
            throw new CliError("RESULT_NOT_AVAILABLE", "任务产物已不可用", 6, {
              job_id: handle,
            });
          const persisted: unknown[] = [];
          for (const output of outputs) {
            const name =
              target?.name ??
              `${row.name.replace(/\.[^.]+$/, "")}-${output.ordinal + 1}.${output.format ?? "webp"}`;
            const parentId = target
              ? target.parentId
              : outputDir!.id === "root"
                ? null
                : outputDir!.id;
            const outputPath =
              target?.path ?? outputDir!.path.replace(/\/$/, "") + "/" + name;
            if (await maybe(ctx, outputPath))
              throw new CliError("OBJECT_EXISTS", "输出目标存在", 6, {
                job_id: handle,
                results: persisted,
              });
            const created = await (
              await ctx.client()
            )("file.add", {
              spaceId: p.spaceId,
              folderId: parentId,
              name,
              idempotencyKey: `${task.operationId}:${output.artifactId}:${output.itemId ?? ""}`,
              source: {
                type: "artifact",
                sourceFileId: row.id,
                sourceRevisionId: p.revisionId,
                sourceArtifactId: output.artifactId,
                itemId: output.itemId,
              },
              refs: [
                {
                  sourceFileId: row.id,
                  sourceRevisionId: p.revisionId,
                  operation: action === "convert" ? "convert" : "other",
                },
              ],
            });
            const stored = await finishFile(
              ctx,
              await ctx.client(),
              p.spaceId,
              created,
            );
            persisted.push({ id: stored.id, path: outputPath });
          }
          return { job_id: handle, state: "succeeded", output: persisted };
        } catch (e) {
          if (e instanceof CliError) throw e;
          if ((e as { status?: number }).status)
            throw Object.assign(e as object, { operation: { job_id: handle } });
          throw new CliError(
            "BACKEND_UNAVAILABLE",
            "等待超时，服务端任务未取消",
            9,
            { job_id: handle },
          );
        }
      },
      (c) =>
        mutate(c)
          .requiredOption("--to <format>")
          .option("--output <path>")
          .option("--pages <range>")
          .option("--force"),
    );
  }
  for (const action of [
    "extract",
    "resize",
    "crop",
    "trim",
    "transcribe",
    "thumbnail",
  ]) {
    stub(ops, `${action} <file>`, (c) =>
      c
        .option("--type <type>")
        .option("--width <n>")
        .option("--height <n>")
        .option("--x <n>")
        .option("--y <n>")
        .option("--start <duration>")
        .option("--end <duration>")
        .option("--language <language>")
        .option("--at <duration>")
        .option("--output <path>"),
    );
  }
  const jobs = root.command("jobs").description("处理任务");
  stub(jobs, "ls", (c) => paginate(c).option("--state <state>"));
  stub(jobs, "cancel <job-id>");
  for (const action of ["status", "result"]) {
    add(jobs, `${action} <job-id>`, "读取任务", async (ctx, [id]) => {
      const p = jobData(id);
      if (p.spaceId !== (await ctx.space())) throw usage("任务不属于选定空间");
      const api = await ctx.client();
      const task =
        p.type === "deletion"
          ? await api("deletionJob.detail", { spaceId: p.spaceId, id: p.id })
          : p.type === "conversion"
            ? await api("conversion.detail", {
                spaceId: p.spaceId,
                fileId: p.fileId,
                revisionId: p.revisionId,
                operationId: p.operationId,
              })
            : fail("JOB_NOT_FOUND", "未知任务类型", 5);
      if (action === "result" && ["failed", "cancelled"].includes(task.status))
        throw new CliError("JOB_FAILED", "任务已失败或取消", 9, {
          job_id: id,
          state: task.status,
          serverCode: "errorCode" in task ? task.errorCode : undefined,
        });
      if (
        action === "result" &&
        p.type === "conversion" &&
        task.status === "succeeded" &&
        "outputs" in task &&
        !task.outputs.length
      )
        throw new CliError("RESULT_NOT_AVAILABLE", "任务产物已不可用", 6, {
          job_id: id,
        });
      if (
        action === "result" &&
        !["succeeded", "completed"].includes(task.status)
      )
        fail("JOB_NOT_READY", "任务尚未成功完成", 6);
      return {
        job_id: id,
        ...task,
        state:
          task.status === "completed"
            ? "succeeded"
            : task.status === "cancelRequested"
              ? "running"
              : task.status,
      };
    });
  }
  const version = root.command("version").description("文件历史");
  add(
    version,
    "ls <file>",
    "列出历史版本",
    async (ctx, [path], o) => {
      const row = await file(ctx, path);
      const key = JSON.stringify([
        await ctx.apiUrl(),
        await ctx.space(),
        row.id,
        "versions",
      ]);
      const { limit, offset } = pagination(o, key);
      const raw = await (
        await ctx.client()
      )("revision.list", {
        spaceId: await ctx.space(),
        fileId: row.id,
        _maxResults: limit,
        _startIndex: offset,
      });
      const next = offset + raw.rows.length;
      return {
        items: raw.rows,
        next_cursor:
          raw.rows.length && next < raw.count
            ? Buffer.from(JSON.stringify({ key, offset: next })).toString(
                "base64url",
              )
            : null,
      };
    },
    paginate,
  );
  add(
    version,
    "restore <file>",
    "恢复为新版本",
    async (ctx, [path], o) => {
      if (o.ifVersion !== undefined)
        throw unsupported(
          "恢复时的完整对象版本条件；后端仅支持当前内容版本条件",
        );
      const row = await file(ctx, path);
      guard(row, o);
      await (
        await ctx.client()
      )("revision.detail", {
        spaceId: await ctx.space(),
        fileId: row.id,
        revisionId: o.to!,
      });
      const preview = await ctx.confirm("恢复文件版本", {
        file_id: row.id,
        to: o.to,
      });
      if (preview) return preview;
      return (await ctx.client())("revision.restore", {
        spaceId: await ctx.space(),
        fileId: row.id,
        revisionId: o.to!,
        expectedCurrentRevisionId: row.currentRevisionId ?? null,
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
      });
    },
    (c) => mutate(c).requiredOption("--to <version>"),
  );
  for (const format of ["pptx", "docx"]) {
    const group = root.command(format).description("结构化文件能力");
    add(group, "capabilities", "结构化能力", async () => ({
      items: [],
      next_cursor: null,
      implemented: false,
    }));
    stub(group, "info <file>");
  }
}
