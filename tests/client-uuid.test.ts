import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const uuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let home: string;
let api: string;
let identifiers: string[];
let storageIdentifiers: (string | undefined)[];
let storageCredentials: (string | undefined)[];
let downloadRevisions: unknown[];
let server: ReturnType<typeof createServer>;
const bytes = Buffer.from("download fixture");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deckflow-client-uuid-"));
  identifiers = [];
  storageIdentifiers = [];
  storageCredentials = [];
  downloadRevisions = [];
  server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const send = (body: unknown, status = 200) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (req.url === "/raw") {
      storageIdentifiers.push(req.headers["x-auth-uuid"] as string | undefined);
      storageCredentials.push(req.headers.authorization);
      res.end(bytes);
      return;
    }
    const identifier = req.headers["x-auth-uuid"] as string | undefined;
    if (!identifier || !uuidV4.test(identifier)) {
      send(
        { code: "CLIENT_UUID_REQUIRED", message: "CLIENT_UUID_REQUIRED" },
        400,
      );
      return;
    }
    identifiers.push(identifier);
    if (req.url?.endsWith("/download")) {
      const request = JSON.parse(Buffer.concat(parts).toString());
      downloadRevisions.push(request.revisionId);
      send({
        downloadId: "audit",
        revisionId: "r1",
        url: api.replace(/\/api$/, "/raw"),
      });
    } else if (req.url?.endsWith("/content")) {
      send({
        revisionId: "r1",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else {
      send({
        id: "f1",
        name: "fixture.txt",
        currentRevisionId: "r1",
        rowVersion: 1,
        folderId: null,
      });
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing listener");
  api = `http://127.0.0.1:${address.port}/api`;
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(home, { recursive: true, force: true });
});
function run(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(
        process.env.DECKFLOW_TEST_NODE || process.execPath,
        [resolve("dist/cli.js"), ...args, "--json"],
        {
          cwd: home,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: home,
            DECKFLOW_API_URL: api,
            DECKFLOW_TOKEN: "synthetic",
            DECKFLOW_WORKSPACE: "ws",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (part) => (stdout += part));
      child.stderr.on("data", (part) => (stderr += part));
      child.on("error", fail);
      child.on("close", (code) => done({ code, stdout, stderr }));
    },
  );
}
it("issue 5: downloads forward the persisted UUID and keep it stable across commands", async () => {
  for (const flags of [[], ["--force"]]) {
    const result = await run(["get", "id:f1", "output", ...flags]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.download_id).toBe("audit");
  }
  const stored = (
    await readFile(join(home, ".deckflow", "auth-uuid"), "utf8")
  ).trim();
  expect(stored).toMatch(uuidV4);
  expect(new Set(identifiers)).toEqual(new Set([stored]));
  expect(storageIdentifiers).toEqual([undefined, undefined]);
  expect(storageCredentials).toEqual([undefined, undefined]);
  expect(downloadRevisions).toEqual(["r1", "r1"]);
  expect(await readFile(join(home, "output"))).toEqual(bytes);
});
it("issue 5: concurrent first commands share one persisted UUID", async () => {
  const results = await Promise.all([run(["ws", "info"]), run(["ws", "info"])]);
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  const stored = (
    await readFile(join(home, ".deckflow", "auth-uuid"), "utf8")
  ).trim();
  expect(new Set(identifiers)).toEqual(new Set([stored]));
});
it("issue 5: read-only dry-run sends a valid UUID without creating local state", async () => {
  const result = await run(["ws", "info", "--dry-run"]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(identifiers[0]).toMatch(uuidV4);
  await expect(
    stat(join(home, ".deckflow", "auth-uuid")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("issue 5: malformed persisted UUIDs fail locally instead of sending invalid identity", async () => {
  await run(["ws", "info"]);
  await writeFile(join(home, ".deckflow", "auth-uuid"), "invalid\n");
  identifiers = [];
  const result = await run(["ws", "info"]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error.code).toBe("INVALID_CLIENT_UUID");
  expect(identifiers).toEqual([]);
});
