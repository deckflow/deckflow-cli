import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const binary = resolve("dist/cli.js");
const node = process.env.DECKFLOW_TEST_NODE || process.execPath;
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Buffer,
) => unknown;
let temp: string;
let base: string;
let requests: { method?: string; path: string; auth?: string }[];
let handler: Handler;
let server: ReturnType<typeof createServer>;
let serverErrors: unknown[];

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
};
const hash = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
const sampleFile = {
  id: "f1",
  name: "示例 file.pdf",
  rowVersion: 8,
  currentRevisionId: "r1",
  spaceId: "ws",
  status: "active",
};
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "deckflow-test-"));
  requests = [];
  serverErrors = [];
  handler = (_, res) => json(res, {}, 404);
  server = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const path = req.url!;
      requests.push({
        method: req.method,
        path,
        auth: req.headers.authorization,
      });
      await handler(req, res, path, Buffer.concat(parts));
      if (!res.writableEnded) json(res, {}, 404);
    } catch (error) {
      serverErrors.push(error);
      if (!res.headersSent) json(res, {}, 500);
      else res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("test server not listening");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
  await rm(temp, { recursive: true, force: true });
  expect(serverErrors).toEqual([]);
});
async function cli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = temp,
  stdin?: string,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(node, [binary, ...args], {
        cwd,
        env: {
          ...process.env,
          DECKFLOW_LANG: "zh",
          DECKFLOW_API_URL: base + "/api",
          DECKFLOW_WEB_URL: base + "/web",
          DECKFLOW_WORKSPACE: "ws",
          DECKFLOW_TOKEN: "test-token",
          HOME: temp,
          USERPROFILE: temp,
          XDG_CONFIG_HOME: temp,
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.on("error", fail);
      child.on("close", (code) => done({ code, stdout, stderr }));
      onSpawn?.(child);
      child.stdin.end(stdin);
    },
  );
}
function result(run: Awaited<ReturnType<typeof cli>>, code = 0) {
  expect(run.code, run.stderr).toBe(code);
  const envelope = JSON.parse(run.stdout);
  expect(envelope.ok).toBe(code === 0);
  expect(envelope.meta.request_id).toBeTruthy();
  return code === 0 ? envelope.data : envelope.error;
}
describe("v0.3 contract", () => {
  it("exposes the new tree without authentication or legacy verbs", async () => {
    const run = await cli(["--help"], { DECKFLOW_TOKEN: "" });
    expect(run.code).toBe(0);
    for (const name of [
      "ls",
      "info",
      "cat",
      "view",
      "cp",
      "mv",
      "rm",
      "mkdir",
      "new",
      "put",
      "get",
      "find",
      "grep",
      "search",
      "seek",
      "ask",
      "ws",
      "ops",
      "jobs",
      "version",
      "pptx",
      "docx",
    ])
      expect(run.stdout).toMatch(new RegExp("\\n  " + name + "[ \\[]"));
    for (const name of [
      "file",
      "folder",
      "space",
      "upload",
      "download",
      "share",
      "album",
      "api",
      "open",
    ])
      expect(run.stdout).not.toMatch(new RegExp("\\n  " + name + "[ \\[]"));
    expect(requests).toEqual([]);
  });
  it("emits failures on stdout and rejects old parameters", async () => {
    expect(result(await cli(["ls", "--space", "ws", "--json"]), 2).code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      result(await cli(["ls", "--timeout", "30s", "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      result(
        await cli(["ls", "--json"], {
          DECKFLOW_WORKSPACE: "",
          DECKFLOW_SPACE: "ignored",
        }),
        2,
      ).code,
    ).toBe("WORKSPACE_REQUIRED");
  });
  it("uses the persisted default when --ws is omitted and keeps overrides temporary", async () => {
    handler = (_req, res, path) => {
      if (path.includes("/folders") || path.includes("/files"))
        return json(res, { rows: [], count: 0 });
      if (path.startsWith("/api/spaces/"))
        return json(res, { id: path.split("/").at(-1), name: "Default" });
    };
    const env = { DECKFLOW_WORKSPACE: "" };
    result(await cli(["ws", "use", "saved", "--json"], env));
    const saved = JSON.parse(
      await readFile(join(temp, ".deckflow", "credentials"), "utf8"),
    );
    expect(saved.spaceId).toBe("saved");
    requests = [];
    const first = await cli(["ls", "/", "--json"], env);
    expect(result(first).items).toEqual([]);
    expect(JSON.parse(first.stdout).meta.workspace_id).toBe("saved");
    expect(requests.every((r) => r.path.includes("/spaces/saved/"))).toBe(true);
    requests = [];
    result(
      await cli(["ls", "/", "--json"], { DECKFLOW_WORKSPACE: "environment" }),
    );
    expect(requests.every((r) => r.path.includes("/spaces/environment/"))).toBe(
      true,
    );
    requests = [];
    result(
      await cli(["ls", "/", "--ws", "explicit", "--json"], {
        DECKFLOW_WORKSPACE: "environment",
      }),
    );
    expect(requests.every((r) => r.path.includes("/spaces/explicit/"))).toBe(
      true,
    );
    requests = [];
    result(await cli(["ls", "/", "--json"], env));
    expect(requests.every((r) => r.path.includes("/spaces/saved/"))).toBe(true);
  });
  it("reads defaults saved through config set without requiring --ws", async () => {
    handler = (_req, res, path) =>
      path.includes("/folders") || path.includes("/files")
        ? json(res, { rows: [], count: 0 })
        : json(res, { id: "configured" });
    const env = { DECKFLOW_WORKSPACE: "" };
    result(await cli(["config", "set", "space", "configured", "--json"], env));
    requests = [];
    result(await cli(["ls", "/", "--json"], env));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.path.includes("/spaces/configured/"))).toBe(
      true,
    );
  });
  it("registers strict discoverable unsupported capabilities", async () => {
    for (const args of [
      ["search", "hello"],
      ["ops", "extract", "/x", "--type", "text"],
      ["jobs", "cancel", "x"],
      ["pptx", "info", "/x"],
      ["ws", "new", "alpha"],
    ])
      expect(result(await cli([...args, "--json"]), 2).code).toBe(
        "NOT_IMPLEMENTED",
      );
    expect(
      result(await cli(["search", "hello", "--typo", "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests).toEqual([]);
  });
  it("blocks soft deletion and root deletion without requests", async () => {
    expect(result(await cli(["rm", "/x", "--json"]), 2).code).toBe(
      "UNSUPPORTED_OPERATION",
    );
    expect(
      result(await cli(["rm", "/", "--permanent", "--yes", "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests).toEqual([]);
  });
  it("omits internal version tokens from info output", async () => {
    let revision: string | null = "r1";
    let contentAvailable = true;
    handler = (_, res, path) => {
      if (path.includes("/folders"))
        return json(res, {
          rows: [{ id: "d1", name: "A", parentId: null, rowVersion: 1 }],
          count: 1,
        });
      if (path.endsWith("/content"))
        return contentAvailable
          ? json(res, { mediaType: "application/pdf", bytes: 100 })
          : json(res, {}, 404);
      return json(res, {
        rows: [{ ...sampleFile, currentRevisionId: revision }],
        count: 1,
      });
    };
    for (const path of ["/", "/A", "/" + sampleFile.name]) {
      for (const state of ["available", "unavailable", "no_revision"]) {
        revision = state === "no_revision" ? null : "r1";
        contentAvailable = state === "available";
        expect(result(await cli(["info", path, "--json"]))).not.toHaveProperty(
          "version",
        );
        const plain = await cli(["info", path]);
        expect(plain.code).toBe(0);
        expect(plain.stdout).not.toContain("version:");
      }
    }
  });
  it("lists mixed objects with bound continuation cursors", async () => {
    const listedFile = {
      ...sampleFile,
      format: "pdf",
      updatedAt: "2026-11-24T11:53:35.424Z",
      description: null,
      source: {},
      extra: { large: "metadata" },
      creatorId: "creator",
    };
    handler = (_, res, path) => {
      if (path.includes("/folders"))
        return json(res, {
          rows: [{ id: "d1", name: "A", parentId: null, rowVersion: 1 }],
          count: 1,
        });
      if (path.includes("/files"))
        return json(res, { rows: [listedFile], count: 1 });
    };
    const first = result(
      await cli(["--ws", "selected", "ls", "/", "--limit", "1", "--json"]),
    );
    expect(first.items[0].kind).toBe("directory");
    expect(first.items[0].path).toBe("/A");
    expect(Object.keys(first.items[0]).sort()).toEqual(
      ["id", "name", "kind", "path"].sort(),
    );
    expect(first.next_cursor).toBeTruthy();
    const second = result(
      await cli([
        "ls",
        "/",
        "--ws",
        "selected",
        "--limit",
        "1",
        "--cursor",
        first.next_cursor,
        "--json",
      ]),
    );
    expect(second.items[0].id).toBe("f1");
    expect(second.items[0]).toEqual({
      id: listedFile.id,
      name: listedFile.name,
      kind: "file",
      path: "/" + listedFile.name,
      format: listedFile.format,
      updatedAt: listedFile.updatedAt,
    });
    const plain = await cli(["ls", "/", "--ws", "selected"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(listedFile.updatedAt);
    for (const field of [
      "version",
      "rowVersion",
      "currentRevisionId",
      "creatorId",
      "extra",
    ])
      expect(plain.stdout).not.toContain(field + ":");
    expect(second.next_cursor).toBeNull();
    expect(requests.every((r) => r.path.includes("/selected/"))).toBe(true);
    expect(
      result(await cli(["ls", "/", "--cursor", first.next_cursor, "--json"]), 2)
        .code,
    ).toBe("INVALID_ARGUMENT");
  });
  it("preserves text exactly without generic redaction", async () => {
    const text = "dbk_example https://example.com/?token=literal\n";
    handler = (_, res, path) => {
      if (path.startsWith("/content")) return res.end(text);
      if (path.endsWith("/content"))
        return json(res, {
          mediaType: "text/plain",
          url: base + "/content",
          bytes: Buffer.byteLength(text),
        });
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/files"))
        return json(res, {
          rows: [{ ...sampleFile, name: "text.txt" }],
          count: 1,
        });
    };
    expect((await cli(["cat", "/text.txt"])).stdout).toBe(text);
    expect(result(await cli(["cat", "/text.txt", "--json"])).text).toBe(text);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("returns missing previews without scheduling processing", async () => {
    handler = (_, res, path) => {
      if (path.includes("/conversions")) return json(res, { items: [] });
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/files"))
        return json(res, { rows: [sampleFile], count: 1 });
    };
    expect(
      result(await cli(["view", "/示例 file.pdf", "--json"]), 2).code,
    ).toBe("PREVIEW_NOT_AVAILABLE");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("rejects traversal and invalid page combinations before requests", async () => {
    for (const path of ["relative", "/a/../b", "/a//b"])
      expect(result(await cli(["info", path, "--json"]), 2).code).toBe(
        "INVALID_ARGUMENT",
      );
    expect(
      result(
        await cli(["view", "/x", "--page", "1", "--pages", "1-3", "--json"]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests).toEqual([]);
  });
  it("maps permissions and diagnostics without leaking tokens", async () => {
    handler = (_, res) =>
      json(res, { code: "notAllowed", message: "test-token" }, 403);
    const run = await cli(["ws", "info", "ws", "--json"]);
    expect(result(run, 3).code).toBe("PERMISSION_DENIED");
    expect(run.stdout + run.stderr).not.toContain("test-token");
  });
  it("returns declared capabilities as standard lists", async () => {
    const caps = result(await cli(["ops", "capabilities", "--json"]));
    expect(caps.items).toHaveLength(2);
    expect(caps.availability).toBe("unknown");
    expect(
      result(await cli(["docx", "capabilities", "--json"])).implemented,
    ).toBe(false);
  });
});

describe("transfer regressions", () => {
  it("streams empty and Unicode files through signed storage and commits idempotently", async () => {
    await writeFile(join(temp, "空 文件.pdf"), "");
    let committed = false;
    handler = (req, res, path, body) => {
      if (
        req.method === "GET" &&
        (path.includes("/folders") || path.includes("/files?"))
      )
        return json(res, { rows: [], count: 0 });
      if (path === "/api/spaces/ws") return json(res, { regionId: "region" });
      if (path.startsWith("/api/regions"))
        return json(res, {
          rows: [{ id: "region", capabilities: {} }],
          count: 1,
        });
      if (path.endsWith("/upload-sessions")) {
        expect(JSON.parse(body.toString())).toMatchObject({
          name: "空 文件.pdf",
          bytes: 0,
          sha256: hash(""),
          expectedCurrentRevisionId: null,
        });
        return json(res, {
          id: "up",
          status: "pending",
          upload: {
            url: base + "/signed?secret=abc",
            method: "PUT",
            headers: {},
          },
        });
      }
      if (path.startsWith("/signed")) {
        expect(req.headers.authorization).toBeUndefined();
        expect(body.length).toBe(0);
        return res.writeHead(200).end();
      }
      if (path.endsWith("/complete"))
        return json(res, { id: "up", status: "verified" });
      if (path.endsWith("/files") && req.method === "POST") {
        expect(JSON.parse(body.toString())).toMatchObject({
          source: { type: "upload", uploadId: "up" },
          idempotencyKey: expect.stringMatching(/:commit$/),
        });
        committed = true;
        return json(res, sampleFile, 201);
      }
      if (path.endsWith("/upload-sessions/up") && committed)
        return json(res, {
          id: "up",
          status: "committed",
          targetFileId: "f1",
          committedRevisionId: "r1",
        });
    };
    const uploaded = result(
      await cli(["put", "空 文件.pdf", "/空 文件.pdf", "--json"]),
    );
    expect(uploaded).toMatchObject({
      fileId: "f1",
      revisionId: "r1",
      bytes: 0,
    });
    expect(
      result(
        await cli([
          "put",
          "空 文件.pdf",
          "/空 文件.pdf",
          "--resume",
          uploaded.operationId,
          "--json",
        ]),
      ),
    ).toMatchObject({ fileId: "f1", revisionId: "r1" });
    expect(
      requests.filter((r) => r.path === "/api/spaces/ws/files"),
    ).toHaveLength(1);
    await writeFile(join(temp, "空 文件.pdf"), "changed");
    expect(
      result(
        await cli([
          "put",
          "空 文件.pdf",
          "/空 文件.pdf",
          "--resume",
          uploaded.operationId,
          "--json",
        ]),
        4,
      ).code,
    ).toBe("SOURCE_CHANGED");
    expect(
      result(
        await cli([
          "put",
          "LOCAL",
          "DEST",
          "--resume",
          uploaded.operationId,
          "--dry-run",
          "--json",
        ]),
        4,
      ).code,
    ).toBe("SOURCE_CHANGED");
    await rm(join(temp, "空 文件.pdf"));
    expect(
      result(
        await cli([
          "put",
          "LOCAL",
          "DEST",
          "--resume",
          uploaded.operationId,
          "--dry-run",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("ENOENT");
  });
});

describe("transfer recovery and integrity", () => {
  it("resumes a failed multipart upload using completed part ETags", async () => {
    const size = 32 * 1024 ** 2;
    await writeFile(join(temp, "big.pptx"), "");
    await truncate(join(temp, "big.pptx"), size);
    const uploaded = new Map<number, string>();
    let failed = false;
    handler = (req, res, path, body) => {
      if (
        req.method === "GET" &&
        (path.includes("/folders") || path.includes("/files?"))
      )
        return json(res, { rows: [], count: 0 });
      const session = { id: "up", status: "pending", multipart: true };
      if (path === "/api/spaces/ws") return json(res, { regionId: "region" });
      if (path.startsWith("/api/regions"))
        return json(res, {
          rows: [{ id: "region", capabilities: { maxParts: 2 } }],
          count: 1,
        });
      if (path.endsWith("/upload-sessions")) {
        expect(JSON.parse(body.toString())).toMatchObject({
          multipart: true,
          bytes: size,
        });
        return json(res, session);
      }
      if (path.endsWith("/upload-sessions/up"))
        return json(res, {
          ...session,
          parts: [...uploaded].map(([number, etag]) => ({ number, etag })),
        });
      if (path.endsWith("/parts")) {
        const number = JSON.parse(body.toString()).partNumbers[0];
        return json(res, {
          parts: [
            {
              number,
              url: base + "/part/" + number,
              method: "PUT",
              headers: {},
            },
          ],
        });
      }
      if (path.startsWith("/part/")) {
        const number = Number(path.split("/").at(-1));
        expect(body.length).toBe(size / 2);
        expect(req.headers.authorization).toBeUndefined();
        if (number === 2 && !failed) {
          failed = true;
          return res.writeHead(503).end();
        }
        uploaded.set(number, `"${number}"`);
        return res.writeHead(200, { etag: `"${number}"` }).end();
      }
      if (path.endsWith("/complete")) {
        expect(JSON.parse(body.toString()).parts).toEqual([
          { number: 1, etag: '"1"' },
          { number: 2, etag: '"2"' },
        ]);
        return json(res, { ...session, status: "verified" });
      }
      if (path.endsWith("/files")) return json(res, sampleFile, 201);
    };
    const first = result(
      await cli(["put", "big.pptx", "/big.pptx", "--json"]),
      5,
    );
    expect(first.details.operationId).toBeTruthy();
    expect(
      result(
        await cli([
          "put",
          "big.pptx",
          "/big.pptx",
          "--resume",
          first.details.operationId,
          "--json",
        ]),
      ).fileId,
    ).toBe("f1");
    expect(requests.filter((r) => r.path === "/part/1")).toHaveLength(1);
    expect(requests.filter((r) => r.path === "/part/2")).toHaveLength(2);
  }, 20000);
  it("checks download integrity and leaves existing files untouched", async () => {
    let corrupt = false;
    handler = (req, res, path) => {
      if (path.endsWith("/download"))
        return json(res, {
          downloadId: "audit",
          revisionId: "r1",
          url: base + "/api/content/ticket/f",
        });
      if (path.endsWith("/files/f1")) return json(res, sampleFile);
      if (path.endsWith("/content"))
        return json(res, {
          revisionId: "r1",
          bytes: 3,
          sha256: hash("pdf"),
          url: "/content/ticket/f",
        });
      if (path.includes("/content/ticket")) {
        expect(req.headers.authorization).toBeUndefined();
        return res
          .writeHead(302, { location: base + "/bytes?signature=secret" })
          .end();
      }
      if (path.startsWith("/bytes")) {
        expect(req.headers.authorization).toBeUndefined();
        return res.end(corrupt ? "bad" : "pdf");
      }
    };
    const args = ["get", "id:f1", "本地 file.pdf", "--json"];
    expect(result(await cli(args)).bytes).toBe(3);
    const target = join(temp, "本地 file.pdf");
    expect(await readFile(target, "utf8")).toBe("pdf");
    const conflict = result(await cli(args), 4);
    expect(conflict.code).toBe("OBJECT_EXISTS");
    expect(conflict.message).toContain("--force");
    expect(conflict.message).not.toContain("--overwrite");
    corrupt = true;
    expect(result(await cli([...args, "--force"]), 5).code).toBe(
      "DOWNLOAD_INTEGRITY_FAILED",
    );
    expect(await readFile(target, "utf8")).toBe("pdf");
    expect(
      requests.filter(
        (r) => r.path === "/api/spaces/ws/files/f1/revisions/r1/content",
      ),
    ).toHaveLength(2);
  });
});

describe("processing adapters", () => {
  it("submits derivatives without creating managed files", async () => {
    handler = (req, res, path, body) => {
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/conversions") && req.method === "POST") {
        expect(JSON.parse(body.toString()).target).toBe("pdf");
        return json(res, { operationId: "op", status: "queued", outputs: [] });
      }
      if (path.includes("/files"))
        return json(res, {
          rows: [{ ...sampleFile, name: "示例 file.docx" }],
          count: 1,
        });
    };
    const task = result(
      await cli(["ops", "convert", "/示例 file.docx", "--to", "pdf", "--json"]),
    );
    expect(task.job_id).toMatch(/^dfj1\./);
    expect(task.state).toBe("queued");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(
      result(
        await cli(["jobs", "status", task.job_id, "--ws", "other", "--json"]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
  });
  it("persists only explicitly requested output and retains source provenance", async () => {
    handler = (req, res, path, body) => {
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/conversions/op"))
        return json(res, {
          operationId: "op",
          status: "succeeded",
          outputs: [
            {
              artifactId: "a1",
              ordinal: 0,
              format: "pdf",
              mediaType: "application/pdf",
            },
          ],
        });
      if (path.includes("/conversions"))
        return json(res, { operationId: "op", status: "queued", outputs: [] });
      if (path.endsWith("/files") && req.method === "POST") {
        expect(JSON.parse(body.toString())).toMatchObject({
          folderId: null,
          name: "export.pdf",
          source: { type: "artifact", sourceArtifactId: "a1" },
        });
        return json(res, { ...sampleFile, id: "export" });
      }
      if (path.includes("/files"))
        return json(res, {
          rows: [{ ...sampleFile, name: "示例 file.docx" }],
          count: 1,
        });
    };
    const done = result(
      await cli([
        "ops",
        "convert",
        "/示例 file.docx",
        "--to",
        "pdf",
        "--output",
        "/export.pdf",
        "--json",
      ]),
    );
    expect(done.output[0].id).toBe("export");
  });
  it("keeps regex and semantic retrieval distinct", async () => {
    handler = (_, res, path, body) => {
      const p = JSON.parse(body.toString());
      if (path.endsWith("/find")) {
        expect(p.mode).toBe("regex");
        expect(p.caseSensitive).toBe(false);
      } else {
        expect(p.rewrite).toBe(false);
        expect(p.mode).toBeUndefined();
      }
      return json(res, { hits: [], nextCursor: null });
    };
    expect(
      result(await cli(["grep", "ARR.*", "--ignore-case", "--json"]))
        .retrieval_mode,
    ).toBe("regex");
    expect(
      result(await cli(["seek", "concept", "--json"])).retrieval_mode,
    ).toBe("semantic");
  });
});

describe("issue regressions: configuration and object identity", () => {
  it("rejects empty workspace flags and empty URL delimiters", async () => {
    expect(
      result(await cli(["ws", "info", "--ws", "", "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
    for (const value of [base + "/api?", base + "/api#"]) {
      expect(
        result(await cli(["config", "set", "apiUrl", value, "--json"]), 2).code,
      ).toBe("INVALID_ARGUMENT");
    }
    expect(
      result(
        await cli([
          "put",
          "missing",
          "/file",
          "--idempotency-key",
          "",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests).toEqual([]);
  });
  it("rejects malformed credential shapes instead of reporting a saved value", async () => {
    await mkdir(join(temp, ".deckflow"), { recursive: true });
    await writeFile(join(temp, ".deckflow", "credentials"), "[]");
    expect(
      result(await cli(["config", "set", "webUrl", base, "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
    expect(await readFile(join(temp, ".deckflow", "credentials"), "utf8")).toBe(
      "[]",
    );
  });
  it("reports whether endpoint-bound credentials were actually removed", async () => {
    await mkdir(join(temp, ".deckflow"), { recursive: true });
    await writeFile(
      join(temp, ".deckflow", "credentials"),
      JSON.stringify({ token: "synthetic", tokenApiRoot: base + "/other" }),
    );
    expect(
      result(await cli(["auth", "logout", "--json"])).localCredentialRemoved,
    ).toBe(false);
    await writeFile(
      join(temp, ".deckflow", "credentials"),
      JSON.stringify({ token: "synthetic", tokenApiRoot: base + "/api" }),
    );
    expect(
      result(await cli(["auth", "logout", "--json"])).localCredentialRemoved,
    ).toBe(true);
  });
  it("uses the queried workspace in response metadata and binary GB quotas", async () => {
    handler = (_, res, path) =>
      path.includes("/billing")
        ? json(res, {
            plan: { storageGB: 5 },
            storage_bytes: "5100000000",
            egress_used_bytes: "0",
            period: {},
          })
        : json(res, { id: "other" });
    for (const action of ["info", "usage", "quota", "use"]) {
      const run = await cli(["ws", action, "other", "--ws", "ws", "--json"]);
      const data = result(run);
      expect(JSON.parse(run.stdout).meta.workspace_id).toBe("other");
      if (action === "quota")
        expect(data.storage_bytes).toEqual({
          limit: "5368709120",
          used: "5100000000",
          remaining: "268709120",
        });
    }
  });
  it("retains known billing codes on forbidden responses", async () => {
    handler = (_, res) => json(res, { code: "STORAGE_WRITE_RESTRICTED" }, 403);
    expect(result(await cli(["ws", "info", "--json"]), 5).code).toBe(
      "STORAGE_WRITE_RESTRICTED",
    );
  });
  it("binds directory versions to object IDs and rejects empty mutation guards", async () => {
    let id = "old";
    handler = (_, res, path) =>
      path.includes("/folders")
        ? json(res, { rows: [{ id, name: "A", rowVersion: 1 }], count: 1 })
        : json(res, { rows: [], count: 0 });
    const old = Buffer.from(
      JSON.stringify({ id, row: 1, revision: null }),
    ).toString("base64url");
    id = "new";
    expect(result(await cli(["info", "/A", "--json"]))).not.toHaveProperty(
      "version",
    );
    expect(
      result(
        await cli([
          "rm",
          "/A",
          "--permanent",
          "--yes",
          "--if-version",
          old,
          "--json",
        ]),
        4,
      ).code,
    ).toBe("VERSION_CONFLICT");
    expect(
      result(
        await cli([
          "rm",
          "/A",
          "--permanent",
          "--yes",
          "--if-version",
          "",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("rejects oversized directory components before any writes", async () => {
    for (const flags of [[], ["--dry-run"]]) {
      expect(
        result(
          await cli([
            "mkdir",
            "/new/" + "x".repeat(256),
            "--parents",
            ...flags,
            "--json",
          ]),
          2,
        ).code,
      ).toBe("INVALID_ARGUMENT");
    }
    expect(requests).toEqual([]);
  });
  it("does not interpret a literal --json after the argument separator as an output option", async () => {
    const run = await cli(["grep", "--", "--json"]);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBeTruthy();
  });
});

describe("issue regressions: content and list scopes", () => {
  function objects() {
    handler = (_, res, path) => {
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/files"))
        return json(res, {
          rows: [{ ...sampleFile, createdAt: "2026-01-01T00:00:00Z" }],
          count: 1,
        });
    };
  }
  it("keeps a UTF-8 BOM and rejects mismatching content hashes and delivery 404s", async () => {
    const text = "\ufefforiginal\n";
    let sha256 = hash(text),
      status = 200;
    handler = (_, res, path) => {
      if (path === "/bytes") {
        res.writeHead(status);
        return res.end(text);
      }
      if (path.endsWith("/content"))
        return json(res, {
          url: base + "/bytes",
          mediaType: "text/plain",
          bytes: Buffer.byteLength(text),
          sha256,
        });
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/files"))
        return json(res, { rows: [sampleFile], count: 1 });
    };
    expect((await cli(["cat", "/" + sampleFile.name])).stdout).toBe(text);
    expect(
      result(await cli(["cat", "/" + sampleFile.name, "--json"])).text,
    ).toBe(text);
    sha256 = hash("wrong");
    expect(
      result(await cli(["cat", "/" + sampleFile.name, "--json"]), 5).code,
    ).toBe("DOWNLOAD_INTEGRITY_FAILED");
    status = 404;
    const error = result(
      await cli(["cat", "/" + sampleFile.name, "--json"]),
      4,
    );
    expect(error.code).toBe("OBJECT_NOT_FOUND");
    expect(error.details.status).toBe(404);
    expect(error.retryable).toBe(false);
  });
  it("rejects nonexistent dates and excludes exact before boundaries", async () => {
    objects();
    expect(
      result(await cli(["find", "/", "--after", "2026-02-30", "--json"]), 2)
        .code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      result(
        await cli(["find", "/", "--before", "2026-01-01T00:00:00Z", "--json"]),
      ).items,
    ).toEqual([]);
    expect(
      result(await cli(["find", "/", "--before", "2026-01-02", "--json"]))
        .items,
    ).toHaveLength(1);
  });
  it("compares MIME types without case and rejects invalid types", async () => {
    objects();
    const list = handler;
    handler = (req, res, path, body) =>
      path.endsWith("/content")
        ? json(res, { mediaType: "Image/PNG" })
        : list(req, res, path, body);
    for (const type of ["image/png", "IMAGE/PNG", "image"]) {
      expect(
        result(await cli(["find", "/", "--type", type, "--json"])).items,
      ).toHaveLength(1);
    }
    expect(
      result(await cli(["find", "/", "--type", "invalid", "--json"]), 2).code,
    ).toBe("INVALID_ARGUMENT");
  });
  it("rejects cursors from replaced directory objects and different API roots", async () => {
    let id = "old";
    handler = (_, res, path) => {
      if (path.includes("/folders"))
        return json(res, {
          rows: path.includes("parentId=")
            ? []
            : [{ id, name: "Target", rowVersion: 1 }],
          count: path.includes("parentId=") ? 0 : 1,
        });
      if (path.includes("/files"))
        return json(res, {
          rows: [
            { ...sampleFile, id: "one", name: "one" },
            { ...sampleFile, id: "two", name: "two" },
          ],
          count: 2,
        });
    };
    for (const cmd of ["ls", "find"]) {
      id = "old";
      const cursor = result(
        await cli([cmd, "/Target", "--limit", "1", "--json"]),
      ).next_cursor;
      expect(cursor).toBeTruthy();
      id = "new";
      expect(
        result(await cli([cmd, "/Target", "--cursor", cursor, "--json"]), 2)
          .code,
      ).toBe("INVALID_ARGUMENT");
      id = "old";
      expect(
        result(
          await cli([cmd, "/Target", "--cursor", cursor, "--json"], {
            DECKFLOW_API_URL: base + "/another",
          }),
          2,
        ).code,
      ).toBe("INVALID_ARGUMENT");
    }
  });
  it("supports the root ID emitted by info", async () => {
    objects();
    const id = result(await cli(["info", "/", "--json"])).id;
    expect(result(await cli(["ls", "id:" + id, "--json"])).items).toHaveLength(
      1,
    );
  });
  it("creates normalized directories with trailing separators and rejects directory file targets", async () => {
    let name: string | undefined;
    handler = (req, res, path, body) => {
      if (path.includes("/folders") && req.method === "POST") {
        name = JSON.parse(body.toString()).name;
        return json(res, { id: "created", name });
      }
      if (path.includes("/folders"))
        return json(res, {
          rows: name ? [{ id: "created", name, rowVersion: 1 }] : [],
          count: name ? 1 : 0,
        });
      if (path.includes("/files")) return json(res, { rows: [], count: 0 });
    };
    expect(result(await cli(["mkdir", "/Cafe\u0301/", "--json"])).path).toBe(
      "/Café",
    );
    expect(name).toBe("Café");
    expect(
      result(await cli(["new", "/Café", "--content", "test", "--json"]), 2)
        .code,
    ).toBe("TYPE_MISMATCH");
  });
});

describe("issue regressions: upload inputs", () => {
  it("rejects directory uploads with an accurate message", async () => {
    handler = (_, res, path) => {
      if (path.includes("/folders") || path.includes("/files?"))
        return json(res, { rows: [], count: 0 });
    };
    const error = result(await cli(["put", temp, "/target", "--json"]), 2);
    expect(error.message).toContain("常规文件");
    expect(error.message).not.toContain("--recursive");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("creates cloud names longer than the local filesystem basename limit", async () => {
    const name = "🙂".repeat(130) + ".txt";
    handler = (req, res, path, body) => {
      if (
        req.method === "GET" &&
        (path.includes("/folders") || path.includes("/files?"))
      )
        return json(res, { rows: [], count: 0 });
      if (path === "/api/spaces/ws") return json(res, { regionId: "region" });
      if (path.startsWith("/api/regions"))
        return json(res, {
          rows: [{ id: "region", capabilities: {} }],
          count: 1,
        });
      if (path.endsWith("/upload-sessions")) {
        expect(JSON.parse(body.toString())).toMatchObject({ name, bytes: 7 });
        return json(res, {
          id: "up",
          status: "pending",
          upload: { url: base + "/signed", method: "PUT", headers: {} },
        });
      }
      if (path === "/signed") {
        expect(body.toString()).toBe("fixture");
        return res.end();
      }
      if (path.endsWith("/complete"))
        return json(res, { id: "up", status: "verified" });
      if (path.endsWith("/files") && req.method === "POST")
        return json(res, { ...sampleFile, name }, 201);
      if (path.endsWith("/upload-sessions/up"))
        return json(res, {
          id: "up",
          status: "committed",
          targetFileId: "f1",
          committedRevisionId: "r1",
        });
    };
    expect(
      result(await cli(["new", "/" + name, "--content", "fixture", "--json"]))
        .fileId,
    ).toBe("f1");
  });
});

describe("issue regressions: operations and preflight", () => {
  const row = { ...sampleFile, name: "draft.docx" };
  const handle =
    "dfj1." +
    Buffer.from(
      JSON.stringify({
        type: "conversion",
        spaceId: "ws",
        fileId: "f1",
        revisionId: "r1",
        operationId: "op",
      }),
    ).toString("base64url");
  function setup(
    task = {
      operationId: "op",
      status: "succeeded",
      outputs: [] as unknown[],
      errorCode: "CONVERTER_FAILED",
      retryable: false,
    },
  ) {
    handler = (req, res, path) => {
      if (path.includes("/conversions"))
        return json(
          res,
          req.method === "POST" ? { ...task, status: "queued" } : task,
        );
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.includes("/files"))
        return json(
          res,
          path.endsWith("/files/f1") ? row : { rows: [row], count: 1 },
        );
    };
  }
  it("rejects unsupported inputs, absent revisions, empty outputs and unsupported idempotency", async () => {
    setup();
    expect(
      result(
        await cli([
          "ops",
          "convert",
          "/draft.docx",
          "--to",
          "pdf",
          "--idempotency-key",
          "key",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("UNSUPPORTED_OPERATION");
    expect(
      result(
        await cli([
          "ops",
          "render",
          "/draft.docx",
          "--to",
          "webp",
          "--output",
          "",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    const prior = handler;
    handler = (req, res, path, body) =>
      path.includes("/files")
        ? json(res, { rows: [{ ...row, currentRevisionId: null }], count: 1 })
        : prior(req, res, path, body);
    for (const flags of [[], ["--dry-run"]])
      expect(
        result(
          await cli([
            "ops",
            "render",
            "/draft.docx",
            "--to",
            "webp",
            ...flags,
            "--json",
          ]),
          4,
        ).code,
      ).toBe("CONTENT_NOT_AVAILABLE");
    handler = (req, res, path, body) =>
      path.includes("/files")
        ? json(res, { rows: [{ ...row, name: "notes.txt" }], count: 1 })
        : prior(req, res, path, body);
    for (const flags of [[], ["--dry-run"]])
      expect(
        result(
          await cli([
            "ops",
            "convert",
            "/notes.txt",
            "--to",
            "pdf",
            ...flags,
            "--json",
          ]),
          2,
        ).code,
      ).toBe("UNSUPPORTED_FORMAT");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("distinguishes empty and failed results from pending jobs", async () => {
    setup();
    expect(result(await cli(["jobs", "status", handle, "--json"])).state).toBe(
      "succeeded",
    );
    expect(
      result(await cli(["jobs", "result", handle, "--json"]), 4).code,
    ).toBe("RESULT_NOT_AVAILABLE");
    expect(
      result(
        await cli([
          "ops",
          "render",
          "/draft.docx",
          "--to",
          "webp",
          "--output",
          "/",
          "--json",
        ]),
        4,
      ).code,
    ).toBe("RESULT_NOT_AVAILABLE");
    setup({
      operationId: "op",
      status: "failed",
      outputs: [],
      errorCode: "CONVERTER_FAILED",
      retryable: false,
    });
    const failed = result(await cli(["jobs", "result", handle, "--json"]), 5);
    expect(failed.code).toBe("JOB_FAILED");
    expect(failed.details.serverCode).toBe("CONVERTER_FAILED");
    const waiting = result(
      await cli([
        "ops",
        "render",
        "/draft.docx",
        "--to",
        "webp",
        "--output",
        "/",
        "--json",
      ]),
      5,
    );
    expect(waiting.code).toBe("JOB_FAILED");
    expect(waiting.details.serverCode).toBe("CONVERTER_FAILED");
    expect(waiting.retryable).toBe(false);
    const prior = handler;
    handler = (req, res, path, body) =>
      path.includes("/conversions")
        ? json(res, {
            operationId: "op",
            status: "failed",
            outputs: [],
            errorCode: "CONVERTER_FAILED",
            retryable: false,
          })
        : prior(req, res, path, body);
    const immediate = result(
      await cli(["ops", "render", "/draft.docx", "--to", "webp", "--json"]),
      5,
    );
    expect(immediate.code).toBe("JOB_FAILED");
    expect(immediate.details.serverCode).toBe("CONVERTER_FAILED");
    expect(immediate.retryable).toBe(false);
  });
  it("preserves output persistence HTTP conflicts with the task handle", async () => {
    setup({
      operationId: "op",
      status: "succeeded",
      outputs: [{ artifactId: "a", ordinal: 0, format: "webp" }],
      errorCode: "",
      retryable: false,
    });
    const prior = handler;
    handler = (req, res, path, body) =>
      req.method === "POST" && path.endsWith("/files")
        ? json(res, { code: "resourceDuplicateAdd" }, 409)
        : prior(req, res, path, body);
    const error = result(
      await cli([
        "ops",
        "render",
        "/draft.docx",
        "--to",
        "webp",
        "--output",
        "/",
        "--json",
      ]),
      4,
    );
    expect(error.details.status).toBe(409);
    expect(
      JSON.parse(
        Buffer.from(error.details.job_id.slice(5), "base64url").toString(),
      ),
    ).toEqual(JSON.parse(Buffer.from(handle.slice(5), "base64url").toString()));
    expect(error.retryable).toBe(false);
  });
  it("preflights missing local directories and unavailable restore revisions", async () => {
    setup();
    expect(
      result(
        await cli([
          "get",
          "/draft.docx",
          "missing/file",
          "--dry-run",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("ENOENT");
    const prior = handler;
    handler = (req, res, path, body) =>
      path.includes("/revisions/missing")
        ? json(res, {}, 404)
        : prior(req, res, path, body);
    expect(
      result(
        await cli([
          "version",
          "restore",
          "/draft.docx",
          "--to",
          "missing",
          "--dry-run",
          "--json",
        ]),
        4,
      ).code,
    ).toBe("OBJECT_NOT_FOUND");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("does not fetch raw bytes or print text during cat preflight", async () => {
    setup();
    const prior = handler;
    handler = (req, res, path, body) =>
      path.endsWith("/content")
        ? json(res, {
            url: base + "/raw-secret",
            mediaType: "text/plain",
            bytes: 123,
          })
        : prior(req, res, path, body);
    const data = result(
      await cli(["cat", "/draft.docx", "--dry-run", "--json"]),
    );
    expect(data.dry_run).toBe(true);
    expect(data.text).toBeUndefined();
    expect(requests.some((r) => r.path.includes("raw-secret"))).toBe(false);
  });
  it("guards root copies and nonrecursive nonempty directory removal", async () => {
    setup();
    expect(
      result(
        await cli(["cp", "/", "/Clone", "--recursive", "--dry-run", "--json"]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    const prior = handler;
    handler = (req, res, path, body) =>
      path.includes("/folders")
        ? json(res, {
            rows: path.includes("parentId=")
              ? []
              : [{ id: "d", name: "Outputs", rowVersion: 1 }],
            count: path.includes("parentId=") ? 0 : 1,
          })
        : prior(req, res, path, body);
    const error = result(
      await cli(["rm", "/Outputs", "--permanent", "--dry-run", "--json"]),
      4,
    );
    expect(error.code).toBe("DIRECTORY_NOT_EMPTY");
    expect(error.message).toContain("--recursive");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});

it("copies child paths, bounded stable keys and the selected source revision", async () => {
  const keys: string[] = [];
  handler = (req, res, path, body) => {
    if (req.method === "POST" && path.endsWith("/folders"))
      return json(res, { id: "copydir", name: "Copied" });
    if (req.method === "POST" && path.endsWith("/files")) {
      const params = JSON.parse(body.toString());
      expect(params.source.sourceRevisionId).toBe("r1");
      expect(params.refs[0].sourceRevisionId).toBe("r1");
      expect(params.idempotencyKey.length).toBeLessThanOrEqual(128);
      keys.push(params.idempotencyKey);
      return json(res, { ...sampleFile, id: "copied", name: "inside.txt" });
    }
    if (path.includes("/folders"))
      return json(res, {
        rows: path.includes("parentId=")
          ? []
          : [{ id: "source", name: "Outputs", rowVersion: 1 }],
        count: path.includes("parentId=") ? 0 : 1,
      });
    if (path.includes("/files"))
      return json(res, {
        rows: path.includes("folderId=source")
          ? [{ ...sampleFile, name: "inside.txt" }]
          : [],
        count: path.includes("folderId=source") ? 1 : 0,
      });
  };
  for (let i = 0; i < 2; i++) {
    const data = result(
      await cli([
        "cp",
        "/Outputs",
        "/Copied",
        "--recursive",
        "--idempotency-key",
        "k".repeat(128),
        "--json",
      ]),
    );
    expect(data.items[1].path).toBe("/Copied/inside.txt");
    expect(data.items[1].result.id).toBe("copied");
  }
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

describe("issue regressions: selectors, previews and credentials", () => {
  it("validates API keys through supported workspace discovery when identity is forbidden", async () => {
    let valid = true;
    handler = (_, res, path) => {
      if (path.includes("/user")) return json(res, {}, 403);
      return json(res, { rows: [], count: 0 }, valid ? 200 : 401);
    };
    expect(
      result(
        await cli(
          ["auth", "login", "--token-stdin", "--json"],
          { DECKFLOW_TOKEN: "" },
          temp,
          "synthetic",
        ),
      ).authenticated,
    ).toBe(true);
    expect(result(await cli(["auth", "status", "--json"])).authenticated).toBe(
      true,
    );
    valid = false;
    expect(result(await cli(["auth", "status", "--json"]), 3).code).toBe(
      "UNAUTHENTICATED",
    );
  });
  it("reads explicit file IDs without depending on the directory service", async () => {
    handler = (_, res, path) => {
      if (path.includes("/folders")) return json(res, {}, 503);
      if (path.endsWith("/content"))
        return json(res, {
          url: base + "/bytes",
          mediaType: "text/plain",
          bytes: 2,
        });
      if (path === "/bytes") return res.end("ok");
      return json(res, { ...sampleFile, folderId: null });
    };
    expect(result(await cli(["cat", "id:f1", "--json"])).text).toBe("ok");
    expect(requests.some((r) => r.path.includes("/folders"))).toBe(false);
  });
  it("reuses resolved files across many search hits and rejects unsupported semantic case options", async () => {
    handler = (_, res, path) =>
      path.endsWith("/find")
        ? json(res, {
            hits: Array.from({ length: 50 }, () => ({ fileId: "f1" })),
          })
        : json(res, { ...sampleFile, folderId: null });
    expect(result(await cli(["grep", "query", "--json"])).items).toHaveLength(
      50,
    );
    expect(requests.filter((r) => r.path.endsWith("/files/f1"))).toHaveLength(
      1,
    );
    const count = requests.length;
    expect(
      result(await cli(["seek", "query", "--ignore-case", "--json"]), 2).code,
    ).toBe("UNSUPPORTED_OPERATION");
    expect(requests).toHaveLength(count);
  });
  it("binds image retrieval to its revision and validates all view parameters", async () => {
    handler = (_, res, path) => {
      if (path.endsWith("/content"))
        return json(res, { mediaType: "image/webp", revisionId: "r1" });
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      return json(res, { rows: [sampleFile], count: 1 });
    };
    const data = result(await cli(["view", "/" + sampleFile.name, "--json"]));
    expect(data.image.retrieval).toMatchObject({
      method: "revision.content",
      params: { fileId: "f1", revisionId: "r1" },
    });
    for (const flags of [
      ["--limit", "0"],
      ["--cursor", "bogus"],
      ["--url", "--page", "2"],
      ["--url", "--pages", "1-2"],
    ])
      expect(
        result(
          await cli(["view", "/" + sampleFile.name, ...flags, "--json"]),
          2,
        ).code,
      ).toBe("INVALID_ARGUMENT");
  });
  it("skips unavailable preview tasks and rejects a cursor after task replacement", async () => {
    let op = "new",
      oldOnly = false;
    const task = () => ({
      operationId: op,
      target: "screenshots",
      status: "succeeded",
      outputs: [
        { ordinal: 0, artifactId: "a", mediaType: "image/webp" },
        { ordinal: 1, artifactId: "b", mediaType: "image/webp" },
      ],
    });
    handler = (_, res, path) => {
      if (path.endsWith("/content"))
        return json(res, { mediaType: "application/pdf", revisionId: "r1" });
      if (path.includes("/conversions"))
        return json(res, {
          items: oldOnly
            ? [{ ...task(), outputs: [] }]
            : [{ ...task(), operationId: "old", outputs: [] }, task()],
        });
      if (path.endsWith("/revisions") || path.includes("/revisions?"))
        return json(res, { rows: [{ id: "r0" }], count: 1 });
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      return json(
        res,
        path.endsWith("/files/f1")
          ? sampleFile
          : { rows: [sampleFile], count: 1 },
      );
    };
    const first = result(
      await cli(["view", "/" + sampleFile.name, "--limit", "1", "--json"]),
    );
    expect(first.pages[0].retrieval.params.operationId).toBe("new");
    op = "replacement";
    expect(
      result(
        await cli([
          "view",
          "/" + sampleFile.name,
          "--cursor",
          first.next_cursor,
          "--json",
        ]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    oldOnly = true;
    expect(
      result(await cli(["view", "/" + sampleFile.name, "--json"]), 2).code,
    ).toBe("PREVIEW_NOT_AVAILABLE");
  });
  it("enforces guarded uploads, ID destinations and explicit directory targets", async () => {
    await writeFile(join(temp, "local"), "body");
    let exists = true;
    handler = (req, res, path, body) => {
      if (path.endsWith("/upload-sessions")) {
        expect(JSON.parse(body.toString()).expectedCurrentRevisionId).toBe(
          "r1",
        );
        return json(res, {}, 409);
      }
      if (path === "/api/spaces/ws") return json(res, { regionId: "reg" });
      if (path.startsWith("/api/regions"))
        return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
      if (path.endsWith("/folders/f1")) return json(res, {}, 404);
      if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
      if (path.endsWith("/files/f1"))
        return json(res, {
          ...sampleFile,
          currentRevisionId: "r2",
          folderId: null,
        });
      return json(res, {
        rows: exists ? [sampleFile] : [],
        count: exists ? 1 : 0,
      });
    };
    const token = Buffer.from(
      JSON.stringify({
        id: sampleFile.id,
        row: sampleFile.rowVersion,
        revision: sampleFile.currentRevisionId,
      }),
    ).toString("base64url");
    expect(
      result(
        await cli([
          "put",
          "local",
          "/" + sampleFile.name,
          "--force",
          "--if-version",
          token,
          "--json",
        ]),
        4,
      ).code,
    ).toBe("VERSION_CONFLICT");
    expect(requests.some((r) => r.path.endsWith("/upload-sessions"))).toBe(
      true,
    );
    expect(
      result(
        await cli(["put", "local", "id:f1", "--force", "--dry-run", "--json"]),
      ).dryRun,
    ).toBe(true);
    exists = false;
    expect(
      result(
        await cli([
          "put",
          "local",
          "/missing",
          "--force",
          "--if-version",
          token,
          "--json",
        ]),
        4,
      ).code,
    ).toBe("VERSION_CONFLICT");
    for (const cmd of ["put", "cp", "mv"]) {
      exists = true;
      expect(
        result(
          await cli([
            cmd,
            cmd === "put" ? "local" : "/" + sampleFile.name,
            "/missing/",
            "--json",
          ]),
          4,
        ).code,
      ).toBe("OBJECT_NOT_FOUND");
    }
    expect(
      result(
        await cli([
          "put",
          "local",
          "/x",
          "--resume",
          "fake",
          "--if-version",
          token,
          "--json",
        ]),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      result(
        await cli([
          "new",
          "/x",
          "--type",
          "text/plain",
          "--content",
          "x",
          "--json",
        ]),
        2,
      ).code,
    ).toBe("UNSUPPORTED_OPERATION");
  });
});

it("marks temporary storage failures retryable and respects quiet upload progress", async () => {
  await writeFile(join(temp, "local"), "fixture");
  handler = (_, res, path) => {
    if (path.endsWith("/download"))
      return json(res, {
        downloadId: "audit",
        revisionId: "r1",
        url: base + "/signed",
      });
    if (path === "/signed") return res.writeHead(503).end();
    if (path.endsWith("/files/f1")) return json(res, sampleFile);
    if (path.endsWith("/content"))
      return json(res, {
        revisionId: "r1",
        bytes: 7,
        sha256: hash("fixture"),
        url: base + "/signed",
      });
    if (path.endsWith("/upload-sessions"))
      return json(res, {
        id: "up",
        status: "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    if (path === "/api/spaces/ws") return json(res, { regionId: "reg" });
    if (path.startsWith("/api/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    return json(res, { rows: [], count: 0 });
  };
  const upload = await cli([
    "put",
    "local",
    "/target",
    "--verbose",
    "--quiet",
    "--json",
  ]);
  const error = result(upload, 5);
  expect(error.details.status).toBe(503);
  expect(error.retryable).toBe(true);
  expect(error.details.operationId).toBeTruthy();
  expect(upload.stderr).not.toContain("操作 ID");
  const download = result(await cli(["get", "id:f1", "target", "--json"]), 5);
  expect(download.details.status).toBe(503);
  expect(download.retryable).toBe(true);
});

it("issue 89: rejects unsupported deletion and move idempotency before writes", async () => {
  for (const args of [
    ["rm", "/x", "--permanent", "--yes"],
    ["mv", "/x", "/y"],
  ]) {
    expect(
      result(await cli([...args, "--idempotency-key", "same", "--json"]), 2)
        .code,
    ).toBe("UNSUPPORTED_OPERATION");
  }
  expect(requests).toEqual([]);
});

it("issue 103: rejects restore conditions the backend cannot enforce atomically", async () => {
  expect(
    result(
      await cli([
        "version",
        "restore",
        "/file",
        "--to",
        "r0",
        "--if-version",
        "old",
        "--yes",
        "--json",
      ]),
      2,
    ).code,
  ).toBe("UNSUPPORTED_OPERATION");
  expect(requests).toEqual([]);
});

it("issue 49: local capabilities never create authentication state", async () => {
  expect(
    result(await cli(["ops", "capabilities", "--json"], { DECKFLOW_TOKEN: "" }))
      .items.length,
  ).toBeGreaterThan(0);
  await expect(stat(join(temp, ".deckflow"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(requests).toEqual([]);
});

it("issue 42: missing subcommands use the unified JSON error contract", async () => {
  for (const command of ["config", "auth", "ws", "ops", "jobs", "version"]) {
    const error = result(await cli([command, "--json"]), 2);
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain(command + " 需要子命令");
  }
  expect((await cli(["config", "--help"])).stdout).toContain("用法：");
  expect(requests).toEqual([]);
});

async function scriptRun(
  path: string,
  env: NodeJS.ProcessEnv = {},
  cwd = temp,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(node, [path], {
        cwd,
        env: {
          ...process.env,
          DECKFLOW_LANG: "zh",
          HOME: temp,
          USERPROFILE: temp,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", fail);
      child.on("close", (code) => done({ code, stdout, stderr }));
    },
  );
}
it("issue 67: failed release typechecking prevents packing or publishing", async () => {
  await mkdir(join(temp, "scripts"));
  await writeFile(
    join(temp, "scripts", "release.mjs"),
    (await readFile(resolve("scripts/release.mjs"), "utf8")).replace(
      "../src/i18n.mjs",
      new URL("../src/i18n.mjs", import.meta.url).href,
    ),
  );
  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({ name: "@deckflow/deckflow-cli" }),
  );
  const stub = join(temp, "pnpm.mjs");
  await writeFile(
    stub,
    'console.log("CHECK " + process.argv.slice(2).join(" ")); process.exit(1);',
  );
  const run = await scriptRun(join(temp, "scripts", "release.mjs"), {
    npm_execpath: stub,
  });
  expect(run.code).not.toBe(0);
  expect(run.stdout).toContain("CHECK typecheck");
  expect(run.stdout).not.toContain("CHECK build");
  expect(run.stdout).not.toContain("CHECK pack");
});

it("issue 2: preserves safe backend reasons for disabled content search", async () => {
  handler = (_, res) =>
    json(
      res,
      {
        code: "notAllowed",
        message: "No access",
        data: ["Content search is not enabled"],
      },
      403,
    );
  for (const command of ["grep", "seek", "ask"]) {
    const error = result(await cli([command, "query", "--json"]), 3);
    expect(error.details.server_code).toBe("notAllowed");
    expect(error.details.server_reason).toEqual([
      "Content search is not enabled",
    ]);
  }
});

it("issue 92: keeps search index profile conflicts distinct from file version conflicts", async () => {
  for (const payload of [
    { code: "INDEX_PROFILE_MISMATCH" },
    { code: "resourceDuplicateAdd", data: ["INDEX_PROFILE_MISMATCH"] },
  ]) {
    handler = (_, res) => json(res, payload, 409);
    const error = result(await cli(["seek", "query", "--json"]), 4);
    expect(error.code).toBe("INDEX_PROFILE_MISMATCH");
    expect(error.retryable).toBe(false);
  }
});

it("issue 110: API redirects are actionable configuration errors without retries", async () => {
  handler = (_, res) =>
    res.writeHead(308, { location: base + "/new-api" }).end();
  const error = result(await cli(["ws", "info", "--json"]), 2);
  expect(error.code).toBe("INVALID_API_ENDPOINT");
  expect(error.details.status).toBe(308);
  expect(error.retryable).toBe(false);
  expect(requests).toHaveLength(1);
});

it("issue 120: honors marked transient API errors within safe read retries", async () => {
  let recover = true;
  handler = (_, res) => {
    if (recover && requests.length === 2) return json(res, { id: "ws" });
    res.setHeader("X-Transient-Network-Error", "1");
    return json(res, { code: "temporaryFailure" }, 500);
  };
  expect(result(await cli(["ws", "info", "--json"])).id).toBe("ws");
  expect(requests).toHaveLength(2);
  recover = false;
  requests = [];
  expect(result(await cli(["ws", "info", "--json"]), 5).retryable).toBe(true);
  expect(requests).toHaveLength(2);
  requests = [];
  result(await cli(["ask", "query", "--json"]), 5);
  expect(requests).toHaveLength(1);
});

it("issue 63: exposes the exact answer idempotency key for safe replay", async () => {
  const keys: string[] = [];
  handler = (_, res, _path, body) => {
    keys.push(JSON.parse(body.toString()).idempotencyKey);
    return keys.length === 1
      ? json(res, {}, 504)
      : json(res, { answer: "done", citations: [] });
  };
  const error = result(await cli(["ask", "query", "--json"]), 5);
  expect(error.details.idempotency_key).toBe(keys[0]);
  expect(
    result(
      await cli([
        "ask",
        "query",
        "--idempotency-key",
        error.details.idempotency_key,
        "--json",
      ]),
    ).answer,
  ).toBe("done");
  expect(keys[0]).toBe(keys[1]);
});

it("issue 45: retains paid answers and raw evidence when citation lookup fails", async () => {
  handler = (_, res, path) =>
    path.endsWith("/answer")
      ? json(res, {
          answer: "paid answer",
          cost: 42,
          citations: ["c1"],
          hits: [{ hitId: "c1", fileId: "f1", location: { page: 1 } }],
        })
      : json(res, {}, 404);
  const data = result(await cli(["ask", "query", "--json"]));
  expect(data.answer).toBe("paid answer");
  expect(data.cost).toBe(42);
  expect(data.raw_citations).toEqual(["c1"]);
  expect(data.citation_status).toBe("partial");
  expect(data.citations[0]).toMatchObject({
    file_id: "f1",
    path: null,
    path_status: "unavailable",
  });
});

it("issue 85: direct file permissions do not require readable parent directories", async () => {
  handler = (_, res, path) => {
    if (path.endsWith("/download"))
      return json(res, {
        downloadId: "audit",
        revisionId: "r1",
        url: base + "/raw",
      });
    if (path.includes("/folders")) return json(res, {}, 404);
    if (path === "/raw") return res.end("shared");
    if (path.endsWith("/content"))
      return json(res, {
        url: base + "/raw",
        mediaType: "text/plain",
        revisionId: "r1",
        bytes: 6,
        sha256: hash("shared"),
      });
    return json(res, { ...sampleFile, folderId: "secret" });
  };
  const data = result(await cli(["info", "id:f1", "--json"]));
  expect(data.id).toBe("f1");
  expect(data.path_status).toBe("unavailable");
  expect(result(await cli(["get", "id:f1", "shared", "--json"])).bytes).toBe(6);
  expect(await readFile(join(temp, "shared"), "utf8")).toBe("shared");
});

it("issue 36: info metadata belongs to the same immutable revision snapshot", async () => {
  handler = (_, res, path) => {
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    if (path.endsWith("/revisions/r1/content"))
      return json(res, {
        revisionId: "r1",
        bytes: 100,
        mediaType: "image/webp",
      });
    if (path.endsWith("/content"))
      return json(res, {
        revisionId: "r2",
        bytes: 400,
        mediaType: "image/webp",
      });
    return json(res, { rows: [sampleFile], count: 1 });
  };
  const data = result(await cli(["info", "/" + sampleFile.name, "--json"]));
  expect(data.currentRevisionId).toBe("r1");
  expect(data.size_bytes).toBe(100);
  expect(requests.some((r) => r.path.endsWith("/files/f1/content"))).toBe(
    false,
  );
});

it("issue 100: version pagination requests one bounded backend page", async () => {
  handler = (_, res, path) => {
    if (path.includes("/revisions")) {
      const params = new URL(base + path).searchParams;
      expect(params.get("_maxResults")).toBe("1");
      return json(res, {
        rows: [{ id: "r" + params.get("_startIndex") }],
        count: 1201,
      });
    }
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, { rows: [sampleFile], count: 1 });
  };
  const first = result(
    await cli([
      "version",
      "ls",
      "/" + sampleFile.name,
      "--limit",
      "1",
      "--json",
    ]),
  );
  expect(first.items[0].id).toBe("r0");
  const second = result(
    await cli([
      "version",
      "ls",
      "/" + sampleFile.name,
      "--limit",
      "1",
      "--cursor",
      first.next_cursor,
      "--json",
    ]),
  );
  expect(second.items[0].id).toBe("r1");
  expect(requests.filter((r) => r.path.includes("/revisions"))).toHaveLength(2);
});

it("issue 99: current preview lookup never scans unrelated historical revisions", async () => {
  handler = (_, res, path) => {
    if (path.includes("/conversions")) return json(res, { items: [] });
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    if (path.endsWith("/content"))
      return json(res, { mediaType: "application/pdf", revisionId: "r1" });
    return json(res, { rows: [sampleFile], count: 1 });
  };
  expect(
    result(await cli(["view", "/" + sampleFile.name, "--json"]), 2).code,
  ).toBe("PREVIEW_NOT_AVAILABLE");
  expect(requests.filter((r) => r.path.includes("/conversions"))).toHaveLength(
    1,
  );
  expect(requests.some((r) => /\/revisions(?:\?|$)/.test(r.path))).toBe(false);
});

it("issue 94: returns the committed move response without a fallible readback", async () => {
  handler = (req, res, path) => {
    if (req.method !== "GET")
      return json(res, { ...sampleFile, name: "renamed.pdf", rowVersion: 9 });
    if (path.endsWith("/files/f1")) return json(res, {}, 503);
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, { rows: [sampleFile], count: 1 });
  };
  const data = result(
    await cli(["mv", "/" + sampleFile.name, "/renamed.pdf", "--json"]),
  );
  expect(data).toMatchObject({
    id: "f1",
    path: "/renamed.pdf",
    name: "renamed.pdf",
    rowVersion: 9,
  });
  expect(
    requests.some((r) => r.method === "GET" && r.path.endsWith("/files/f1")),
  ).toBe(false);
});

it("issue 87: nested mkdir traverses each parent only once", async () => {
  const folders: {
    id: string;
    parentId: string | null;
    name: string;
    rowVersion: number;
  }[] = [];
  handler = (req, res, path, body) => {
    if (req.method === "POST") {
      const p = JSON.parse(body.toString());
      const row = { ...p, id: "d" + folders.length, rowVersion: 1 };
      folders.push(row);
      return json(res, row);
    }
    if (path.includes("/folders")) {
      const parent = new URL(base + path).searchParams.get("parentId");
      const rows = folders.filter((f) => f.parentId === parent);
      return json(res, { rows, count: rows.length });
    }
    return json(res, { rows: [], count: 0 });
  };
  const path = "/" + Array.from({ length: 12 }, (_, i) => "d" + i).join("/");
  expect(result(await cli(["mkdir", path, "--parents", "--json"])).path).toBe(
    path,
  );
  expect(folders).toHaveLength(12);
  expect(requests.filter((r) => r.method === "GET")).toHaveLength(24);
});

it("issue 86: mkdir parents recovers a concurrently created parent", async () => {
  let raced = false,
    child = false;
  handler = (req, res, path, body) => {
    if (req.method === "POST") {
      const p = JSON.parse(body.toString());
      if (p.name === "Race") {
        raced = true;
        return json(res, {}, 409);
      }
      expect(p).toMatchObject({ name: "Child", parentId: "race" });
      child = true;
      return json(res, { ...p, id: "child", rowVersion: 1 });
    }
    const rows =
      path.includes("/folders") && !path.includes("parentId=") && raced
        ? [{ id: "race", name: "Race", rowVersion: 1 }]
        : [];
    return json(res, { rows, count: rows.length });
  };
  expect(
    result(await cli(["mkdir", "/Race/Child", "--parents", "--json"])).path,
  ).toBe("/Race/Child");
  expect(child).toBe(true);
});

it("issue 107: known nonmatching formats do not trigger content lookups", async () => {
  const rows = [
    ...Array.from({ length: 120 }, (_, i) => ({
      ...sampleFile,
      id: "p" + i,
      name: i + ".pdf",
      format: "pdf",
    })),
    { ...sampleFile, id: "image", name: "art.webp", format: "webp" },
  ];
  handler = (_, res, path) => {
    if (path.endsWith("/content"))
      return json(res, { mediaType: "image/webp" });
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    const offset = Number(
      new URL(base + path).searchParams.get("_startIndex") ?? 0,
    );
    return json(res, {
      rows: rows.slice(offset, offset + 100),
      count: rows.length,
    });
  };
  expect(
    result(await cli(["find", "/", "--type", "image", "--json"])).items[0].id,
  ).toBe("image");
  expect(requests.filter((r) => r.path.endsWith("/content"))).toHaveLength(0);
});

it("issue 18: inaccessible content does not erase readable metadata or other matches", async () => {
  handler = (_, res, path) => {
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    if (path.includes("/f1/") && path.endsWith("/content"))
      return json(res, {}, 404);
    if (path.endsWith("/content"))
      return json(res, { mediaType: "image/webp", bytes: 1 });
    return json(res, {
      rows: [
        { ...sampleFile, name: "cold.webp" },
        { ...sampleFile, id: "warm", name: "warm.webp" },
      ],
      count: 2,
    });
  };
  const info = result(await cli(["info", "/cold.webp", "--json"]));
  expect(info.id).toBe("f1");
  expect(info.content_status).toBe("unavailable");
  const found = result(await cli(["find", "/", "--type", "image", "--json"]));
  expect(found.items.map((r: { id: string }) => r.id)).toEqual(["warm"]);
  expect(found.partial).toBe(true);
  expect(found.unavailable_items[0].id).toBe("f1");
});

it("issue 48: partial recursive copies retain the failing child HTTP reason", async () => {
  handler = (req, res, path) => {
    if (req.method === "POST")
      return path.endsWith("/folders")
        ? json(res, { id: "dest" })
        : json(
            res,
            { code: "notAllowed", data: ["No file creation permission"] },
            403,
          );
    if (path.includes("/folders"))
      return json(res, {
        rows: path.includes("parentId=")
          ? []
          : [{ id: "src", name: "Source", rowVersion: 1 }],
        count: path.includes("parentId=") ? 0 : 1,
      });
    return json(res, {
      rows: path.includes("folderId=src") ? [sampleFile] : [],
      count: path.includes("folderId=src") ? 1 : 0,
    });
  };
  const error = result(
    await cli(["cp", "/Source", "/Copy", "--recursive", "--json"]),
    5,
  );
  expect(error.code).toBe("PARTIAL_FAILURE");
  expect(error.details.results[1].error).toMatchObject({
    code: "notAllowed",
    status: 403,
  });
  expect(error.details.cause).not.toBe("BACKEND_UNAVAILABLE");
});

it("issue 53: a closed stdout reader exits cleanly without an EPIPE stack", async () => {
  const run = await new Promise<{ code: number | null; stderr: string }>(
    (done, fail) => {
      const child = spawn(node, [binary, "ops", "capabilities", "--json"], {
        env: { ...process.env, HOME: temp },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.destroy();
      child.on("error", fail);
      child.on("close", (code) => done({ code, stderr }));
    },
  );
  expect(run.code).toBe(0);
  expect(run.stderr).toBe("");
});

it("issue 95: generated render names remain within the backend Unicode name limit", async () => {
  const source = { ...sampleFile, name: "x".repeat(251) + ".pdf" };
  handler = (req, res, path, body) => {
    if (path.includes("/conversions"))
      return json(res, {
        operationId: "op",
        status: "succeeded",
        outputs: [{ artifactId: "a", ordinal: 0, format: "webp" }],
      });
    if (req.method === "POST") {
      const p = JSON.parse(body.toString());
      expect(Array.from(p.name).length).toBe(255);
      expect(p.name).toMatch(/-1\.webp$/);
      return json(res, { ...sampleFile, id: "out" });
    }
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, { rows: [source], count: 1 });
  };
  expect(
    result(
      await cli([
        "ops",
        "render",
        "/" + source.name,
        "--to",
        "webp",
        "--output",
        "/",
        "--json",
      ]),
    ).output[0].id,
  ).toBe("out");
});

it("issue 90: refuses saving into a replaced output directory after waiting", async () => {
  let replaced = false;
  handler = (req, res, path) => {
    if (path.includes("/conversions")) {
      if (req.method === "GET") replaced = true;
      return json(res, {
        operationId: "op",
        status: req.method === "POST" ? "queued" : "succeeded",
        outputs: [{ artifactId: "a", ordinal: 0, format: "webp" }],
      });
    }
    if (path.includes("/folders"))
      return json(res, {
        rows: [
          { id: replaced ? "new" : "old", name: "Outputs", rowVersion: 1 },
        ],
        count: 1,
      });
    return json(res, { rows: [sampleFile], count: 1 });
  };
  const error = result(
    await cli([
      "ops",
      "render",
      "/" + sampleFile.name,
      "--to",
      "webp",
      "--output",
      "/Outputs",
      "--json",
    ]),
    4,
  );
  expect(error.code).toBe("OUTPUT_TARGET_CHANGED");
  expect(error.details.job_id).toBeTruthy();
  expect(
    requests.some((r) => r.method === "POST" && r.path.endsWith("/files")),
  ).toBe(false);
});

async function smokeFixture(
  stub: string,
  fast = false,
  env: NodeJS.ProcessEnv = {},
) {
  await mkdir(join(temp, "dist"));
  await writeFile(join(temp, "dist", "cli.js"), stub);
  let source = (
    await readFile(resolve("scripts/live-smoke.mjs"), "utf8")
  ).replace(
    "../src/i18n.mjs",
    new URL("../src/i18n.mjs", import.meta.url).href,
  );
  if (fast)
    source = source.replace("await sleep(1000)", "await Promise.resolve()");
  const script = join(temp, "smoke.mjs");
  await writeFile(script, source);
  return scriptRun(script, {
    DECKFLOW_SMOKE_SPACE: "ws",
    DECKFLOW_API_URL: base + "/api",
    DECKFLOW_TOKEN: "synthetic",
    ...env,
  });
}
it("issue 114: cleanup timeout includes the exact job handle and resource path", async () => {
  const run = await smokeFixture(
    `const a = process.argv[2];if(a === "put") {console.error("UPLOAD_FAIL");process.exit(5);}console.log(JSON.stringify({ok:true,data:a === "rm" ? {job_id:"dfj1.cleanup"} : a === "jobs" ? {state:"running"} : {}}));`,
    true,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("dfj1.cleanup");
  expect(run.stderr).toContain("/deckflow-smoke-");
  expect(run.stderr).toContain("--ws ws");
});

it("issue 113: smoke CLI state stays inside the disposable smoke home", async () => {
  const log = join(temp, "env.log");
  const run = await smokeFixture(
    `require("fs").appendFileSync(process.env.SMOKE_LOG, JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME})+"\\n");const a=process.argv[2];if(a==="put")process.exit(5);console.log(JSON.stringify({ok:true,data:a==="rm"?{job_id:"cleanup"}:a==="jobs"?{state:"succeeded"}:{}}));`,
    false,
    { SMOKE_LOG: log },
  );
  expect(run.code).not.toBe(0);
  const entries = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(entries.length).toBeGreaterThan(2);
  for (const entry of entries) {
    expect(entry.home).not.toBe(temp);
    expect(entry.home).toBe(entry.xdg);
  }
  await expect(stat(entries[0].home)).rejects.toMatchObject({ code: "ENOENT" });
});

it("issue 66: smoke diagnostics retain both primary and cleanup failures", async () => {
  const run = await smokeFixture(
    `const a=process.argv[2];if(a==="put"||a==="rm"){console.log(JSON.stringify({ok:false,error:{code:a==="put"?"UPLOAD_503":"CLEANUP_403",message:"synthetic failure"}}));process.exit(5);}console.log(JSON.stringify({ok:true,data:{}}));`,
  );
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain("UPLOAD_503");
  expect(run.stderr).toContain("CLEANUP_403");
});

it("issue 65: smoke checks uncertain creation and cleans the committed directory", async () => {
  const log = join(temp, "commands");
  const run = await smokeFixture(
    `const a=process.argv[2];require("fs").appendFileSync(process.env.SMOKE_LOG,a+"\\n");if(a==="mkdir"){console.log(JSON.stringify({ok:false,error:{code:"BACKEND_UNAVAILABLE"}}));process.exit(5);}console.log(JSON.stringify({ok:true,data:a==="info"?{kind:"directory"}:a==="rm"?{job_id:"cleanup"}:a==="jobs"?{state:"succeeded"}:{}}));`,
    false,
    { SMOKE_LOG: log },
  );
  expect(run.code).not.toBe(0);
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
    "mkdir",
    "info",
    "rm",
    "jobs",
  ]);
});

it("issue 62: expired upload sessions require restarting instead of resuming", async () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  await writeFile(join(temp, "source"), "fixture");
  await mkdir(join(temp, "deckflow", "operations"), { recursive: true });
  await writeFile(
    join(temp, "deckflow", "operations", id + ".json"),
    JSON.stringify({
      kind: "upload",
      endpoint: base + "/api",
      spaceId: "ws",
      path: join(temp, "source"),
      bytes: 7,
      sha256: hash("fixture"),
      expectedCurrentRevisionId: null,
      maxParts: 10000,
      sessionId: "expired",
    }),
  );
  handler = (_, res) =>
    json(res, {
      id: "expired",
      status: "expired",
      errorCode: "SESSION_EXPIRED",
    });
  const error = result(
    await cli(["put", "LOCAL", "DEST", "--resume", id, "--json"]),
    4,
  );
  expect(error.details.restart_required).toBe(true);
  expect(error.details.resume).toBeUndefined();
});

it("issue 6: failed new retains the exact source bytes required by its resume command", async () => {
  let fail = true;
  handler = (req, res, path) => {
    if (path === "/signed") return res.writeHead(fail ? 503 : 200).end();
    if (path.includes("/upload-sessions"))
      return json(res, {
        id: "up",
        status: path.endsWith("/complete") ? "verified" : "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    if (req.method === "POST" && path.endsWith("/files"))
      return json(res, sampleFile);
    if (path === "/api/spaces/ws") return json(res, { regionId: "reg" });
    if (path.startsWith("/api/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    return json(res, { rows: [], count: 0 });
  };
  const error = result(
    await cli(["new", "/fresh.txt", "--content", "fixture", "--json"]),
    5,
  );
  expect(error.details.source_retained).toBe(true);
  const state = JSON.parse(
    await readFile(
      join(temp, "deckflow", "operations", error.details.operationId + ".json"),
      "utf8",
    ),
  );
  try {
    expect(await readFile(state.path, "utf8")).toBe("fixture");
    fail = false;
    expect(
      result(
        await cli([
          "put",
          "LOCAL",
          "DEST",
          "--resume",
          error.details.operationId,
          "--json",
        ]),
      ).fileId,
    ).toBe("f1");
  } finally {
    await rm(resolve(state.path, ".."), { recursive: true, force: true });
  }
});

it("issue 47: same upload key in distinct API environments retains separate state", async () => {
  await writeFile(join(temp, "source"), "fixture");
  handler = (_, res, path) => {
    if (path === "/signed") return res.writeHead(503).end();
    if (path.includes("/upload-sessions"))
      return json(res, {
        id: path.startsWith("/one") ? "one" : "two",
        status: "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    if (path.endsWith("/spaces/ws")) return json(res, { regionId: "reg" });
    if (path.includes("/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    return json(res, { rows: [], count: 0 });
  };
  const first = result(
    await cli(
      ["put", "source", "/target", "--idempotency-key", "same", "--json"],
      { DECKFLOW_API_URL: base + "/one" },
    ),
    5,
  );
  const second = result(
    await cli(
      ["put", "source", "/target", "--idempotency-key", "same", "--json"],
      { DECKFLOW_API_URL: base + "/two" },
    ),
    5,
  );
  expect(first.details.operationId).not.toBe(second.details.operationId);
  const resumed = result(
    await cli(
      ["put", "LOCAL", "DEST", "--resume", first.details.operationId, "--json"],
      { DECKFLOW_API_URL: base + "/one" },
    ),
    5,
  );
  expect(resumed.details.uploadSessionId).toBe("one");
});

it("issue 104: distinct upload credentials cannot overwrite or resume each other's state", async () => {
  await writeFile(join(temp, "source"), "fixture");
  handler = (req, res, path) => {
    if (path === "/signed") return res.writeHead(503).end();
    if (path.includes("/upload-sessions"))
      return json(res, {
        id: req.headers.authorization === "Bearer member-one" ? "one" : "two",
        status: "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    if (path.endsWith("/spaces/ws")) return json(res, { regionId: "reg" });
    if (path.includes("/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    return json(res, { rows: [], count: 0 });
  };
  const errors = [];
  for (const token of ["member-one", "member-two"])
    errors.push(
      result(
        await cli(
          ["put", "source", "/target", "--idempotency-key", "same", "--json"],
          { DECKFLOW_TOKEN: token },
        ),
        5,
      ),
    );
  expect(errors[0].details.operationId).not.toBe(errors[1].details.operationId);
  expect(
    result(
      await cli(
        [
          "put",
          "LOCAL",
          "DEST",
          "--resume",
          errors[0].details.operationId,
          "--json",
        ],
        { DECKFLOW_TOKEN: "member-two" },
      ),
      2,
    ).code,
  ).toBe("INVALID_ARGUMENT");
});

it("issue 72: conflicting uploads never overwrite an existing resumable request", async () => {
  await writeFile(join(temp, "one"), "first");
  await writeFile(join(temp, "two"), "second");
  handler = (_, res, path) => {
    if (path === "/signed") return res.writeHead(503).end();
    if (path.includes("/upload-sessions"))
      return json(res, {
        id: "original",
        status: "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    if (path.endsWith("/spaces/ws")) return json(res, { regionId: "reg" });
    if (path.includes("/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    return json(res, { rows: [], count: 0 });
  };
  const first = result(
    await cli(["put", "one", "/one", "--idempotency-key", "same", "--json"]),
    5,
  );
  const path = join(
    temp,
    "deckflow",
    "operations",
    first.details.operationId + ".json",
  );
  const before = await readFile(path, "utf8");
  expect(
    result(
      await cli(["put", "two", "/two", "--idempotency-key", "same", "--json"]),
      4,
    ).code,
  ).toBe("IDEMPOTENCY_CONFLICT");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(
    requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/upload-sessions"),
    ),
  ).toHaveLength(1);
});

it("issue 78: discovers paginated upload regions before enforcing their limits", async () => {
  await writeFile(join(temp, "source"), "too large");
  handler = (_, res, path) => {
    if (path.endsWith("/spaces/ws")) return json(res, { regionId: "target" });
    if (path.includes("/regions")) {
      const offset = Number(
        new URL(base + path).searchParams.get("_startIndex"),
      );
      return json(res, {
        rows:
          offset === 0
            ? Array.from({ length: 100 }, (_, i) => ({
                id: "r" + i,
                capabilities: {},
              }))
            : [{ id: "target", capabilities: { maxUploadBytes: 4 } }],
        count: 101,
      });
    }
    return json(res, { rows: [], count: 0 });
  };
  expect(
    result(await cli(["put", "source", "/target", "--json"]), 2).code,
  ).toBe("INVALID_ARGUMENT");
  expect(requests.filter((r) => r.path.includes("/regions"))).toHaveLength(2);
  expect(requests.some((r) => r.method === "POST")).toBe(false);
});

it("issue 77: upload dry-run checks the same known regional file-size limit", async () => {
  await writeFile(join(temp, "source"), "too large");
  handler = (_, res, path) =>
    path.endsWith("/spaces/ws")
      ? json(res, { regionId: "reg" })
      : path.includes("/regions")
        ? json(res, {
            rows: [{ id: "reg", capabilities: { maxUploadBytes: 4 } }],
            count: 1,
          })
        : json(res, { rows: [], count: 0 });
  expect(
    result(await cli(["put", "source", "/target", "--dry-run", "--json"]), 2)
      .code,
  ).toBe("INVALID_ARGUMENT");
  expect(requests.some((r) => r.method === "POST")).toBe(false);
});

it("issue 81: a concurrently committed multipart session returns its original result", async () => {
  const id = "12345678-1234-1234-1234-123456789abc",
    bytes = 32 * 1024 ** 2;
  const path = join(temp, "source");
  await writeFile(path, "");
  await truncate(path, bytes);
  await mkdir(join(temp, "deckflow", "operations"), { recursive: true });
  await writeFile(
    join(temp, "deckflow", "operations", id + ".json"),
    JSON.stringify({
      kind: "upload",
      endpoint: base + "/api",
      spaceId: "ws",
      path,
      bytes,
      sha256: hash(Buffer.alloc(bytes)),
      expectedCurrentRevisionId: null,
      maxParts: 10000,
      sessionId: "up",
    }),
  );
  let reads = 0;
  handler = (_, res, path) =>
    path.endsWith("/parts")
      ? json(res, {}, 409)
      : json(
          res,
          ++reads === 1
            ? { id: "up", status: "uploading", multipart: true, parts: [] }
            : {
                id: "up",
                status: "committed",
                targetFileId: "f1",
                committedRevisionId: "r1",
              },
        );
  expect(
    result(await cli(["put", "LOCAL", "DEST", "--resume", id, "--json"])),
  ).toMatchObject({ fileId: "f1", revisionId: "r1", status: "committed" });
  expect(reads).toBe(2);
});

it("issue 122: SIGINT download cancellation removes partial temporary files", async () => {
  handler = async (_, res, path) => {
    if (path.endsWith("/download"))
      return json(res, {
        downloadId: "audit",
        revisionId: "r1",
        url: base + "/slow",
      });
    if (path === "/slow") {
      res.write(Buffer.alloc(65536));
      await new Promise<void>((done) => res.once("close", done));
      res.end();
      return;
    }
    if (path.endsWith("/content"))
      return json(res, {
        bytes: 200000,
        sha256: hash("unused"),
        url: base + "/slow",
        revisionId: "r1",
      });
    return json(res, { ...sampleFile, folderId: null });
  };
  const child = spawn(node, [binary, "get", "id:f1", "out", "--json"], {
    cwd: temp,
    env: {
      ...process.env,
      HOME: temp,
      XDG_CONFIG_HOME: temp,
      DECKFLOW_API_URL: base + "/api",
      DECKFLOW_TOKEN: "synthetic",
      DECKFLOW_WORKSPACE: "ws",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.resume();
  const finished = new Promise<number | null>((done) =>
    child.on("close", done),
  );
  try {
    for (let i = 0; i < 100; i++) {
      if (
        (await readdir(temp)).some(
          (n) => n.startsWith(".deckflow-") && n.endsWith(".tmp"),
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(
      (await readdir(temp)).some(
        (n) => n.startsWith(".deckflow-") && n.endsWith(".tmp"),
      ),
    ).toBe(true);
    child.kill("SIGINT");
    expect(await finished).toBe(2);
    expect(JSON.parse(stdout).error.code).toBe("CANCELLED");
    expect(
      (await readdir(temp)).some(
        (n) => n.startsWith(".deckflow-") && n.endsWith(".tmp"),
      ),
    ).toBe(false);
    await expect(stat(join(temp, "out"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

it("issue 121: chunked text decoding preserves UTF-8 sequences across decode boundaries", async () => {
  const text =
    "\ufeff" + "a".repeat(1024 * 1024 - 4) + "€" + "z".repeat(1024 * 1024);
  handler = (_, res, path) =>
    path === "/large"
      ? res.end(text)
      : path.endsWith("/content")
        ? json(res, {
            mediaType: "text/plain",
            url: base + "/large",
            bytes: Buffer.byteLength(text),
            sha256: hash(text),
          })
        : json(res, { ...sampleFile, folderId: null });
  expect((await cli(["cat", "id:f1"])).stdout).toBe(text);
  expect(result(await cli(["cat", "id:f1", "--json"])).text).toBe(text);
});

it("issue 73: preview and persisted renders enumerate all screenshot pages", async () => {
  const pages = Array.from({ length: 101 }, (_, ordinal) => ({
    artifactId: "a",
    itemId: "i" + ordinal,
    ordinal,
    mediaType: "image/webp",
    format: "webp",
    url: base + "/unused",
    bytes: 1,
    sha256: "unused",
  }));
  let stored = 0;
  handler = (req, res, path) => {
    if (path.endsWith("/screenshots"))
      return json(res, { operationId: "op", revisionId: "r1", pages });
    if (path.includes("/conversions")) {
      const task = {
        operationId: "op",
        target: "screenshots",
        status: "succeeded",
        outputs: pages.slice(0, 100),
      };
      return json(
        res,
        /\/conversions(?:\?|$)/.test(path) && req.method === "GET"
          ? { items: [task] }
          : task,
      );
    }
    if (req.method === "POST" && path.endsWith("/files"))
      return json(res, { ...sampleFile, id: "out" + ++stored });
    if (path.endsWith("/content"))
      return json(res, { mediaType: "application/pdf", revisionId: "r1" });
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(
      res,
      path.endsWith("/files/f1")
        ? sampleFile
        : { rows: [sampleFile], count: 1 },
    );
  };
  expect(
    result(
      await cli(["view", "/" + sampleFile.name, "--page", "101", "--json"]),
    ).pages[0].page,
  ).toBe(101);
  expect(
    result(
      await cli([
        "ops",
        "render",
        "/" + sampleFile.name,
        "--to",
        "webp",
        "--output",
        "/",
        "--json",
      ]),
    ).output,
  ).toHaveLength(101);
  expect(stored).toBe(101);
}, 20000);

it("issue 21: render persistence safely replays saved pages and resumes missing ones", async () => {
  const stored = new Map<string, typeof sampleFile>();
  let failSecond = true;
  const outputs = [0, 1].map((ordinal) => ({
    artifactId: "a",
    itemId: "i" + ordinal,
    ordinal,
    format: "webp",
    mediaType: "image/webp",
  }));
  handler = (req, res, path, body) => {
    if (path.includes("/conversions"))
      return json(res, { operationId: "op", status: "succeeded", outputs });
    if (req.method === "POST" && path.endsWith("/files")) {
      const p = JSON.parse(body.toString());
      if (p.name.endsWith("-2.webp") && failSecond) {
        failSecond = false;
        return json(res, {}, 503);
      }
      if (!stored.has(p.idempotencyKey))
        stored.set(p.idempotencyKey, {
          ...sampleFile,
          id: "out" + stored.size,
          name: p.name,
        });
      return json(res, stored.get(p.idempotencyKey));
    }
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, {
      rows: [sampleFile, ...stored.values()],
      count: stored.size + 1,
    });
  };
  const args = [
    "ops",
    "render",
    "/" + sampleFile.name,
    "--to",
    "webp",
    "--output",
    "/",
    "--json",
  ];
  const failure = result(await cli(args), 5);
  expect(failure.details.results).toHaveLength(1);
  const success = result(await cli(args));
  expect(success.output).toHaveLength(2);
  expect(stored.size).toBe(2);
  expect(success.output[0].id).toBe(failure.details.results[0].id);
});

it("issue 105: fixed-ID deletion replays its original condition after details disappear", async () => {
  let deleted = false;
  handler = (req, res, path, body) => {
    if (req.method === "DELETE") {
      expect(JSON.parse(body.toString()).expectedRowVersion).toBe(8);
      deleted = true;
      return json(res, { id: "job", status: "running" });
    }
    if (path.includes("/folders") || deleted) return json(res, {}, 404);
    return json(res, { ...sampleFile, folderId: null });
  };
  const first = result(
    await cli(["rm", "id:f1", "--permanent", "--yes", "--json"]),
  );
  const second = result(
    await cli(["rm", "id:f1", "--permanent", "--yes", "--json"]),
  );
  expect(second.job_id).toBe(first.job_id);
  expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
});

it("issue 80: restore replays the original current-revision precondition", async () => {
  let current = "r1";
  const expected: string[] = [];
  handler = (req, res, path, body) => {
    if (req.method === "POST") {
      expected.push(JSON.parse(body.toString()).expectedCurrentRevisionId);
      current = "restored";
      return json(res, { id: "restored" });
    }
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    if (path.includes("/revisions/old")) return json(res, { id: "old" });
    return json(res, {
      rows: [{ ...sampleFile, currentRevisionId: current }],
      count: 1,
    });
  };
  const args = [
    "version",
    "restore",
    "/" + sampleFile.name,
    "--to",
    "old",
    "--yes",
    "--idempotency-key",
    "same",
    "--json",
  ];
  expect(result(await cli(args)).id).toBe("restored");
  expect(result(await cli(args)).id).toBe("restored");
  expect(expected).toEqual(["r1", "r1"]);
});

it("issue 27: completed keyed uploads return their original result on retry", async () => {
  await writeFile(join(temp, "source"), "fixture");
  let created = false;
  handler = (req, res, path) => {
    if (path === "/signed") return res.end();
    if (path.includes("/upload-sessions"))
      return json(
        res,
        created
          ? {
              id: "up",
              status: "committed",
              targetFileId: "f1",
              committedRevisionId: "r1",
            }
          : {
              id: "up",
              status: path.endsWith("/complete") ? "verified" : "pending",
              upload: { url: base + "/signed", method: "PUT", headers: {} },
            },
      );
    if (req.method === "POST" && path.endsWith("/files")) {
      created = true;
      return json(res, { ...sampleFile, name: "upload.txt" });
    }
    if (path.endsWith("/spaces/ws")) return json(res, { regionId: "reg" });
    if (path.includes("/regions"))
      return json(res, { rows: [{ id: "reg", capabilities: {} }], count: 1 });
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, {
      rows: created ? [{ ...sampleFile, name: "upload.txt" }] : [],
      count: created ? 1 : 0,
    });
  };
  const args = [
    "put",
    "source",
    "/upload.txt",
    "--idempotency-key",
    "same",
    "--json",
  ];
  expect(result(await cli(args)).fileId).toBe("f1");
  expect(result(await cli(args)).fileId).toBe("f1");
  expect(
    requests.filter((r) => r.method === "POST" && r.path.endsWith("/files")),
  ).toHaveLength(1);
});
it("issue 27: keyed file copies reach backend replay despite existing targets", async () => {
  let created = false;
  const bodies: string[] = [];
  handler = (req, res, path, body) => {
    if (req.method === "POST") {
      if (bodies.length && body.toString() !== bodies[0])
        return json(res, {}, 409);
      bodies.push(body.toString());
      created = true;
      return json(res, { ...sampleFile, id: "copy", name: "copy.pdf" });
    }
    if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
    return json(res, {
      rows: [
        sampleFile,
        ...(created ? [{ ...sampleFile, id: "copy", name: "copy.pdf" }] : []),
      ],
      count: created ? 2 : 1,
    });
  };
  const args = [
    "cp",
    "/" + sampleFile.name,
    "/copy.pdf",
    "--idempotency-key",
    "same",
    "--json",
  ];
  expect(result(await cli(args)).id).toBe("copy");
  expect(result(await cli(args)).id).toBe("copy");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(
    result(
      await cli([
        "cp",
        "/" + sampleFile.name,
        "/different.pdf",
        "--idempotency-key",
        "same",
        "--json",
      ]),
      4,
    ).code,
  ).toBe("VERSION_CONFLICT");
});

it("issue 5: get uses the metered download grant and keeps integrity and quota errors", async () => {
  let denied = false;
  let rawReads = 0;
  const grants: { revisionId: string; requestId: string }[] = [];
  handler = (_, res, path, body) => {
    if (path === "/raw") {
      rawReads++;
      return res.end("fixture");
    }
    if (path.endsWith("/download")) {
      grants.push(JSON.parse(body.toString()));
      return denied
        ? json(res, { code: "EGRESS_CREDIT_EXHAUSTED" }, 402)
        : json(res, {
            downloadId: "audit1",
            revisionId: "r1",
            url: base + "/raw",
          });
    }
    if (path.endsWith("/content"))
      return json(res, {
        revisionId: "r1",
        mediaType: "text/plain",
        bytes: 7,
        sha256: hash("fixture"),
      });
    return json(res, { ...sampleFile, folderId: null });
  };
  const downloaded = result(await cli(["get", "id:f1", "allowed", "--json"]));
  expect(downloaded.download_id).toBe("audit1");
  expect(await readFile(join(temp, "allowed"), "utf8")).toBe("fixture");
  expect(grants[0].revisionId).toBe("r1");
  expect(grants[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  denied = true;
  const error = result(await cli(["get", "id:f1", "denied", "--json"]), 5);
  expect(error.code).toBe("EGRESS_CREDIT_EXHAUSTED");
  expect(rawReads).toBe(1);
  await expect(stat(join(temp, "denied"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

describe("browser callback authorization", () => {
  for (const mode of [undefined, "token"])
    it(`saves ${mode ?? "default API key"} only after the local callback`, async () => {
      const credentials = join(temp, ".deckflow", "credentials");
      await mkdir(join(temp, ".deckflow"), { recursive: true });
      await writeFile(
        credentials,
        JSON.stringify({
          token: "previous",
          tokenApiRoot: base + "/api",
          spaceId: "saved-space",
        }),
      );
      let exchanges = 0;
      let callbackUrl = "";
      let callbackTask: Promise<void> | undefined;
      handler = (req, res, path, body) => {
        expect(req.headers.authorization).toBeUndefined();
        const data = JSON.parse(body.toString());
        if (path === "/api/cli/authorizations") {
          expect(data.mode).toBe("token");
          expect(data.state).toMatch(/^[\w-]{43}$/);
          callbackUrl = data.redirectUri + "?state=" + data.state;
          callbackTask = (async () => {
            const invalid = await fetch(data.redirectUri + "?state=wrong");
            expect(invalid.status).toBe(400);
            expect(exchanges).toBe(0);
            expect(JSON.parse(await readFile(credentials, "utf8")).token).toBe(
              "previous",
            );
            const response = await fetch(callbackUrl);
            expect(response.status).toBe(200);
          })();
          return json(res, {
            deviceCode: "d".repeat(43),
            userCode: "ABCDEF1234",
            verificationPath: "/cli/authorize?user_code=ABCDEF1234",
            expiresIn: 600,
            interval: 5,
          });
        }
        if (path === "/api/cli/authorizations/exchange") {
          exchanges++;
          expect(data.deviceCode).toBe("d".repeat(43));
          return json(res, {
            status: "redeemed",
            mode: "token",
            credential: "cli_new-secret",
            userId: "user1",
            expiredAt: null,
            keyId: "key1",
            scope: "read",
          });
        }
      };
      const run = await cli(
        [
          "auth",
          "login",
          "--no-browser",
          "--json",
          ...(mode ? ["--mode", mode] : []),
        ],
        { DECKFLOW_TOKEN: "" },
      );
      await callbackTask;
      expect(result(run)).toMatchObject({
        authenticated: true,
        mode: "token",
        user: { id: "user1" },
      });
      expect(exchanges).toBe(1);
      expect(requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
      expect(run.stderr).toContain(
        base + "/cli/authorize?user_code=ABCDEF1234",
      );
      expect(run.stdout + run.stderr).not.toContain("new-secret");
      expect(run.stdout + run.stderr).not.toContain("d".repeat(43));
      expect(JSON.parse(await readFile(credentials, "utf8"))).toMatchObject({
        token: "cli_new-secret",
        tokenApiRoot: base + "/api",
        spaceId: "saved-space",
      });
      expect((await stat(credentials)).mode & 0o777).toBe(0o600);
      await expect(fetch(callbackUrl)).rejects.toThrow();
    });

  for (const outcome of ["denied", "timeout", "pending", "unsafe-link"])
    it(`preserves credentials and cleans up on ${outcome}`, async () => {
      const credentials = join(temp, ".deckflow", "credentials");
      await mkdir(join(temp, ".deckflow"), { recursive: true });
      const previous = JSON.stringify({
        token: "previous",
        tokenApiRoot: base + "/api",
      });
      await writeFile(credentials, previous);
      let callbackUrl = "";
      let callbackTask: Promise<Response> | undefined;
      handler = (_, res, path, body) => {
        const data = JSON.parse(body.toString());
        if (path === "/api/cli/authorizations") {
          callbackUrl = data.redirectUri + "?state=" + data.state;
          if (outcome !== "timeout" && outcome !== "unsafe-link")
            callbackTask = fetch(callbackUrl);
          return json(res, {
            deviceCode: "d".repeat(43),
            userCode: "ABCDEF1234",
            verificationPath:
              outcome === "unsafe-link"
                ? "https://evil.example/authorize"
                : "/cli/authorize?user_code=ABCDEF1234",
            expiresIn: 600,
            interval: 5,
          });
        }
        if (path.endsWith("/exchange")) return json(res, { status: outcome });
        if (path.endsWith("/cancel")) return json(res, { status: "cancelled" });
      };
      const run = await cli(
        ["auth", "login", "--no-browser", "--json", "--wait-timeout", "500ms"],
        { DECKFLOW_TOKEN: "" },
      );
      await callbackTask;
      expect(result(run, outcome === "unsafe-link" ? 2 : 3).code).toBe(
        {
          denied: "AUTH_DENIED",
          timeout: "AUTH_EXPIRED",
          pending: "AUTH_CALLBACK_FAILED",
          "unsafe-link": "INVALID_AUTH_RESPONSE",
        }[outcome],
      );
      expect(requests.filter((r) => r.path.endsWith("/exchange"))).toHaveLength(
        outcome === "timeout" || outcome === "unsafe-link" ? 0 : 1,
      );
      expect(requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(
        1,
      );
      expect(await readFile(credentials, "utf8")).toBe(previous);
      await expect(fetch(callbackUrl)).rejects.toThrow();
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    it(`cancels the remote request and closes its listener on ${signal}`, async () => {
      let callbackUrl = "";
      handler = (_, res, path, body) => {
        if (path.endsWith("/cancel")) return json(res, { status: "cancelled" });
        const data = JSON.parse(body.toString());
        callbackUrl = data.redirectUri + "?state=" + data.state;
        return json(res, {
          deviceCode: "d".repeat(43),
          userCode: "ABCDEF1234",
          verificationPath: "/cli/authorize?user_code=ABCDEF1234",
          expiresIn: 600,
          interval: 5,
        });
      };
      const run = await cli(
        ["auth", "login", "--no-browser", "--json"],
        { DECKFLOW_TOKEN: "" },
        temp,
        undefined,
        (child) => {
          child.stderr!.on("data", (chunk) => {
            if (String(chunk).includes("正在等待浏览器授权"))
              child.kill(signal);
          });
        },
      );
      expect(result(run, 2).code).toBe("CANCELLED");
      expect(requests.filter((r) => r.path.endsWith("/exchange"))).toHaveLength(
        0,
      );
      expect(requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(
        1,
      );
      await expect(fetch(callbackUrl)).rejects.toThrow();
    });

  it("retries rate limited redemption after Retry-After without polling pending authorization", async () => {
    let exchanges = 0;
    let firstAttempt = 0;
    let callbackTask: Promise<Response> | undefined;
    handler = (_, res, path, body) => {
      if (path === "/api/cli/authorizations") {
        const data = JSON.parse(body.toString());
        callbackTask = fetch(data.redirectUri + "?state=" + data.state);
        return json(res, {
          deviceCode: "d".repeat(43),
          userCode: "ABCDEF1234",
          verificationPath: "/cli/authorize?user_code=ABCDEF1234",
          expiresIn: 600,
          interval: 5,
        });
      }
      if (path.endsWith("/exchange")) {
        if (++exchanges === 1) {
          firstAttempt = Date.now();
          res.setHeader("Retry-After", "1");
          return json(res, { message: "Limited" }, 429);
        }
        expect(Date.now() - firstAttempt).toBeGreaterThanOrEqual(990);
        return json(res, {
          status: "redeemed",
          mode: "token",
          credential: "cli_new-token",
          userId: "user1",
          expiredAt: "2099-01-01T00:00:00Z",
        });
      }
    };
    const run = await cli(
      ["auth", "login", "--mode", "token", "--no-browser", "--json"],
      { DECKFLOW_TOKEN: "" },
    );
    await callbackTask;
    expect(result(run).authenticated).toBe(true);
    expect(exchanges).toBe(2);
  });

  it("validates mode options before creating an authorization", async () => {
    expect(
      result(
        await cli(["auth", "login", "--mode", "invalid", "--json"], {
          DECKFLOW_TOKEN: "",
        }),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      result(
        await cli(
          ["auth", "login", "--mode", "token", "--token-stdin", "--json"],
          { DECKFLOW_TOKEN: "" },
        ),
        2,
      ).code,
    ).toBe("INVALID_ARGUMENT");
    expect(requests).toHaveLength(0);
  });
});

describe("issue 125 account workflow", () => {
  it("imports, switches and isolates accounts while respecting environment overrides", async () => {
    handler = (req, res, path) => {
      const user = String(req.headers.authorization).replace("Bearer ", "");
      return json(
        res,
        path.includes("/user")
          ? { id: user, name: "Name-" + user }
          : { id: "ws", actor: user },
      );
    };
    const noEnv = { DECKFLOW_TOKEN: "" };
    for (const [flag, token] of [
      ["--with-token", "one"],
      ["--token-stdin", "two"],
    ])
      expect(
        result(await cli(["auth", "login", flag, "--json"], noEnv, temp, token))
          .user.id,
      ).toBe(token);
    expect(result(await cli(["auth", "status", "--json"], noEnv)).user.id).toBe(
      "two",
    );
    expect(
      result(await cli(["auth", "switch", "--user", "one", "--json"], noEnv))
        .account.id,
    ).toBe("one");
    expect(result(await cli(["ws", "info", "--json"], noEnv)).actor).toBe(
      "one",
    );
    const credentials = join(temp, ".deckflow", "credentials"),
      before = await readFile(credentials, "utf8");
    const env = { DECKFLOW_TOKEN: "env-account" };
    expect(result(await cli(["auth", "status", "--json"], env))).toMatchObject({
      source: "environment",
      user: { id: "env-account" },
    });
    expect(
      result(await cli(["auth", "switch", "--user", "two", "--json"], env), 2)
        .code,
    ).toBe("AUTH_ENV_OVERRIDE");
    expect(await readFile(credentials, "utf8")).toBe(before);
    expect(
      result(
        await cli(
          ["auth", "login", "--with-token", "--json"],
          { ...noEnv, DECKFLOW_API_URL: base + "/other" },
          temp,
          "other-account",
        ),
      ).user.id,
    ).toBe("other-account");
    expect(result(await cli(["auth", "status", "--json"], noEnv)).user.id).toBe(
      "one",
    );
    const accounts = await cli(["auth", "accounts", "--json"], noEnv);
    expect(result(accounts)).toHaveLength(2);
    expect(
      result(accounts).every((account: object) => !("token" in account)),
    ).toBe(true);
  });
  it("deprecates mode apikey without creating a key or starting browser authorization", async () => {
    const run = await cli(["auth", "login", "--mode", "apikey", "--json"], {
      DECKFLOW_TOKEN: "",
    });
    expect(result(run, 2).code).toBe("INVALID_ARGUMENT");
    expect(run.stderr).toContain("deprecated");
    expect(requests).toHaveLength(0);
  });
});
it.each([false, true])(
  "issue 125 preserves a legacy credential when adding an account on another instance: %s",
  async (otherInstance) => {
    handler = (req, res, path) => {
      const id = String(req.headers.authorization).replace("Bearer ", "");
      return json(
        res,
        path.includes("/user") ? { id, name: id } : { id: "ws", actor: id },
      );
    };
    await mkdir(join(temp, ".deckflow"), { recursive: true });
    await writeFile(
      join(temp, ".deckflow", "credentials"),
      JSON.stringify({
        apiRoot: base + "/api",
        tokenApiRoot: base + "/api",
        token: "legacy",
        spaceId: "saved",
      }),
    );
    result(
      await cli(
        ["auth", "login", "--with-token", "--json"],
        {
          DECKFLOW_TOKEN: "",
          ...(otherInstance ? { DECKFLOW_API_URL: base + "/other" } : {}),
        },
        temp,
        "new-account",
      ),
    );
    const accounts = result(
      await cli(["auth", "accounts", "--json"], { DECKFLOW_TOKEN: "" }),
    );
    expect(accounts).toHaveLength(otherInstance ? 1 : 2);
    if (otherInstance)
      expect(
        result(await cli(["auth", "status", "--json"], { DECKFLOW_TOKEN: "" }))
          .user.id,
      ).toBe("legacy");
    const old = accounts.find((a: { id: string }) => a.id != "new-account");
    result(
      await cli(["auth", "switch", "--user", old.id, "--json"], {
        DECKFLOW_TOKEN: "",
      }),
    );
    expect(
      result(await cli(["ws", "info", "--json"], { DECKFLOW_TOKEN: "" })).actor,
    ).toBe("legacy");
  },
);
it("issue 125 reports expiry and revokes the active CLI token before clearing it", async () => {
  let revoked = false;
  handler = (req, res, path) => {
    const token = req.headers.authorization;
    if (req.method === "DELETE") {
      revoked = true;
      return json(res, true);
    }
    if (token === "Bearer cli_test" && revoked) return json(res, {}, 401);
    return json(
      res,
      path.includes("/user")
        ? { id: "account", name: "Account" }
        : { expiredAt: "2099-01-01T00:00:00Z" },
    );
  };
  result(
    await cli(
      ["auth", "login", "--with-token", "--json"],
      { DECKFLOW_TOKEN: "" },
      temp,
      "cli_test",
    ),
  );
  expect(
    result(await cli(["auth", "status", "--json"], { DECKFLOW_TOKEN: "" }))
      .expiredAt,
  ).toBe("2099-01-01T00:00:00Z");
  result(
    await cli(["auth", "logout", "--revoke", "--json"], { DECKFLOW_TOKEN: "" }),
  );
  expect(revoked).toBe(true);
  expect(
    result(await cli(["auth", "status", "--json"], { DECKFLOW_TOKEN: "" }), 3)
      .code,
  ).toBe("UNAUTHENTICATED");
  const error = result(
    await cli(["auth", "status", "--json"], { DECKFLOW_TOKEN: "cli_test" }),
    3,
  );
  expect(error.message).toContain("auth login");
});
it("issue 125 never echoes a local opaque credential from backend error diagnostics", async () => {
  const secret = "opaque-private-credential";
  await mkdir(join(temp, ".deckflow"), { recursive: true });
  await writeFile(
    join(temp, ".deckflow", "credentials"),
    JSON.stringify({ token: secret, tokenApiRoot: base + "/api" }),
  );
  handler = (_, res) => json(res, { code: "notLoggedIn", data: [secret] }, 401);
  const run = await cli(["auth", "status", "--json"], { DECKFLOW_TOKEN: "" });
  expect(result(run, 3).code).toBe("UNAUTHENTICATED");
  expect(run.stdout + run.stderr).not.toContain(secret);
});
it("issue 125 refuses a legacy server's shared browser token without saving or exposing it", async () => {
  let callback: Promise<unknown> | undefined;
  handler = (_, res, path, body) => {
    if (path.endsWith("/exchange"))
      return json(res, {
        status: "redeemed",
        mode: "token",
        credential: "user_browser_secret",
        userId: "user",
        expiredAt: "2099-01-01T00:00:00Z",
      });
    const data = JSON.parse(body.toString());
    callback = fetch(data.redirectUri + "?state=" + data.state);
    return json(res, {
      deviceCode: "d".repeat(43),
      userCode: "ABCDEF1234",
      verificationPath: "/cli/authorize?user_code=ABCDEF1234",
      expiresIn: 600,
    });
  };
  const run = await cli(["auth", "login", "--no-browser", "--json"], {
    DECKFLOW_TOKEN: "",
  });
  await callback;
  expect(result(run, 3).code).toBe("UNSUPPORTED_AUTH_SERVER");
  expect(run.stdout + run.stderr).not.toContain("user_browser_secret");
  await expect(
    stat(join(temp, ".deckflow", "credentials")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

describe("issue 31: historical revisions", () => {
  it.each(["id:f1", "/old.txt"])(
    "reads and downloads the selected revision via %s",
    async (selector) => {
      handler = (req, res, path, body) => {
        if (path === "/bytes") return res.end("old");
        if (path.endsWith("/download")) {
          expect(JSON.parse(body.toString()).revisionId).toBe("r0");
          return json(res, {
            downloadId: "audit-old",
            revisionId: "r0",
            url: base + "/bytes",
          });
        }
        if (path.endsWith("/revisions/r0/content"))
          return json(res, {
            revisionId: "r0",
            mediaType: "text/plain",
            bytes: 3,
            sha256: hash("old"),
            url: base + "/bytes",
          });
        if (path.endsWith("/revisions/r0"))
          return json(res, { id: "r0", name: "old.txt" });
        if (path.endsWith("/files/f1"))
          return json(res, { ...sampleFile, name: "old.txt" });
        if (path.includes("/folders")) return json(res, { rows: [], count: 0 });
        if (path.includes("/files"))
          return json(res, {
            rows: [{ ...sampleFile, name: "old.txt" }],
            count: 1,
          });
      };
      const cat = result(
        await cli(["cat", selector, "--revision", "r0", "--json"]),
      );
      expect(cat.revision).toBe("r0");
      expect(cat.text).toBe("old");
      const get = result(
        await cli(["get", selector, "old-local", "--revision", "r0", "--json"]),
      );
      expect(get.revisionId).toBe("r0");
      expect(get.download_id).toBe("audit-old");
      expect(await readFile(join(temp, "old-local"), "utf8")).toBe("old");
    },
  );

  it("binds historical image previews to the selected revision", async () => {
    handler = (_, res, path) => {
      if (path.endsWith("/files/f1")) return json(res, sampleFile);
      if (path.endsWith("/revisions/r0")) return json(res, { id: "r0" });
      if (path.endsWith("/revisions/r0/content"))
        return json(res, { revisionId: "r0", mediaType: "image/png" });
    };
    const data = result(
      await cli(["view", "id:f1", "--revision", "r0", "--json"]),
    );
    expect(data.revision).toBe("r0");
    expect(data.image.retrieval.params.revisionId).toBe("r0");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(
      result(
        await cli(["view", "id:f1", "--revision", "r0", "--url", "--json"]),
        2,
      ).code,
    ).toBe("UNSUPPORTED_OPERATION");
  });

  it("binds paginated document preview artifacts to a historical revision", async () => {
    handler = (_, res, path) => {
      if (path.endsWith("/files/f1")) return json(res, sampleFile);
      if (path.endsWith("/revisions/r0")) return json(res, { id: "r0" });
      if (path.endsWith("/revisions/r0/content"))
        return json(res, { revisionId: "r0", mediaType: "application/pdf" });
      if (path.includes("/conversions")) {
        expect(path).toContain("/revisions/r0/");
        return json(res, {
          items: [
            {
              operationId: "old-preview",
              target: "screenshots",
              status: "succeeded",
              outputs: [
                { ordinal: 0, artifactId: "a", mediaType: "image/webp" },
                { ordinal: 1, artifactId: "b", mediaType: "image/webp" },
              ],
            },
          ],
        });
      }
    };
    const data = result(
      await cli([
        "view",
        "id:f1",
        "--revision",
        "r0",
        "--limit",
        "1",
        "--json",
      ]),
    );
    expect(data.revision).toBe("r0");
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0].retrieval.params.revisionId).toBe("r0");
    expect(data.next_cursor).toBeTruthy();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("rejects mismatched revision content before reading bytes or billing a download", async () => {
    handler = (_, res, path) => {
      if (path.endsWith("/files/f1")) return json(res, sampleFile);
      if (path.endsWith("/revisions/r0")) return json(res, { id: "r0" });
      if (path.endsWith("/revisions/r0/content"))
        return json(res, {
          revisionId: "r1",
          mediaType: "text/plain",
          url: base + "/bytes",
        });
    };
    for (const args of [
      ["cat", "id:f1"],
      ["get", "id:f1", "target"],
      ["view", "id:f1"],
    ]) {
      expect(
        result(await cli([...args, "--revision", "r0", "--json"]), 4).code,
      ).toBe("REVISION_MISMATCH");
    }
    expect(
      requests.some((r) => r.path === "/bytes" || r.path.endsWith("/download")),
    ).toBe(false);
  });

  it.each([403, 404, 410])(
    "reports historical revision errors (%s) without falling back",
    async (status) => {
      handler = (_, res, path) => {
        if (path.endsWith("/files/f1")) return json(res, sampleFile);
        if (path.endsWith("/revisions/r0"))
          return json(res, { code: "REVISION_UNAVAILABLE" }, status);
      };
      for (const args of [
        ["cat", "id:f1"],
        ["get", "id:f1", "target"],
        ["view", "id:f1"],
      ]) {
        const run = await cli([...args, "--revision", "r0", "--json"]);
        expect(run.code).not.toBe(0);
        const error = JSON.parse(run.stdout).error;
        expect(error.details.status).toBe(status);
      }
      expect(
        requests.some(
          (r) => r.path.endsWith("/content") || r.path.endsWith("/download"),
        ),
      ).toBe(false);
    },
  );
});
