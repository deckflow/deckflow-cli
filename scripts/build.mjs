import "./contracts.mjs";
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/keyring"],
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __VERSION__: JSON.stringify(
      JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile("package.json", "utf8"),
      ).version,
    ),
  },
});
await chmod("dist/cli.js", 0o755);
