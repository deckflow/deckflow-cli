import { t } from "../src/i18n.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const space = process.env.DECKFLOW_SMOKE_SPACE;
if (!space || !process.env.DECKFLOW_API_URL || !process.env.DECKFLOW_TOKEN)
  throw Error(
    t("需要专用 DECKFLOW_SMOKE_SPACE、DECKFLOW_API_URL、DECKFLOW_TOKEN"),
  );
const temp = await mkdtemp(join(tmpdir(), "deckflow-live-")),
  folder = "/deckflow-smoke-" + randomUUID();
let created = false;
function run(args) {
  const raw = execFileSync(
    process.execPath,
    ["dist/cli.js", ...args, "--ws", space, "--json", "--no-input"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: temp,
        USERPROFILE: temp,
        XDG_CONFIG_HOME: temp,
      },
    },
  );
  const response = JSON.parse(raw);
  assert.equal(response.ok, true);
  return response.data;
}
try {
  run(["mkdir", folder]);
  created = true;
  const local = join(temp, "验证.txt"),
    target = folder + "/验证.txt",
    text = "DeckFlow smoke " + randomUUID();
  await writeFile(local, text);
  run(["put", local, target]);
  const first = run(["info", target]);
  run(["get", target, join(temp, "download.txt")]);
  assert.equal(await readFile(join(temp, "download.txt"), "utf8"), text);
  await writeFile(local, text + " revision");
  run(["put", local, target, "--force"]);
  const latest = run(["info", target]);
  assert.equal(latest.id, first.id);
  assert.notEqual(latest.currentRevisionId, first.currentRevisionId);
  run(["version", "restore", target, "--to", first.currentRevisionId, "--yes"]);
  assert.equal(run(["cat", target]).text, text);
  run(["cp", target, folder + "/copy.txt"]);
  run(["mv", folder + "/copy.txt", folder + "/renamed.txt"]);
  assert.equal(run(["ls", folder]).items.length, 2);
  console.log(t("上传下载、覆盖版本、恢复、复制移动验证通过"));
} catch (error) {
  console.error(
    t("冒烟主流程失败："),
    error.stdout?.toString() || error.message,
  );
  if (!created) {
    try {
      created = run(["info", folder]).kind === "directory";
    } catch {
      console.error(
        JSON.stringify({
          cleanup_target: folder,
          workspace_id: space,
          creation_may_have_committed: true,
        }),
      );
    }
  }
  throw error;
} finally {
  try {
    if (created) {
      const deleted = run([
        "rm",
        folder,
        "--permanent",
        "--recursive",
        "--yes",
      ]);
      let done = false;
      for (let i = 0; i < 60; i++) {
        const task = run(["jobs", "status", deleted.job_id]);
        if (task.state === "succeeded") {
          done = true;
          break;
        }
        if (task.state === "failed") throw Error(t("测试资源清理失败"));
        await sleep(1000);
      }
      if (!done)
        throw Error(
          t("清理仍在运行：{0}；使用 deckflow jobs status {1} --ws {2} 查询", [
            folder,
            deleted.job_id,
            space,
          ]),
        );
    }
  } catch (error) {
    console.error(t("清理失败："), error.stdout?.toString() || error.message);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
