import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import assert from "node:assert/strict";

const temp = await mkdtemp(join(tmpdir(), "deckflow-pack-"));
const pnpm = process.env.npm_execpath;
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
      [join(temp, "node_modules/@deckflow/deckflow-cli/dist/cli.js"), ...args],
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
    req.url !== "/api/spaces/space/files/example" ||
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
      scripts: { "bin:check": "deckflow --version" },
    }),
  );
  await writeFile(
    join(temp, ".npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  npmCommand("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ]);
  npmCommand("npm", ["run", "bin:check"]);
  assert.match(await run(["--help"]), /Usage: deckflow/);
  assert.match(await run(["--version"]), /^\d+\.\d+\.\d+/);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const result = await run(
    ["file", "get", "example", "--json", "--space", "space"],
    {
      DECKFLOW_TOKEN: "pack-check",
      DECKFLOW_API_URL: `http://127.0.0.1:${server.address().port}/api`,
    },
  );
  assert.deepEqual(JSON.parse(result), { id: "example", name: "packed.pdf" });
  console.log("Installed bin, help, version and SDK request passed.");
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true });
}
