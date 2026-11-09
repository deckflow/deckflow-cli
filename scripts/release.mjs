import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    github: { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});
const cwd = fileURLToPath(new URL("../", import.meta.url));
const { name } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
const scope = name.split("/")[0];
const registry = values.github
  ? "https://npm.pkg.github.com"
  : "https://registry.npmjs.org";
const options = { cwd, stdio: "inherit" };
const pnpm = process.env.npm_execpath;
const npmCli = join(
  dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
const runPnpm = (args) =>
  pnpm
    ? execFileSync(process.execPath, [pnpm, ...args], options)
    : execFileSync("pnpm", args, options);

runPnpm(["build"]);
const temp = mkdtempSync(join(tmpdir(), "deckflow-release-"));
try {
  runPnpm(["pack", "--pack-destination", temp]);
  const files = readdirSync(temp).filter((file) => file.endsWith(".tgz"));
  if (files.length !== 1) throw Error("预期生成一个发布安装包");
  const args = [
    "publish",
    join(temp, files[0]),
    `--registry=${registry}`,
    `--${scope}:registry=${registry}`,
  ];
  if (!values.github) args.push("--access=public");
  if (values["dry-run"]) args.push("--dry-run");
  if (process.platform === "win32")
    execFileSync(process.execPath, [npmCli, ...args], options);
  else execFileSync("npm", args, options);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
