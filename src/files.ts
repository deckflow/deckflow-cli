import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Result } from "@deckflow/deckbase-sdk";
import {
  CliError,
  type ApiCall,
  type Context,
  endpoint,
  poll,
  readJson,
  saveJson,
  usage,
} from "./core.js";

const MiB = 1024 ** 2;
const failed = (status: string) =>
  ["failed", "aborted", "expired", "cancelled"].includes(status);
export function taskFailure(status: string, code?: string | null) {
  return new CliError(
    "TASK_FAILED",
    `任务状态：${status}`,
    status === "expired" ? 6 : 9,
    { serverCode: code },
  );
}

export async function folderPath(
  api: ApiCall,
  spaceId: string,
  value: string,
  create = false,
  start: string | null = null,
): Promise<string | null> {
  if (!value.startsWith("/"))
    return (await api("folder.detail", { spaceId, folderId: value })).id;
  let parentId = start;
  for (const name of value.split("/").filter(Boolean)) {
    if (name === "." || name === "..") throw usage("远端目录不能包含 . 或 ..");
    const matches: string[] = [];
    for (let offset = 0; ;) {
      const list = await api("folder.list", {
        spaceId,
        parentId,
        _startIndex: offset,
        _maxResults: 100,
      });
      matches.push(
        ...list.rows
          .filter(
            (row) => row.name === name && (row.parentId ?? null) === parentId,
          )
          .map((row) => row.id),
      );
      offset += list.rows.length;
      if (!list.rows.length || offset >= list.count) break;
    }
    if (matches.length > 1)
      throw new CliError("AMBIGUOUS_FOLDER", `远端目录重名：${name}`, 6);
    if (matches.length) parentId = matches[0];
    else if (create)
      parentId = (await api("folder.add", { spaceId, parentId, name })).id;
    else throw new CliError("FOLDER_NOT_FOUND", `远端目录不存在：${name}`, 5);
  }
  return parentId;
}

type UploadState = {
  kind: "upload";
  endpoint: string;
  spaceId: string;
  path: string;
  bytes: number;
  sha256: string;
  folderId?: string | null;
  fileId?: string;
  ttlSeconds?: number;
  expectedCurrentRevisionId: string | null;
  maxParts: number;
  sessionId?: string;
};
type ConvertState = {
  kind: "convert";
  endpoint: string;
  spaceId: string;
  fileId: string;
  revisionId: string;
  folderId: string | null;
  name: string;
  conversionId?: string;
  creationId?: string;
  output?: { artifactId: string; itemId?: string };
  result?: { fileId: string; revisionId?: string | null; name: string };
};
type State = UploadState | ConvertState;
function operationPath(ctx: Context, id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw usage("无效的本地操作 ID");
  return join(ctx.stateDir, "operations", id + ".json");
}
async function loadOperation<K extends State["kind"]>(
  ctx: Context,
  id: string,
  kind: K,
) {
  const state = await readJson<State>(operationPath(ctx, id));
  if (!state || state.kind !== kind)
    throw new CliError("OPERATION_NOT_FOUND", "未找到对应的本地操作", 5);
  if (
    state.endpoint !== (await ctx.apiUrl()) ||
    state.spaceId !== (await ctx.space())
  )
    throw usage("恢复操作需要使用原 API 地址和工作空间");
  return state as Extract<State, { kind: K }>;
}
async function tracked<T>(
  ctx: Context,
  id: string,
  execute: () => Promise<T>,
  resume: string,
  details: () => Record<string, unknown>,
) {
  try {
    if (ctx.interactive || ctx.opts.verbose)
      process.stderr.write(`操作 ID：${id}\n`);
    return await execute();
  } catch (e) {
    const error = e instanceof Error ? e : Error("操作失败");
    throw Object.assign(error, {
      operation: {
        operationId: id,
        resume: `${resume} --resume ${id}`,
        ...details(),
      },
    });
  }
}
async function fingerprint(path: string) {
  const before = await lstat(path);
  if (!before.isFile()) throw usage("上传源必须是常规文件");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const after = await lstat(path);
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    bytes !== before.size ||
    bytes !== after.size
  )
    throw new CliError("SOURCE_CHANGED", "读取期间本地文件发生变化", 6);
  return { bytes, sha256: hash.digest("hex") };
}
async function manifest(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await manifest(path)));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}
function storageUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("INVALID_STORAGE_URL", "服务端返回了无效的存储地址", 9);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new CliError("INVALID_STORAGE_URL", "服务端返回了无效的存储地址", 9);
  return url;
}
async function put(
  ctx: Context,
  signed: { url: string; method: string; headers?: Record<string, unknown> },
  path: string,
  offset: number,
  size: number,
) {
  const headers = new Headers(
    Object.entries(signed.headers ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  headers.set("content-length", String(size));
  const stream = size
    ? createReadStream(path, { start: offset, end: offset + size - 1 })
    : undefined;
  try {
    const response = await ctx.fetch(storageUrl(signed.url), {
      method: signed.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(ctx.requestMs),
      body: stream
        ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>)
        : new Uint8Array(0),
      duplex: "half",
    } as RequestInit);
    await response.body?.cancel();
    if (!response.ok)
      throw new CliError(
        "STORAGE_UPLOAD_FAILED",
        `存储上传失败 (${response.status})`,
        response.status >= 500 ? 8 : 9,
      );
    return response.headers.get("etag");
  } finally {
    stream?.destroy();
  }
}

async function transfer(
  ctx: Context,
  api: ApiCall,
  id: string,
  state: UploadState,
  resume = false,
) {
  const {
    path,
    bytes,
    sha256,
    fileId,
    folderId,
    ttlSeconds,
    spaceId,
    expectedCurrentRevisionId,
  } = state;
  if (resume) {
    const current = await fingerprint(path);
    if (current.bytes !== bytes || current.sha256 !== sha256)
      throw new CliError("SOURCE_CHANGED", "文件指纹与原操作不一致", 6);
  }
  const name = basename(path);
  let session = state.sessionId
    ? await api("uploadSession.detail", { spaceId, id: state.sessionId })
    : await api("uploadSession.add", {
        spaceId,
        name,
        bytes,
        sha256,
        fileId,
        expectedCurrentRevisionId,
        multipart: bytes >= 32 * MiB,
        idempotencyKey: id + ":session",
      });
  if (!state.sessionId) {
    state.sessionId = session.id;
    await saveJson(operationPath(ctx, id), state);
  }
  const query = { spaceId, id: session.id };
  if (failed(session.status))
    throw taskFailure(session.status, session.errorCode);
  if (!["verifying", "verified", "committed"].includes(session.status)) {
    let parts: { number: number; etag: string }[] | undefined;
    if (session.multipart) {
      const partBytes = Math.max(8 * MiB, Math.ceil(bytes / state.maxParts));
      const completed = new Map(session.parts?.map((p) => [p.number, p.etag]));
      parts = [];
      for (let number = 1; number <= Math.ceil(bytes / partBytes); number++) {
        let etag = completed.get(number);
        if (!etag) {
          const { parts: signed } = await api("uploadSession.parts", {
            ...query,
            partNumbers: [number],
          });
          if (!signed[0])
            throw new CliError(
              "MISSING_UPLOAD_PART",
              "服务端未返回分片地址",
              9,
            );
          const offset = (number - 1) * partBytes;
          etag =
            (await put(
              ctx,
              signed[0],
              path,
              offset,
              Math.min(partBytes, bytes - offset),
            )) ?? undefined;
          if (!etag)
            throw new CliError("MISSING_ETAG", "存储未返回分片 ETag", 9);
        }
        parts.push({ number, etag });
      }
    } else {
      if (!session.upload) session = await api("uploadSession.detail", query);
      if (!session.upload)
        throw new CliError("UPLOAD_UNAVAILABLE", "服务端未返回上传地址", 9);
      await put(ctx, session.upload, path, 0, bytes);
    }
    session = await api("uploadSession.complete", { ...query, parts });
  }
  if (
    !["verified", "committed"].includes(session.status) &&
    !failed(session.status)
  ) {
    session = await poll(
      (signal) => api("uploadSession.detail", query, signal),
      (v) => ["verified", "committed"].includes(v.status) || failed(v.status),
      ctx.waitMs,
    );
  }
  if (failed(session.status))
    throw taskFailure(session.status, session.errorCode);
  if (session.status === "committed") {
    const resultFileId = session.targetFileId || fileId;
    if (!resultFileId || !session.committedRevisionId)
      throw new CliError(
        "INVALID_UPLOAD_RESULT",
        "服务端缺少已提交的文件或版本 ID",
        9,
      );
    return {
      operationId: id,
      fileId: resultFileId,
      revisionId: session.committedRevisionId,
      name,
      bytes,
      status: "committed",
    };
  }
  if (fileId) {
    const revision = await api("revision.add", {
      spaceId,
      fileId,
      uploadId: session.id,
      expectedCurrentRevisionId,
      idempotencyKey: id + ":commit",
    });
    return {
      operationId: id,
      fileId,
      revisionId: revision.id,
      name,
      bytes,
      status: "committed",
    };
  }
  const file = await finishFile(
    ctx,
    api,
    spaceId,
    await api("file.add", {
      spaceId,
      folderId,
      name,
      ttlSeconds,
      source: { type: "upload", uploadId: session.id },
      idempotencyKey: id + ":commit",
    }),
  );
  return {
    operationId: id,
    fileId: file.id,
    revisionId: file.currentRevisionId,
    name,
    bytes,
    status: "committed",
  };
}

async function finishFile(
  ctx: Context,
  api: ApiCall,
  spaceId: string,
  result: Result<"file.add">,
) {
  if ("id" in result) return result;
  const job = await poll(
    (signal) =>
      api(
        "file.creationDetail",
        { spaceId, operationId: result.operationId },
        signal,
      ),
    (v) => v.status === "succeeded" || failed(v.status),
    ctx.waitMs,
  );
  if (!job.file) throw taskFailure(job.status, job.errorCode);
  return job.file;
}
export type UploadOptions = {
  folder?: string;
  recursive?: boolean;
  createFolders?: boolean;
  ttlDays?: string;
  resume?: string;
};
export async function upload(
  ctx: Context,
  local: string | undefined,
  opts: UploadOptions,
  fileId?: string,
) {
  const spaceId = await ctx.space();
  const api = await ctx.client();
  if (opts.resume) {
    if (
      local ||
      fileId ||
      opts.folder ||
      opts.recursive ||
      opts.createFolders ||
      opts.ttlDays
    )
      throw usage("--resume 不能与其他上传参数合用");
    const state = await loadOperation(ctx, opts.resume, "upload");
    if (ctx.opts.dryRun)
      return {
        dryRun: true,
        operationId: opts.resume,
        fileId: state.fileId,
        path: state.path,
        spaceId,
      };
    return tracked(
      ctx,
      opts.resume,
      () => transfer(ctx, api, opts.resume!, state, true),
      "deckflow upload",
      () => ({ spaceId, uploadSessionId: state.sessionId }),
    );
  }
  if (!local) throw usage("请指定本地文件或 --resume");
  const root = ctx.path(local);
  const entry = await lstat(root);
  const directory = entry.isDirectory();
  if (!entry.isFile() && !directory) throw usage("上传源必须是常规文件或目录");
  if (directory && (!opts.recursive || fileId))
    throw usage("上传目录需要 --recursive");
  if (!directory && opts.createFolders)
    throw usage("--create-folders 仅用于递归上传");
  const paths = directory ? await manifest(root) : [root];
  if (!paths.length) throw usage("没有可上传的常规文件");
  const ttlSeconds =
    opts.ttlDays !== undefined ? Number(opts.ttlDays) * 86400 : undefined;
  if (
    ttlSeconds !== undefined &&
    (!/^\d+(?:\.\d+)?$/.test(opts.ttlDays!) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 10800)
  )
    throw usage("--ttl-days 必须换算为至少 10800 个整秒");
  const planFolders =
    directory && opts.createFolders && opts.folder?.startsWith("/");
  const folderId =
    opts.folder && !planFolders
      ? await folderPath(api, spaceId, opts.folder)
      : null;
  const expectedCurrentRevisionId = fileId
    ? ((await api("file.detail", { spaceId, fileId })).currentRevisionId ??
      null)
    : null;
  const folders = new Map<string, string | null>([["", folderId]]);
  const subfolders = [
    ...new Set(
      paths
        .map((path) =>
          directory ? relative(root, dirname(path)).split(sep).join("/") : "",
        )
        .filter(Boolean),
    ),
  ];
  if (!opts.createFolders)
    for (const sub of subfolders)
      folders.set(
        sub,
        await folderPath(api, spaceId, "/" + sub, false, folderId),
      );
  const impact = {
    spaceId,
    fileId,
    folderId,
    targetFolder: opts.folder,
    files: paths,
    relativeFolders: subfolders,
    createFolders: !!opts.createFolders,
  };
  if (directory || ctx.opts.dryRun) {
    const preview = await ctx.confirm("上传", impact, true);
    if (preview) return preview;
  }
  const [space, regions] = await Promise.all([
    api("space.detail", { id: spaceId }),
    api("region.list", {}),
  ]);
  const caps = regions.rows.find((r) => r.id === space.regionId)?.capabilities;
  const maxParts = Number(caps?.maxParts ?? 10000);
  if (!Number.isSafeInteger(maxParts) || maxParts < 1)
    throw new CliError("INVALID_UPLOAD_LIMIT", "区域分片配置无效", 9);
  const results = [];
  if (planFolders)
    folders.set("", await folderPath(api, spaceId, opts.folder!, true));
  for (const path of paths) {
    const id = randomUUID();
    try {
      const sub = directory
        ? relative(root, dirname(path)).split(sep).join("/")
        : "";
      if (!folders.has(sub))
        folders.set(
          sub,
          await folderPath(
            api,
            spaceId,
            "/" + sub,
            true,
            folders.get("") ?? null,
          ),
        );
      const content = await fingerprint(path);
      if (content.bytes > Number(caps?.maxUploadBytes ?? Infinity))
        throw usage("文件超过区域上传上限");
      const state: UploadState = {
        kind: "upload",
        endpoint: await ctx.apiUrl(),
        spaceId,
        path,
        ...content,
        folderId: folders.get(sub),
        fileId,
        ttlSeconds,
        expectedCurrentRevisionId,
        maxParts,
      };
      await saveJson(operationPath(ctx, id), state);
      const result = await tracked(
        ctx,
        id,
        () => transfer(ctx, api, id, state),
        "deckflow upload",
        () => ({ spaceId, uploadSessionId: state.sessionId }),
      );
      if (!directory) return result;
      results.push({ path, ok: true, result });
    } catch (error) {
      if (!directory) throw error;
      results.push({ path, ok: false, error });
    }
  }
  return { batch: true as const, results };
}

export async function download(
  ctx: Context,
  fileId: string,
  opts: { revision?: string; output?: string; overwrite?: boolean },
) {
  const spaceId = await ctx.space();
  const api = await ctx.client();
  const file = await api("file.detail", { spaceId, fileId });
  const revision = opts.revision
    ? await api("revision.detail", {
        spaceId,
        fileId,
        revisionId: opts.revision,
      })
    : undefined;
  const name = (revision?.name ?? file.name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");
  const safeName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? "_" + name
    : name;
  const target = ctx.path(opts.output ?? (safeName || "download"));
  const exists = await lstat(target).then(
    (s) => s,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    },
  );
  if (exists && (!opts.overwrite || !exists.isFile()))
    throw new CliError(
      "OUTPUT_EXISTS",
      "目标已存在，请选择其他路径或指定 --overwrite",
      6,
    );
  if (ctx.opts.dryRun)
    return ctx.confirm(
      "下载",
      { spaceId, fileId, revisionId: opts.revision, path: target },
      true,
    );
  const content = opts.revision
    ? await api("revision.content", {
        spaceId,
        fileId,
        revisionId: opts.revision,
      })
    : await api("file.content", { spaceId, fileId });
  const timeout = AbortSignal.timeout(ctx.requestMs);
  const response = await ctx.fetch(storageUrl(content.url), {
    signal: timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new CliError(
      "STORAGE_DOWNLOAD_FAILED",
      `存储下载失败 (${response.status})`,
      response.status === 402
        ? 7
        : response.status === 403
          ? 4
          : response.status === 404
            ? 5
            : 8,
    );
  }
  const temp = join(dirname(target), `.deckflow-${randomUUID()}.tmp`);
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytes += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      { signal: timeout },
    );
    if (bytes !== content.bytes || hash.digest("hex") !== content.sha256)
      throw new CliError(
        "DOWNLOAD_INTEGRITY_FAILED",
        "下载内容与服务端校验值不一致",
        9,
      );
    if (opts.overwrite) await rename(temp, target);
    else await link(temp, target);
    return { fileId, revisionId: content.revisionId, path: target, bytes };
  } finally {
    await rm(temp, { force: true });
  }
}

export async function convert(
  ctx: Context,
  fileId: string | undefined,
  opts: {
    to?: string;
    folder?: string;
    revision?: string;
    name?: string;
    resume?: string;
  },
) {
  const api = await ctx.client();
  const spaceId = await ctx.space();
  const id = opts.resume ?? randomUUID();
  let state: ConvertState;
  if (opts.resume) {
    if (fileId || opts.to || opts.folder || opts.revision || opts.name)
      throw usage("--resume 不能与其他转换参数合用");
    state = await loadOperation(ctx, id, "convert");
  } else {
    if (!fileId || opts.to !== "pdf") throw usage("请指定文件 ID 和 --to pdf");
    const file = await api("file.detail", { spaceId, fileId });
    const revisionId = opts.revision ?? file.currentRevisionId;
    if (!revisionId)
      throw new CliError("REVISION_NOT_FOUND", "文件没有当前版本", 5);
    await api("revision.detail", { spaceId, fileId, revisionId });
    const folderId = opts.folder
      ? await folderPath(api, spaceId, opts.folder)
      : (file.folderId ?? null);
    const name = opts.name ?? file.name.replace(/\.[^.]+$/, "") + ".pdf";
    state = {
      kind: "convert",
      endpoint: endpoint(await ctx.apiUrl(), "API 地址"),
      spaceId,
      fileId,
      revisionId,
      folderId,
      name,
    };
  }
  const preview = await ctx.confirm(
    "转换并创建独立文件",
    {
      spaceId,
      fileId: state.fileId,
      revisionId: state.revisionId,
      folderId: state.folderId,
      name: state.name,
    },
    true,
  );
  if (preview) return preview;
  const statePath = operationPath(ctx, id);
  if (!opts.resume) await saveJson(statePath, state);
  return tracked(
    ctx,
    id,
    async () => {
      const source = {
        spaceId,
        fileId: state.fileId,
        revisionId: state.revisionId,
      };
      if (!state.conversionId) {
        const job = await api("conversion.add", { ...source, target: "pdf" });
        state.conversionId = job.operationId;
        await saveJson(statePath, state);
      }
      if (state.result)
        return {
          operationId: id,
          conversionId: state.conversionId,
          ...state.result,
        };
      if (!state.output && !state.creationId) {
        const job = await poll(
          (signal) =>
            api(
              "conversion.detail",
              { ...source, operationId: state.conversionId! },
              signal,
            ),
          (v) => v.status === "succeeded" || failed(v.status),
          ctx.waitMs,
        );
        if (job.status !== "succeeded")
          throw taskFailure(job.status, job.errorCode);
        const outputs = job.outputs.filter(
          (output) =>
            output.format === "pdf" || output.mediaType === "application/pdf",
        );
        if (outputs.length !== 1)
          throw new CliError(
            "PDF_OUTPUT_UNAVAILABLE",
            "转换任务没有唯一 PDF 产物",
            9,
          );
        state.output = {
          artifactId: outputs[0].artifactId,
          itemId: outputs[0].itemId,
        };
        await saveJson(statePath, state);
      }
      const result = state.creationId
        ? ({ operationId: state.creationId, status: "queued" } as const)
        : await api("file.add", {
            spaceId,
            folderId: state.folderId,
            name: state.name,
            idempotencyKey: id + ":file",
            source: {
              type: "artifact",
              sourceFileId: state.fileId,
              sourceRevisionId: state.revisionId,
              sourceArtifactId: state.output!.artifactId,
              itemId: state.output!.itemId,
            },
          });
      if ("operationId" in result && result.operationId && !state.creationId) {
        state.creationId = result.operationId;
        await saveJson(statePath, state);
      }
      const file = await finishFile(ctx, api, spaceId, result);
      state.result = {
        fileId: file.id,
        revisionId: file.currentRevisionId,
        name: file.name,
      };
      await saveJson(statePath, state);
      return {
        operationId: id,
        conversionId: state.conversionId,
        ...state.result,
      };
    },
    "deckflow file convert",
    () => ({
      spaceId,
      fileId: state.fileId,
      revisionId: state.revisionId,
      conversionId: state.conversionId,
      creationId: state.creationId,
    }),
  );
}
