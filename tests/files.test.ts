import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  link: vi.fn(async () => {
    throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" });
  }),
}));
import { Context, type ApiCall } from "../src/core.js";
import { download } from "../src/files.js";
it("issue 58: exclusive copy fallback supports filesystems without hard links", async () => {
  const temp = await mkdtemp(join(tmpdir(), "deckflow-fat-"));
  try {
    const bytes = Buffer.from("fixture");
    const ctx = new Context(
      { ws: "ws" },
      {
        cwd: temp,
        env: {},
        fetch: (async () => new Response(bytes)) as typeof fetch,
      },
    );
    vi.spyOn(ctx, "client").mockResolvedValue((async (method: string) =>
      method === "file.detail"
        ? { id: "f1", name: "source", currentRevisionId: "r1" }
        : {
            url: "https://storage.example/raw",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            revisionId: "r1",
          }) as ApiCall);
    await download(ctx, "f1", { output: "out" });
    expect(await readFile(join(temp, "out"), "utf8")).toBe("fixture");
    vi.mocked(link).mockImplementationOnce(async (_source, target) => {
      await writeFile(target, "concurrent");
      throw Object.assign(new Error("no links"), { code: "ENOTSUP" });
    });
    await expect(download(ctx, "f1", { output: "race" })).rejects.toMatchObject(
      { code: "EEXIST" },
    );
    expect(await readFile(join(temp, "race"), "utf8")).toBe("concurrent");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
