import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const entry = require.resolve("@deckflow/deckbase-sdk");
const source = readFileSync(entry, "utf8");
const declarations = readFileSync(join(dirname(entry), "index.d.ts"), "utf8");
const declared = new Set(
  [...declarations.matchAll(/"([\w.-]+)":\s*\{\s*params:/g)].map((x) => x[1]),
);
const routes = Object.fromEntries(
  [...source.matchAll(/"([\w.-]+)":\s*\[\s*"\/[^"]*",\s*"([a-z]+)"\s*,?\s*\]/g)]
    .filter((x) => declared.has(x[1]))
    .map(([, method, verb]) => [method, verb]),
);
if (!routes["file.detail"] || !routes["search.query"])
  throw Error("SDK 缺少 v0.3 必需接口");
writeFileSync(
  new URL("../src/sdk-methods.generated.ts", import.meta.url),
  `import type { Method } from "@deckflow/deckbase-sdk";\nexport const methods = ${JSON.stringify(routes, null, 2)} satisfies Record<Method,string>;\n`,
);
