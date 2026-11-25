import { t } from "../src/i18n.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import assert from "node:assert/strict";

const temp = await mkdtemp(join(tmpdir(), "deckflow-pack-"));
const pnpm = process.env.npm_execpath;
const expectedVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
function npmCommand(command, args, cwd = temp) {
  // npm and pnpm provide JS entry points when run as package scripts.
  if (command === "pnpm" && pnpm) {
    execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: "inherit" });
  } else if (process.platform === "win32" && command === "npm") {
    const npmCli = join(
      dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      stdio: "inherit",
    });
  } else execFileSync(command, args, { cwd, stdio: "inherit" });
}
async function run(args, env = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(
      process.execPath,
      [
        process.platform === "win32"
          ? join(temp, "node_modules/@deckflow/deckflow-cli/dist/cli.js")
          : join(temp, "node_modules/.bin/deckflow"),
        ...args,
      ],
      {
        cwd: temp,
        env: { ...process.env, HOME: temp, USERPROFILE: temp, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok(stdout) : fail(Error(`exit ${code}: ${stderr}`)),
    );
  });
}
const server = createServer((req, res) => {
  if (
    req.url !== "/api/spaces/space" ||
    req.headers.authorization !== "Bearer pack-check"
  ) {
    res.writeHead(400).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "example", name: "packed.pdf" }));
});
try {
  let archive = process.argv[2] && resolve(process.argv[2]);
  if (!archive) {
    npmCommand("pnpm", ["pack", "--pack-destination", temp], process.cwd());
    archive = join(
      temp,
      (await readdir(temp)).find((name) => name.endsWith(".tgz")),
    );
  }
  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "bin:check": "./node_modules/.bin/deckflow --version" },
    }),
  );
  await writeFile(
    join(temp, ".npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  npmCommand("npm", [
    "install",
    "--engine-strict",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ]);
  const installed = join(temp, "node_modules/@deckflow/deckflow-cli");
  const metadata = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(
    metadata.version,
    expectedVersion,
    t("安装包版本必须与发布目标一致"),
  );
  assert.equal(
    metadata.bin?.deckflow,
    "dist/cli.js",
    t("安装包必须声明 deckflow 命令入口"),
  );
  const localBin = join(temp, "node_modules/.bin/deckflow");
  if (process.platform === "win32") {
    assert.ok(
      (await lstat(localBin + ".cmd")).isFile(),
      t("本地命令启动文件必须存在"),
    );
    const shim = (await readFile(localBin + ".cmd", "utf8")).replaceAll(
      "\\",
      "/",
    );
    assert.ok(
      shim.includes("@deckflow/deckflow-cli/dist/cli.js"),
      t("命令启动文件必须指向待验证安装包"),
    );
  } else {
    assert.ok(
      (await lstat(localBin)).isSymbolicLink(),
      t("本地命令链接必须存在"),
    );
    assert.equal(
      await realpath(localBin),
      await realpath(join(installed, metadata.bin.deckflow)),
      t("命令链接必须指向待验证安装包"),
    );
  }
  const readme = await readFile(join(installed, "README.md"), "utf8");
  assert.ok(
    readme.includes(
      `npm install -g ${metadata.name} --registry=https://registry.npmjs.org`,
    ),
    t("README 必须优先使用公共 npm 安装渠道"),
  );
  for (const match of readme.matchAll(/deckflow-deckflow-cli-([^\s`]+)\.tgz/g))
    assert.equal(
      match[1],
      metadata.version,
      t("README 安装包版本必须与软件包一致"),
    );
  npmCommand("npm", ["run", "bin:check"]);
  assert.match(await run(["--lang", "en", "--help"]), /Usage: deckflow/);
  assert.match(await run(["--lang", "zh", "--help"]), /用法： deckflow/);
  for (const name of [
    "README.en.md",
    "docs/commands.en.md",
    "docs/auth-and-workspaces.en.md",
    "docs/automation.en.md",
    "docs/migration-v03.en.md",
  ])
    assert.ok((await readFile(join(installed, name), "utf8")).length > 0);
  await run(["config", "set", "lang", "zh", "--json"]);
  assert.match(await run(["--help"], { DECKFLOW_LANG: "" }), /用法：/);
  await run(["config", "set", "lang", "auto", "--json"]);
  assert.equal(
    (await run(["--version"])).trim(),
    expectedVersion,
    t("CLI 版本必须与发布目标一致"),
  );
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const result = await run(["ws", "info", "space", "--json"], {
    DECKFLOW_TOKEN: "pack-check",
    DECKFLOW_API_URL: `http://127.0.0.1:${server.address().port}/api`,
  });
  assert.deepEqual(JSON.parse(result).data, {
    id: "example",
    name: "packed.pdf",
  });
  console.log(t("安装命令、帮助、版本与 SDK 请求验证通过。"));
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true });
}
