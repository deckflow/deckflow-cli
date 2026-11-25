import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const { execFileSync, parseArgs } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  parseArgs: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal()),
  parseArgs,
}));

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tag = `v${version}`;
const release = () => import("../scripts/release.mjs");
let archiveDirectory;
let failPublish;

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  parseArgs.mockReturnValue({ values: {}, positionals: [] });
  archiveDirectory = undefined;
  failPublish = false;
  execFileSync.mockImplementation((command, args) => {
    if (args.includes("--pack-destination")) {
      archiveDirectory = args[args.indexOf("--pack-destination") + 1];
      writeFileSync(join(archiveDirectory, "release.tgz"), "fixture");
    }
    if (args.includes("publish") && failPublish) throw Error("publish failed");
    return "";
  });
});

it("creates the version tag only after successful npm publication", async () => {
  await release();
  const calls = execFileSync.mock.calls;
  const publishIndex = calls.findIndex(([, args]) => args.includes("publish"));
  const tagIndex = calls.findIndex(
    ([command, args]) => command === "git" && args.length === 2,
  );
  expect(publishIndex).toBeGreaterThanOrEqual(0);
  expect(tagIndex).toBeGreaterThan(publishIndex);
  expect(calls[tagIndex][1]).toEqual(["tag", tag]);
  expect(archiveDirectory).toBeDefined();
  expect(existsSync(archiveDirectory)).toBe(false);
});

it.each([
  { github: true },
  { "dry-run": true },
  { github: true, "dry-run": true },
])("skips all tag operations with %j", async (values) => {
  parseArgs.mockReturnValue({ values, positionals: [] });
  await release();
  expect(execFileSync.mock.calls.some(([command]) => command === "git")).toBe(
    false,
  );
  const publish = execFileSync.mock.calls.find(([, args]) =>
    args.includes("publish"),
  );
  expect(publish).toBeDefined();
  expect(publish[1]).toContain(
    `--registry=${values.github ? "https://npm.pkg.github.com" : "https://registry.npmjs.org"}`,
  );
  expect(publish[1].includes("--dry-run")).toBe(!!values["dry-run"]);
});

it("refuses an existing version tag before publishing", async () => {
  execFileSync.mockImplementation((command) =>
    command === "git" ? `${tag}\n` : "",
  );
  await expect(release()).rejects.toThrow(tag);
  expect(
    execFileSync.mock.calls.some(([, args]) => args.includes("publish")),
  ).toBe(false);
});

it("does not create a tag when publication fails and cleans the archive", async () => {
  failPublish = true;
  await expect(release()).rejects.toThrow("publish failed");
  expect(
    execFileSync.mock.calls.some(
      ([command, args]) => command === "git" && args.length === 2,
    ),
  ).toBe(false);
  expect(archiveDirectory).toBeDefined();
  expect(existsSync(archiveDirectory)).toBe(false);
});
