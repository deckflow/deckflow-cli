import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
let home: string;
const api = "http://127.0.0.1:1/api";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "deckflow-switch-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function run(selector: string, dryRun = true) {
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "auth",
      "switch",
      "--user",
      selector,
      ...(dryRun ? ["--dry-run"] : []),
      "--json",
      "--no-input",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DECKFLOW_TOKEN: "",
        DECKFLOW_API_URL: api,
        DECKFLOW_LANG: "en",
      },
    },
  );
  return { ...result, output: JSON.parse(result.stdout) };
}
function saveAccounts() {
  mkdirSync(join(home, ".deckflow"));
  const data = {
    apiRoot: api,
    accounts: {
      [api]: {
        one: { id: "one", name: "First", token: "cli_one" },
        two: { id: "two", name: "Shared", token: "cli_two" },
        three: { id: "three", name: "Shared", token: "cli_three" },
      },
    },
    activeAccounts: { [api]: "one" },
  };
  const path = join(home, ".deckflow", "credentials");
  writeFileSync(path, JSON.stringify(data));
  return path;
}
it("issue 127 rejects a missing account in an empty-store preview without writing state", () => {
  const preview = run("missing");
  expect(preview.status).toBe(2);
  expect(preview.output.error.code).toBe("INVALID_ARGUMENT");
  expect(existsSync(join(home, ".deckflow"))).toBe(false);
  expect(run("missing", false).output.error.code).toBe(
    preview.output.error.code,
  );
});
it.each(["missing", "Shared"])(
  "issue 127 rejects invalid or ambiguous selectors in both paths: %s",
  (selector) => {
    const path = saveAccounts(),
      before = readFileSync(path, "utf8");
    for (const dry of [true, false]) {
      const result = run(selector, dry);
      expect(result.status).toBe(2);
      expect(result.output.error.code).toBe("INVALID_ARGUMENT");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  },
);
it.each(["two", "First"])(
  "issue 127 resolves valid previews without changing the active credential: %s",
  (selector) => {
    const path = saveAccounts(),
      before = readFileSync(path, "utf8");
    const preview = run(selector);
    expect(preview.status).toBe(0);
    const id = selector === "First" ? "one" : "two";
    expect(preview.output.data).toEqual({ dryRun: true, account_id: id });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(home, ".deckflow", "auth-uuid"))).toBe(false);
    const actual = run(selector, false);
    expect(actual.status).toBe(0);
    expect(actual.output.data.account.id).toBe(id);
  },
);
