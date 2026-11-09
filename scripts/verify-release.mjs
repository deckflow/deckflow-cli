import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const files = readdirSync("package").filter((name) => name.endsWith(".tgz"));
if (files.length !== 1 || !files[0].endsWith(`-${version}.tgz`))
  throw Error("预期一个与 package.json 版本一致的安装包");
const archive = join("package", files[0]);
if (process.argv[2] === "--install") {
  execFileSync(process.execPath, ["scripts/pack-check.mjs", archive], {
    stdio: "inherit",
  });
} else if (process.argv[2] === "--publish") {
  if (process.env.GITHUB_REF !== `refs/tags/v${version}`)
    throw Error("发布 tag 必须与 package.json 版本一致");
  execFileSync(
    "npm",
    ["publish", archive, "--registry=https://npm.pkg.github.com"],
    { stdio: "inherit" },
  );
} else throw Error("需要 --install 或 --publish");
