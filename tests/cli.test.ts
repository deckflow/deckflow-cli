import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
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
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(node, [binary, ...args], {
        cwd,
        env: {
          ...process.env,
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
  it("lists mixed objects with bound continuation cursors", async () => {
    handler = (_, res, path) => {
      if (path.includes("/folders"))
        return json(res, {
          rows: [{ id: "d1", name: "A", parentId: null, rowVersion: 1 }],
          count: 1,
        });
      if (path.includes("/files"))
        return json(res, { rows: [sampleFile], count: 1 });
    };
    const first = result(
      await cli(["--ws", "selected", "ls", "/", "--limit", "1", "--json"]),
    );
    expect(first.items[0].kind).toBe("directory");
    expect(first.items[0].path).toBe("/A");
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
      if (path === "/api/regions")
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
      if (path === "/api/regions")
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
    expect(result(await cli(args), 4).code).toBe("OBJECT_EXISTS");
    corrupt = true;
    expect(result(await cli([...args, "--force"]), 5).code).toBe(
      "DOWNLOAD_INTEGRITY_FAILED",
    );
    expect(await readFile(target, "utf8")).toBe("pdf");
    expect(
      requests.filter((r) => r.path === "/api/spaces/ws/files/f1/content"),
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
        return json(res, { rows: [sampleFile], count: 1 });
    };
    const task = result(
      await cli(["ops", "convert", "/示例 file.pdf", "--to", "pdf", "--json"]),
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
        return json(res, { rows: [sampleFile], count: 1 });
    };
    const done = result(
      await cli([
        "ops",
        "convert",
        "/示例 file.pdf",
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
