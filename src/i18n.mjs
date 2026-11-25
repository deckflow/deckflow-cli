import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import messages from "./messages.mjs";

export function systemLanguage(
  env = process.env,
  fallback = () => new Intl.DateTimeFormat().resolvedOptions().locale,
) {
  const base = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (base && /^(C|POSIX)([.@]|$)/i.test(base)) return "en";
  const candidates = env.LANGUAGE
    ? env.LANGUAGE.split(":")
    : [base || fallback()];
  for (const value of candidates) {
    if (/^zh([_\-.@]|$)/i.test(value)) return "zh";
    if (/^en([_\-.@]|$)/i.test(value)) return "en";
  }
  return "en";
}
export function savedLanguage() {
  try {
    const data = JSON.parse(
      readFileSync(join(homedir(), ".deckflow", "credentials"), "utf8"),
    );
    return ["en", "zh", "auto"].includes(data.lang) ? data.lang : "auto";
  } catch {
    return "auto";
  }
}
export function resolveLanguage(
  preference,
  env = process.env,
  saved = savedLanguage(),
) {
  const selected = preference || env.DECKFLOW_LANG || saved;
  if (!["en", "zh", "auto"].includes(selected))
    throw new Error("INVALID_LANGUAGE");
  return selected === "auto" ? systemLanguage(env) : selected;
}
let language = systemLanguage();
try {
  language = resolveLanguage();
} catch {
  /* Report invalid preferences through the CLI error envelope. */
}
export function setLanguage(value) {
  language = value;
}
export function getLanguage() {
  return language;
}
export function t(key, values = []) {
  let text = language === "zh" ? key : messages[key];
  if (text === undefined) throw new Error(`Missing translation: ${key}`);
  return text.replace(/\{(\d+)\}/g, (_, index) =>
    String(values[Number(index)]),
  );
}
export function localize(text) {
  if (Object.hasOwn(messages, text))
    return language === "zh" ? text : messages[text];
  if (language === "zh") {
    for (const [zh, en] of Object.entries(messages)) if (en === text) return zh;
    return { "output the version number": "显示版本号" }[text] || text;
  }
  return text;
}
