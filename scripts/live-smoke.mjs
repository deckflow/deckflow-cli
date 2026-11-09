import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const workspace = process.env.DECKFLOW_SMOKE_WORKSPACE;
if (
  !workspace ||
  !process.env.DECKFLOW_API_URL ||
  !process.env.DECKFLOW_TOKEN
) {
  throw Error(
    "需要 DECKFLOW_SMOKE_WORKSPACE（专用测试空间）、DECKFLOW_API_URL 和 DECKFLOW_TOKEN",
  );
}
const temp = await mkdtemp(join(tmpdir(), "deckflow-live-"));
const name = "deckflow-smoke-" + randomUUID();
const workspaceFlags = ["--workspace", workspace, "--json", "--no-input"];
const cleanup = [];
function run(args, input) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        ["dist/cli.js", ...args, ...workspaceFlags],
        {
          input,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    throw Error(
      `${args.slice(0, 2).join(" ")} failed: ${error.stderr ?? error.message}`,
    );
  }
}
async function deleteFolder(id) {
  const job = run(["folder", "delete", id, "--recursive", "--yes"]);
  for (let tries = 0; tries < 30; tries++) {
    const latest = run(["file", "deletion", "get", job.id]);
    if (latest.status === "completed") return;
    if (latest.status === "failed") throw Error(`清理任务失败：${job.id}`);
    await sleep(1000);
  }
  throw Error(`清理任务仍在处理：${job.id}`);
}
try {
  const local = join(temp, "DeckFlow 验证.txt");
  const original = "DeckFlow live smoke " + name;
  await writeFile(local, original);
  const folder = run(["folder", "create", name]);
  cleanup.unshift(() => deleteFolder(folder.id));
  const created = run(["upload", local, "--folder", folder.id]);
  const file = run(["file", "get", created.fileId]);
  assert.equal(file.folderId, folder.id);
  const target = join(temp, "download.txt");
  run(["download", created.fileId, "--output", target]);
  assert.equal(await readFile(target, "utf8"), original);
  await writeFile(local, original + " revision");
  const newRevision = run(["revision", "upload", created.fileId, local]);
  assert.notEqual(newRevision.revisionId, created.revisionId);
  const restored = run([
    "revision",
    "restore",
    created.revisionId,
    "--file",
    created.fileId,
    "--yes",
  ]);
  assert.notEqual(restored.id, created.revisionId);
  assert.equal(
    run(["file", "get", created.fileId]).currentRevisionId,
    restored.id,
  );
  const share = run(["share", "create", "--title", name, "--yes"]);
  cleanup.unshift(() => {
    const { page } = run(["share", "get", share.id]);
    run(
      ["api", "sharePage.remove", "--input", "-", "--yes"],
      JSON.stringify({
        spaceId: workspace,
        id: share.id,
        rowVersion: page.rowVersion,
      }),
    );
  });
  const { page } = run(["share", "get", share.id]);
  run(
    ["api", "sharePage.addItem", "--input", "-", "--yes"],
    JSON.stringify({
      spaceId: workspace,
      id: share.id,
      rowVersion: page.rowVersion,
      type: "document",
      fileId: created.fileId,
    }),
  );
  assert.equal(run(["share", "get", share.id]).items[0].fileId, created.fileId);
  assert.equal(run(["share", "revoke", share.id, "--yes"]).status, "disabled");
  const album = run([
    "album",
    "create",
    "--name",
    name,
    "--folder",
    folder.id,
    "--yes",
  ]);
  cleanup.unshift(() => run(["album", "delete", album.id, "--yes"]));
  assert.equal(run(["album", "get", album.id]).folderId, folder.id);
  console.log(
    "DeckBase live upload, download, revision restore, share and album passed.",
  );
} finally {
  for (const remove of cleanup) {
    try {
      await remove();
    } catch (error) {
      process.exitCode = 1;
      console.error(error.message);
    }
  }
  await rm(temp, { recursive: true, force: true });
}
