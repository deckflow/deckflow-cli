import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../deckbase/src/service/routes-map.ts", import.meta.url),
  "utf8",
);
const routes = Object.fromEntries(
  [
    ...source.matchAll(
      /"([\w.-]+)":\s*\[\s*"\/[^"]*",\s*"([a-z]+)"\s*,?\s*\]/g,
    ),
  ].map(([, method, verb]) => [method, verb]),
);
if (!routes["file.detail"] || !routes["file.remove"])
  throw Error("无法读取 DeckBase SDK 路由元数据");
writeFileSync(
  new URL("../src/sdk-methods.generated.ts", import.meta.url),
  `import type { Method } from "@deckflow/deckbase-sdk";\nexport const methods = ${JSON.stringify(routes, null, 2)} satisfies Record<Method, string>;\n`,
);
