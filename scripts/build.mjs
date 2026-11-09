import "./contracts.mjs";
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
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
