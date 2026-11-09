import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
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
      const child = spawn(process.execPath, [binary, ...args], {
        cwd,
        env: {
          ...process.env,
          DECKFLOW_API_URL: base + "/api",
          DECKFLOW_WEB_URL: base + "/web",
          DECKFLOW_SPACE: "ws",
          DECKFLOW_TOKEN: "test-token",
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
  if (code !== 0) expect(run.stdout).toBe("");
  return JSON.parse(code === 0 ? run.stdout : run.stderr);
}

describe("CLI contract", () => {
  it("registers placeholders without SDK requests and exposes file instead of doc", async () => {
    const help = await cli(["--help"]);
    expect(help.stdout).toMatch(/\n  file\s/);
    expect(help.stdout).not.toMatch(/\n  doc\s/);
    for (const command of [
      ["find"],
      ["search"],
      ["ask"],
      ["file", "archive"],
      ["file", "restore"],
      ["revision", "activate"],
      ["action", "run"],
    ]) {
      expect(
        result(
          await cli([...command, "query", "--future-option", "--json"]),
          11,
        ).code,
      ).toBe("FEATURE_NOT_SUPPORTED");
    }
    expect((await cli(["search", "--help"])).code).toBe(0);
    expect(
      result(await cli(["open", "f1", "--page", "4", "--json"]), 11).code,
    ).toBe("FEATURE_NOT_SUPPORTED");
    expect(requests).toEqual([]);
  });
  it("lists supported keys in both config help screens", async () => {
    const get = await cli(["config", "get", "--help"]);
    const set = await cli(["config", "set", "--help"]);
    expect(get.code).toBe(0);
    expect(set.code).toBe(0);
    for (const key of ["apiUrl", "webUrl", "space"]) {
      expect(get.stdout).toMatch(new RegExp(`^  ${key} +\\S`, "m"));
      expect(set.stdout).toContain(`deckflow config set ${key} `);
    }
    expect(requests).toEqual([]);
  });
  it("saves the default space and reads it with config get", async () => {
    handler = (_, res) => json(res, { id: "new" });
    expect(result(await cli(["space", "use", "new", "--json"]))).toEqual({
      space: "new",
      source: "user",
    });
    expect(result(await cli(["config", "get", "space", "--json"]))).toEqual({
      key: "space",
      value: "new",
    });
  });
  it("honors space precedence and applies SDK pagination", async () => {
    await mkdir(join(temp, "child"));
    await mkdir(join(temp, "deckflow"));
    await writeFile(
      join(temp, "deckflow", "config.json"),
      JSON.stringify({ space: "user" }),
    );
    await writeFile(
      join(temp, ".deckflow.json"),
      JSON.stringify({ space: "project" }),
    );
    handler = (_, res, path) => json(res, { id: path.split("/")[3] });
    const args = ["file", "list", "--limit", "4", "--offset", "3", "--json"];
    result(await cli([...args, "--space", "flag"]));
    result(await cli(args));
    result(await cli(args, { DECKFLOW_SPACE: "" }, join(temp, "child")));
    await rm(join(temp, ".deckflow.json"));
    result(await cli(args, { DECKFLOW_SPACE: "" }));
    expect(requests.map((r) => r.path)).toEqual(
      ["flag", "ws", "project", "user"].map(
        (id) => `/api/spaces/${id}/files?_maxResults=4&_startIndex=3`,
      ),
    );
  });
  it("maps authorization and billing failures without echoing credentials", async () => {
    handler = (_, res) =>
      json(
        res,
        { code: "AUTH_INVALID", message: "test-token dbk_secret" },
        401,
      );
    const auth = await cli(["auth", "status", "--json", "--verbose"]);
    expect(auth.code).toBe(3);
    expect(auth.stdout).toBe("");
    expect(auth.stderr).not.toMatch(/test-token|dbk_secret/);
    expect(requests[0].auth).toBe("Bearer test-token");
    expect(requests[0].path).toBe("/api/user?_full=no");
    handler = (_, res) => json(res, { code: "STORAGE_WRITE_RESTRICTED" }, 403);
    expect(result(await cli(["usage", "--json"]), 7).code).toBe(
      "STORAGE_WRITE_RESTRICTED",
    );
  });
  it("preflights destructive calls and uses the read row version exactly once", async () => {
    handler = (req, res, _, data) => {
      if (req.method === "GET") json(res, sampleFile);
      else {
        expect(JSON.parse(data.toString())).toEqual({ expectedRowVersion: 8 });
        json(res, { code: "STALE" }, 409);
      }
    };
    expect(
      result(await cli(["file", "delete", "f1", "--dry-run", "--json"])).dryRun,
    ).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
    expect(
      result(await cli(["file", "delete", "f1", "--no-input", "--json"]), 2)
        .code,
    ).toBe("INVALID_ARGUMENT");
    expect(
      result(await cli(["file", "delete", "f1", "--yes", "--json"]), 6).code,
    ).toBe("STALE");
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });
  it("reads explicit stdin JSON and blocks SDK writes by default", async () => {
    const args = ["api", "file.modify", "--input", "-", "--json"];
    const body = JSON.stringify({
      spaceId: "ws",
      fileId: "f1",
      expectedRowVersion: 8,
      name: "new.pdf",
    });
    expect(result(await cli(args, {}, temp, body), 2).code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      result(await cli([...args, "--dry-run"], {}, temp, body)).writes,
    ).toBe(true);
    expect(requests).toEqual([]);
    handler = (_, res, path, data) => {
      expect(path).toBe("/api/spaces/ws/files/f1");
      expect(JSON.parse(data.toString())).toEqual({
        expectedRowVersion: 8,
        name: "new.pdf",
      });
      json(res, { ...sampleFile, name: "new.pdf" });
    };
    expect(
      result(await cli([...args, "--yes", "--no-input"], {}, temp, body)).name,
    ).toBe("new.pdf");
  });
});

describe("file transfer", () => {
  it("streams empty and Unicode files through signed storage and commits idempotently", async () => {
    await writeFile(join(temp, "空 文件.pdf"), "");
    let committed = false;
    handler = (req, res, path, body) => {
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
      await cli(["file", "upload", "空 文件.pdf", "--json"]),
    );
    expect(uploaded).toMatchObject({
      fileId: "f1",
      revisionId: "r1",
      bytes: 0,
    });
    expect(
      result(await cli(["upload", "--resume", uploaded.operationId, "--json"])),
    ).toMatchObject({ fileId: "f1", revisionId: "r1" });
    expect(
      requests.filter((r) => r.path === "/api/spaces/ws/files"),
    ).toHaveLength(1);
    await writeFile(join(temp, "空 文件.pdf"), "changed");
    expect(
      result(
        await cli(["upload", "--resume", uploaded.operationId, "--json"]),
        6,
      ).code,
    ).toBe("SOURCE_CHANGED");
  });
  it("resumes a failed multipart upload using completed part ETags", async () => {
    const size = 32 * 1024 ** 2;
    await writeFile(join(temp, "big.pptx"), "");
    await truncate(join(temp, "big.pptx"), size);
    const uploaded = new Map<number, string>();
    let failed = false;
    handler = (req, res, path, body) => {
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
    const first = result(await cli(["upload", "big.pptx", "--json"]), 8);
    expect(first.details.operationId).toBeTruthy();
    expect(
      result(
        await cli(["upload", "--resume", first.details.operationId, "--json"]),
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
    const args = ["download", "f1", "--output", "本地 file.pdf", "--json"];
    expect(result(await cli(args)).bytes).toBe(3);
    const target = join(temp, "本地 file.pdf");
    expect(await readFile(target, "utf8")).toBe("pdf");
    expect(result(await cli(args), 6).code).toBe("OUTPUT_EXISTS");
    corrupt = true;
    expect(result(await cli([...args, "--overwrite"]), 9).code).toBe(
      "DOWNLOAD_INTEGRITY_FAILED",
    );
    expect(await readFile(target, "utf8")).toBe("pdf");
    expect(
      requests.filter((r) => r.path === "/api/spaces/ws/files/f1/content"),
    ).toHaveLength(2);
  });
});

it("restores a new revision and creates a new file from an existing conversion artifact", async () => {
  const keys = new Set<string>();
  handler = (req, res, path, data) => {
    if (path.endsWith("/files/f1")) return json(res, sampleFile);
    if (path.endsWith("/revisions/r1")) return json(res, { id: "r1" });
    if (path.endsWith("/restore")) {
      expect(JSON.parse(data.toString())).toMatchObject({
        expectedCurrentRevisionId: "r1",
      });
      return json(res, { id: "r2", restoredFromRevisionId: "r1" }, 201);
    }
    if (path.endsWith("/conversions"))
      return json(res, { operationId: "convert" }, 202);
    if (path.endsWith("/conversions/convert"))
      return json(res, {
        operationId: "convert",
        status: "succeeded",
        outputs: [{ artifactId: "artifact", itemId: "item", format: "pdf" }],
      });
    if (path.endsWith("/files") && req.method === "POST") {
      const body = JSON.parse(data.toString());
      expect(body.source).toEqual({
        type: "artifact",
        sourceFileId: "f1",
        sourceRevisionId: "r1",
        sourceArtifactId: "artifact",
        itemId: "item",
      });
      keys.add(body.idempotencyKey);
      return json(res, { ...sampleFile, id: "new" }, 201);
    }
  };
  expect(
    result(
      await cli([
        "revision",
        "restore",
        "r1",
        "--file",
        "f1",
        "--yes",
        "--json",
      ]),
    ).id,
  ).toBe("r2");
  const conversion = result(
    await cli(["file", "convert", "f1", "--to", "pdf", "--yes", "--json"]),
  );
  expect(conversion.fileId).toBe("new");
  expect(
    result(
      await cli([
        "file",
        "convert",
        "--resume",
        conversion.operationId,
        "--yes",
        "--json",
      ]),
    ).fileId,
  ).toBe("new");
  expect(requests.filter((r) => r.path.endsWith("/conversions"))).toHaveLength(
    1,
  );
  expect(keys.size).toBe(1);
  expect(
    requests.filter((r) => r.method === "POST" && r.path.endsWith("/files")),
  ).toHaveLength(1);
});

it("reports share partial success, then disables the page with its current row version", async () => {
  handler = (req, res, path, data) => {
    if (/\/files\/f[12]$/.test(path)) return json(res, sampleFile);
    if (path.endsWith("/share-pages"))
      return json(res, { id: "sp", slug: "slug", rowVersion: 0 }, 201);
    if (path.endsWith("/share-pages/sp/items")) {
      const body = JSON.parse(data.toString());
      if (body.fileId === "f1") {
        expect(body.rowVersion).toBe(0);
        return json(res, { item: { id: "item" }, rowVersion: 1 }, 201);
      }
      expect(body.rowVersion).toBe(1);
      return json(res, { code: "CONFLICT" }, 409);
    }
    if (path.endsWith("/share-pages/sp") && req.method === "GET")
      return json(res, {
        page: { slug: "slug", rowVersion: 1 },
        items: [],
        gates: [],
      });
    if (path.endsWith("/share-pages/sp") && req.method === "PUT") {
      expect(JSON.parse(data.toString())).toEqual({
        rowVersion: 1,
        status: "disabled",
      });
      return json(res, { status: "disabled" });
    }
  };
  const share = result(
    await cli([
      "share",
      "create",
      "--title",
      "Share",
      "--files",
      "f1,f2",
      "--yes",
      "--json",
    ]),
    10,
  );
  expect(share.details).toMatchObject({
    id: "sp",
    results: [{ ok: true }, { ok: false }],
  });
  expect(result(await cli(["share", "open", "sp", "--url", "--json"]))).toEqual(
    { url: base + "/web/share/slug", opened: false },
  );
  expect(
    result(await cli(["share", "revoke", "sp", "--yes", "--json"])).status,
  ).toBe("disabled");
});

it("previews a directory without writes, preserves subfolders and reports upload partial success", async () => {
  await mkdir(join(temp, "source", "child"), { recursive: true });
  await writeFile(join(temp, "source", "a.txt"), "a");
  await writeFile(join(temp, "source", "child", "b.txt"), "b");
  const options = [
    "upload",
    "source",
    "--recursive",
    "--folder",
    "/Reports",
    "--create-folders",
    "--json",
  ];
  const preview = result(await cli([...options, "--dry-run"]));
  expect(preview).toMatchObject({
    dryRun: true,
    costStatus: "unknown",
    relativeFolders: ["child"],
  });
  expect(requests.every((r) => r.method === "GET")).toBe(true);
  const folders: { id: string; parentId: string | null; name: string }[] = [];
  handler = (req, res, path, data) => {
    if (path === "/api/spaces/ws") return json(res, { regionId: "region" });
    if (path === "/api/regions")
      return json(res, {
        rows: [{ id: "region", capabilities: {} }],
        count: 1,
      });
    if (path.includes("/folders?")) {
      const parent = new URL(base + path).searchParams.get("parentId");
      const rows = folders.filter((f) => f.parentId === parent);
      return json(res, { rows, count: rows.length });
    }
    if (path.endsWith("/folders") && req.method === "POST") {
      const folder = {
        ...JSON.parse(data.toString()),
        id: "folder" + folders.length,
      };
      folders.push(folder);
      return json(res, folder, 201);
    }
    if (path.endsWith("/upload-sessions")) {
      const body = JSON.parse(data.toString());
      if (body.name === "b.txt")
        return json(res, { code: "STORAGE_WRITE_RESTRICTED" }, 403);
      return json(res, {
        id: "up",
        status: "pending",
        upload: { url: base + "/signed", method: "PUT", headers: {} },
      });
    }
    if (path === "/signed") return res.writeHead(200).end();
    if (path.endsWith("/complete"))
      return json(res, { id: "up", status: "verified" });
    if (path.endsWith("/files")) {
      expect(JSON.parse(data.toString()).folderId).toBe("folder0");
      return json(res, sampleFile, 201);
    }
  };
  const partial = result(await cli([...options, "--yes"]), 10);
  expect(partial.details.results).toMatchObject([
    { ok: true },
    { ok: false, exitCode: 7 },
  ]);
  expect(folders).toMatchObject([
    { name: "Reports", parentId: null },
    { name: "child", parentId: "folder0" },
  ]);
});

it("reports an expired session with its ID without creating a new session", async () => {
  await writeFile(join(temp, "file.txt"), "text");
  handler = (_, res, path) => {
    if (path === "/api/spaces/ws") return json(res, { regionId: "region" });
    if (path === "/api/regions") return json(res, { rows: [], count: 0 });
    if (
      path.endsWith("/upload-sessions") ||
      path.endsWith("/upload-sessions/expired")
    )
      return json(res, { id: "expired", status: "expired" });
  };
  const first = result(await cli(["upload", "file.txt", "--json"]), 6);
  expect(first.details.uploadSessionId).toBe("expired");
  expect(
    result(
      await cli(["upload", "--resume", first.details.operationId, "--json"]),
      6,
    ).code,
  ).toBe("TASK_FAILED");
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

it("uses the album configuration schema and the album pagination dialect", async () => {
  handler = (req, res, path, data) => {
    if (path.endsWith("/folders/folder")) return json(res, { id: "folder" });
    if (path.endsWith("/albums") && req.method === "POST") {
      const body = JSON.parse(data.toString());
      expect(body.config).toMatchObject({
        title: "Weekly",
        folderId: "folder",
        publicEnabled: false,
        paymentEnabled: false,
        downloadPolicy: "disabled",
      });
      return json(res, { id: "album", folderId: "folder" }, 201);
    }
    if (path.endsWith("/albums/album") && req.method === "GET")
      return json(res, { id: "album", title: "Weekly", rowVersion: 7 });
    if (path.endsWith("/albums/album") && req.method === "PUT") {
      expect(JSON.parse(data.toString())).toMatchObject({
        rowVersion: 7,
        config: { title: "New" },
      });
      return json(res, { id: "album", title: "New" });
    }
    if (path === "/api/spaces/ws/albums/album/subscriptions?limit=3&offset=2")
      return json(res, { rows: [] });
  };
  expect(
    result(
      await cli([
        "album",
        "create",
        "--name",
        "Weekly",
        "--folder",
        "folder",
        "--yes",
        "--json",
      ]),
    ).id,
  ).toBe("album");
  expect(
    result(
      await cli(
        ["album", "update", "album", "--input", "-", "--yes", "--json"],
        {},
        temp,
        '{"title":"New"}',
      ),
    ).title,
  ).toBe("New");
  expect(
    result(
      await cli([
        "album",
        "subscribers",
        "album",
        "--limit",
        "3",
        "--offset",
        "2",
        "--json",
      ]),
    ).rows,
  ).toEqual([]);
});
