import {
  createClient,
  type Method,
  type Params,
  type Result,
} from "@deckflow/deckbase-sdk";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { methods } from "./sdk-methods.generated.js";

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit = 2,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const usage = (message: string) =>
  new CliError("INVALID_ARGUMENT", message);
export const unsupported = (feature: string) =>
  new CliError("FEATURE_NOT_SUPPORTED", `${feature}：后续支持`, 11);
export type Globals = {
  workspace?: string;
  json?: boolean;
  noInput?: boolean;
  input?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  timeout?: string;
  waitTimeout?: string;
  verbose?: boolean;
};
export type Config = { apiUrl?: string; webUrl?: string; workspace?: string };
const configKeys = ["apiUrl", "webUrl", "workspace"] as const;
export function configKey(key: string): keyof Config {
  if (!configKeys.includes(key as keyof Config))
    throw usage("配置项必须是 apiUrl、webUrl 或 workspace");
  return key as keyof Config;
}
export function endpoint(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage(`${label} 必须是完整 URL`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw usage(`${label} 必须是无凭据、查询和片段的 HTTP(S) URL`);
  return url.href.replace(/\/$/, "");
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw usage("无法读取 JSON 配置或操作状态");
  }
}
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function inputJson(
  source?: string,
): Promise<Record<string, unknown>> {
  if (!source) return {};
  try {
    const value: unknown = JSON.parse(
      await (source === "-" ? stdinText() : readFile(source, "utf8")),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw usage("--input 需要一个 JSON 对象");
  }
}
export async function stdinText() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 1024 * 1024) throw usage("输入超过 1 MiB");
  }
  return value;
}
export async function hiddenToken(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw usage("请使用 --token-stdin 或 DECKFLOW_TOKEN");
  const previous = input.isRaw;
  process.stderr.write("DeckBase API Key / Token: ");
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((done, fail) => {
      let value = "";
      function finish(error?: Error) {
        input.off("data", onData);
        if (error) fail(error);
        else done(value);
      }
      function onData(chunk: Buffer | string) {
        for (const char of chunk.toString()) {
          if (char === "\u0003" || char === "\u0004")
            return finish(usage("已取消"));
          if (char === "\n" || char === "\r") return finish();
          if (char === "\x7f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " " && value.length < 8192) value += char;
        }
      }
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(previous);
    input.pause();
    process.stderr.write("\n");
  }
}
export function duration(value: string) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(value);
  const ms = m
    ? Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]] ?? 0)
    : 0;
  if (!ms || ms > 2147483647)
    throw usage("时长应为正数和单位，例如 30s 或 10m");
  return ms;
}
export function integer(
  value: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
    throw usage(`整数范围为 ${min}–${max}`);
  return n;
}
export function page(o: { limit?: string; offset?: string }) {
  return {
    _maxResults: integer(o.limit ?? "50", 1, 100),
    _startIndex: integer(o.offset ?? "0", 0),
  };
}

export type ApiCall = <M extends Method>(
  method: M,
  params: Params<M>,
  signal?: AbortSignal,
) => Promise<Result<M>>;
export interface Credentials {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}
async function credentialEntry(apiUrl: string) {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry("deckflow-cli", apiUrl);
}
const systemCredentials = (url: string): Credentials => ({
  async get() {
    try {
      return (await credentialEntry(url)).getPassword();
    } catch {
      return null;
    }
  },
  async set(value) {
    try {
      (await credentialEntry(url)).setPassword(value);
    } catch {
      throw new CliError(
        "CREDENTIAL_STORE_UNAVAILABLE",
        "系统凭据库不可写，请使用 DECKFLOW_TOKEN",
        3,
      );
    }
  },
  async clear() {
    try {
      (await credentialEntry(url)).deletePassword();
    } catch {
      throw new CliError("CREDENTIAL_STORE_UNAVAILABLE", "无法清除系统凭据", 3);
    }
  },
});

export class Context {
  readonly cwd: string;
  readonly configPath: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly interactive: boolean;
  readonly canOpen: boolean;
  readonly requestMs: number;
  readonly waitMs: number;
  constructor(
    public opts: Globals,
    private deps: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      fetch?: typeof fetch;
      credentialStore?: (url: string) => Credentials;
      tty?: boolean;
    } = {},
  ) {
    this.cwd = deps.cwd ?? process.cwd();
    this.env = deps.env ?? process.env;
    this.fetch = deps.fetch ?? fetch;
    this.stateDir = join(
      this.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "deckflow",
    );
    this.configPath = join(this.stateDir, "config.json");
    const tty =
      deps.tty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    this.interactive =
      tty &&
      !this.env.CI &&
      !opts.json &&
      opts.input !== false &&
      !opts.noInput;
    this.canOpen =
      this.interactive && Boolean(deps.tty ?? process.stdout.isTTY);
    this.requestMs = duration(opts.timeout ?? "30s");
    this.waitMs = duration(opts.waitTimeout ?? "10m");
  }
  async config() {
    return (await readJson<Config>(this.configPath)) ?? {};
  }
  async workspaceInfo() {
    if (this.opts.workspace) return { id: this.opts.workspace, source: "flag" };
    if (this.env.DECKFLOW_WORKSPACE)
      return { id: this.env.DECKFLOW_WORKSPACE, source: "environment" };
    for (let dir = this.cwd; ; dir = dirname(dir)) {
      const project = await readJson<Config>(join(dir, ".deckflow.json"));
      if (project?.workspace)
        return { id: project.workspace, source: "project" };
      if (dirname(dir) === dir) break;
    }
    return { id: (await this.config()).workspace, source: "user" };
  }
  async space() {
    const { id } = await this.workspaceInfo();
    if (!id)
      throw usage("请用 workspace use <id> 绑定工作空间，或指定 --workspace");
    return id;
  }
  async apiUrl() {
    const value = this.env.DECKFLOW_API_URL || (await this.config()).apiUrl;
    if (!value) throw usage("请配置 DECKFLOW_API_URL 或 config set apiUrl");
    return endpoint(value, "API 地址");
  }
  async webUrl() {
    const value = this.env.DECKFLOW_WEB_URL || (await this.config()).webUrl;
    if (!value) throw usage("请配置 DECKFLOW_WEB_URL 或 config set webUrl");
    return endpoint(value, "Web 地址");
  }
  credentialStore(url: string) {
    return (this.deps.credentialStore ?? systemCredentials)(url);
  }
  async client(credential?: string): Promise<ApiCall> {
    const url = await this.apiUrl();
    const token =
      credential ??
      (this.env.DECKFLOW_TOKEN || (await this.credentialStore(url).get()));
    if (!token)
      throw new CliError(
        "AUTH_REQUIRED",
        "请先 auth login 或设置 DECKFLOW_TOKEN",
        3,
      );
    const client = createClient(url, token, (input, init) =>
      this.fetch(input, { ...init, redirect: "error" }),
    );
    return async <M extends Method>(
      method: M,
      params: Params<M>,
      signal?: AbortSignal,
    ) => {
      const timeout = AbortSignal.timeout(this.requestMs);
      if (this.opts.verbose) process.stderr.write(`DeckBase: ${method}\n`);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        return await client.call(method, params, { signal: requestSignal });
      } catch (error) {
        const e = error as { status?: number; name?: string; cause?: unknown };
        const transient =
          [502, 503, 504].includes(e.status ?? 0) ||
          (e.name === "TypeError" && e.cause);
        if (!isRead(method) || !transient || requestSignal.aborted) throw error;
        await sleep(250, undefined, { signal: requestSignal });
        return client.call(method, params, { signal: requestSignal });
      }
    };
  }
  async confirm(label: string, details: Record<string, unknown>, cost = false) {
    const impact = {
      operation: label,
      ...details,
      ...(cost ? { estimatedCost: null, costStatus: "unknown" } : {}),
    };
    if (this.opts.dryRun) return { dryRun: true, ...impact };
    if (this.opts.yes) return;
    if (!this.interactive) throw usage("此操作需要 --yes 或 --dry-run");
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const suffix = cost ? "，费用未知" : "";
      const answer = await rl.question(
        `${label} ${JSON.stringify(impact)}${suffix}。继续？[y/N] `,
      );
      if (!/^y(es)?$/i.test(answer.trim()))
        throw new CliError("CANCELLED", "已取消");
    } finally {
      rl.close();
    }
  }
  path(value: string) {
    return resolve(this.cwd, value);
  }
}
export async function poll<T>(
  read: (signal: AbortSignal) => Promise<T>,
  done: (v: T) => boolean,
  ms: number,
) {
  const signal = AbortSignal.timeout(ms);
  for (;;) {
    signal.throwIfAborted();
    const value = await read(signal);
    if (done(value)) return value;
    await sleep(1000, undefined, { signal });
  }
}
export function methodOf(value: string): Method {
  if (!Object.hasOwn(methods, value)) throw usage("未知 DeckBase SDK 方法");
  return value as Method;
}
export const isRead = (method: Method) =>
  methods[method] === "get" &&
  ![
    "auth.checkSceneScan",
    "order.status",
    "uploadSession.detail",
    "file.content",
    "revision.content",
    "artifact.content",
    "conversion.content",
    "wechat.sceneQrcode",
    "albumPublic.cover",
  ].includes(method);
