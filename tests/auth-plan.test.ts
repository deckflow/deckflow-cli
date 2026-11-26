import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
it("issue 125: environment overrides block login without modifying local credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "deckflow-auth-plan-"));
  try {
    await mkdir(join(home, ".deckflow"));
    const path = join(home, ".deckflow", "credentials"),
      saved = JSON.stringify({
        token: "saved-local",
        tokenApiRoot: "http://127.0.0.1:1/api",
      });
    await writeFile(path, saved);
    for (const options of [[], ["--with-token"], ["--token-stdin"]]) {
      const result = await new Promise<{ code: number | null; output: string }>(
        (done, fail) => {
          const p = spawn(
            process.execPath,
            [resolve("dist/cli.js"), "auth", "login", ...options, "--json"],
            {
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: home,
                DECKFLOW_API_URL: "http://127.0.0.1:1/api",
                DECKFLOW_TOKEN: "override-secret",
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let output = "";
          p.stdout.on("data", (d) => (output += d));
          p.stderr.on("data", (d) => (output += d));
          p.on("error", fail);
          p.on("close", (code) => done({ code, output }));
          p.stdin.on("error", () => {});
          p.stdin.end("import-secret\n");
        },
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.output).error.code).toBe("AUTH_ENV_OVERRIDE");
      expect(result.output).not.toContain("override-secret");
      expect(result.output).not.toContain("import-secret");
      expect(await readFile(path, "utf8")).toBe(saved);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
