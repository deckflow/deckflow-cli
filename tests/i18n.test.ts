import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  systemLanguage,
  resolveLanguage,
  setLanguage,
  t,
} from "../src/i18n.mjs";
import { callbackPage } from "../src/auth-page.js";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "deckflow-lang-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  setLanguage("en");
});
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DECKFLOW_LANG: "",
      LANGUAGE: "",
      LC_ALL: "en_US.UTF-8",
      ...env,
    },
  });
}
it("resolves system locales and language preference lists", () => {
  for (const locale of ["zh_CN.UTF-8", "zh-Hans-CN", "ZH_TW@x"])
    expect(systemLanguage({ LANG: locale })).toBe("zh");
  expect(systemLanguage({ LANG: "zh_CN", LC_ALL: "C", LANGUAGE: "zh" })).toBe(
    "en",
  );
  expect(systemLanguage({ LANG: "en_US", LANGUAGE: "fr:zh:en" })).toBe("zh");
  expect(systemLanguage({}, () => "zh-CN")).toBe("zh");
  expect(systemLanguage({ LANG: "fr_FR" })).toBe("en");
  expect(resolveLanguage("en", { DECKFLOW_LANG: "zh" }, "zh")).toBe("en");
  expect(
    resolveLanguage("auto", { DECKFLOW_LANG: "zh", LANG: "en_US" }, "zh"),
  ).toBe("en");
  expect(() => resolveLanguage("fr")).toThrow();
});
it("persists language without authentication, workspace, UUID or losing credentials", () => {
  expect(run(["config", "set", "lang", "zh", "--json"]).status).toBe(0);
  expect(existsSync(join(home, ".deckflow", "auth-uuid"))).toBe(false);
  expect(run(["--help"]).stdout).toContain("用法：");
  expect(run(["--lang=en", "--help"]).stdout).toContain("Usage:");
  expect(run(["--help"], { DECKFLOW_LANG: "en" }).stdout).toContain("Usage:");
  expect(
    run(["config", "set", "lang", "en", "--dry-run", "--json"]).status,
  ).toBe(0);
  expect(
    JSON.parse(readFileSync(join(home, ".deckflow", "credentials"), "utf8"))
      .lang,
  ).toBe("zh");
  expect(run(["config", "set", "lang", "auto", "--json"]).status).toBe(0);
  expect(run(["--help"]).stdout).toContain("Usage:");
});
it("localizes early errors and ignores damaged configuration for help", () => {
  for (const flag of ["--lang", "--lang=fr"]) {
    const result = run([flag, "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("INVALID_ARGUMENT");
  }
  mkdirSync(join(home, ".deckflow"));
  writeFileSync(join(home, ".deckflow", "credentials"), "bad JSON");
  expect(run(["--lang", "zh", "config", "set", "--help"]).stdout).toContain(
    "支持的配置项",
  );
  expect(run(["--lang", "en", "--bad", "--json"]).stdout).toContain(
    "Unknown option",
  );
  expect(run(["--lang", "zh", "--bad", "--json"]).stdout).toContain("未知选项");
});
it("renders both callback languages and interpolates messages", () => {
  setLanguage("en");
  expect(callbackPage()).toContain('<html lang="en">');
  expect(callbackPage()).not.toMatch(/[\p{Script=Han}]/u);
  expect(t("缺少 {0}", ["--name"])).toBe("Missing --name");
  setLanguage("zh");
  expect(callbackPage()).toContain("请返回发起登录的终端");
});
it("covers every public command help in both languages without creating state", () => {
  const commands = [
    "",
    "config",
    "config get",
    "config set",
    "auth",
    "auth login",
    "auth status",
    "auth logout",
    "status",
    "ls",
    "info",
    "cat",
    "mkdir",
    "get",
    "put",
    "new",
    "mv",
    "cp",
    "rm",
    "view",
    "find",
    "grep",
    "seek",
    "ask",
    "search",
    "ws",
    "ops",
    "jobs",
    "version",
    "pptx",
    "docx",
  ];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    for (const lang of ["en", "zh"]) {
      const result = run([
        ...command.split(" ").filter(Boolean),
        "--lang",
        lang,
        "--help",
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(lang === "en" ? "Usage:" : "用法：");
      if (lang === "en") {
        expect(result.stdout).not.toMatch(/[\p{Script=Han}]/u);
        const children =
          result.stdout.split("Commands:\n")[1]?.split("\n") ?? [];
        for (const line of children) {
          const child = /^  ([a-z][a-z-]*)\b/.exec(line)?.[1];
          if (child && child !== "help") {
            const path = [command, child].filter(Boolean).join(" ");
            if (!commands.includes(path)) commands.push(path);
          }
        }
      }
    }
  }
  expect(existsSync(join(home, ".deckflow"))).toBe(false);
}, 30000);

it("keeps language-like option values and -- operands as data", () => {
  const result = run(
    ["new", "/sample.txt", "--content", "--lang=fr", "--dry-run", "--json"],
    { DECKFLOW_API_URL: "invalid" },
  );
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).error.message).not.toContain(
    "Language must be",
  );
  const literal = run(["config", "set", "lang", "--", "--lang=en", "--json"]);
  expect(literal.status).toBe(2);
  expect(literal.stdout).toBe("");
});
