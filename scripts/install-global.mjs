import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const options = { cwd, stdio: "inherit" };
const pnpm = process.env.npm_execpath;
const runPnpm = (args) =>
  pnpm
    ? execFileSync(process.execPath, [pnpm, ...args], options)
    : execFileSync("pnpm", args, options);

runPnpm(["build"]);
const temp = mkdtempSync(join(tmpdir(), "deckflow-install-global-"));
try {
  runPnpm(["pack", "--pack-destination", temp]);
  const files = readdirSync(temp).filter((file) => file.endsWith(".tgz"));
  if (files.length !== 1) throw Error("预期生成一个发布安装包");
  const args = ["install", "--global", join(temp, files[0])];
  if (process.platform === "win32") {
    const npmCli = join(
      dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
    execFileSync(process.execPath, [npmCli, ...args], options);
  } else execFileSync("npm", args, options);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
