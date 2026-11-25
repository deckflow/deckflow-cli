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
    const old = result(await cli(["info", "/A", "--json"])).version;
    id = "new";
    expect(result(await cli(["info", "/A", "--json"])).version).not.toBe(old);
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
      if (path === "/api/regions")
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
          {},
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
    const token = result(await cli(["ls", "/", "--json"])).items[0].version;
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
  expect((await cli(["config", "--help"])).stdout).toContain("Usage:");
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
        env: { ...process.env, HOME: temp, USERPROFILE: temp, ...env },
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
    await readFile(resolve("scripts/release.mjs")),
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
