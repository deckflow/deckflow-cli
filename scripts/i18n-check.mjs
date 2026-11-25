import { t } from "../src/i18n.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import messages from "../src/messages.mjs";

for (const [source, translation] of Object.entries(messages)) {
  assert.ok(source.trim() && translation.trim(), t("翻译词条不得为空"));
  assert.deepEqual(
    [...source.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(),
    [...translation.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(),
    t("翻译占位符不一致：{0}", [source]),
  );
}
for (const directory of ["src", "scripts"]) {
  for (const file of readdirSync(directory).filter(
    (file) => /\.(ts|mjs)$/.test(file) && !file.endsWith(".d.mts"),
  )) {
    const source = readFileSync(`${directory}/${file}`, "utf8");
    for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
      const key = JSON.parse(match[1]);
      assert.ok(
        Object.hasOwn(messages, key),
        t("缺少翻译词条：{0}，{1}", [`${directory}/${file}`, key]),
      );
    }
    assert.ok(
      !/(?:throw usage|throw unsupported|\.description)\("[^"\n]*[\u4e00-\u9fff]/u.test(
        source,
      ),
      t("存在未翻译文案：{0}", [`${directory}/${file}`]),
    );
  }
}
