import { t } from "./i18n.mjs";
import {
  createClient,
  type Method,
  type Params,
  type Result,
} from "@deckflow/deckbase-sdk";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { methods } from "./sdk-methods.generated.js";

const credentialValues = new Set<string>();
export function redactCredentials(value: string) {
  for (const credential of credentialValues)
    value = value.split(credential).join("[REDACTED]");
  return value;
}
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
  new CliError("UNSUPPORTED_OPERATION", t("{0}：当前后端不支持", [feature]), 2);
export type Globals = {
  lang?: string;
  space?: string;
  ws?: string;
  quiet?: boolean;
  json?: boolean;
  noInput?: boolean;
  input?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  timeout?: string;
  waitTimeout?: string;
  verbose?: boolean;
};
export const configFields = {
  lang: {
    storedAs: "lang",
    format: "language",
    description: "语言：en、zh 或 auto。",
    example: "en",
  },
  apiUrl: {
    storedAs: "apiRoot",
    format: "url",
    description: "DeckBase API 的基础地址，用于 CLI 发起 API 请求。",
    example: "https://deckbase.example.com/api",
  },
  webUrl: {
    storedAs: "webRoot",
    format: "url",
    description: "DeckBase 网页的基础地址，用于生成 deckflow view 的资源链接。",
    example: "https://deckbase.example.com",
  },
  space: {
    storedAs: "spaceId",
    format: "id",
    description: "用户级默认工作空间。",
    example: "YOUR_SPACE_ID",
  },
} as const;
export type Config = Partial<Record<keyof typeof configFields, string>>;

export function configKey(key: string): keyof Config {
  if (!Object.hasOwn(configFields, key))
    throw usage(t("配置项必须是 {0}", [Object.keys(configFields).join(", ")]));
  return key as keyof Config;
}
export function endpoint(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage(t("{0} 必须是完整 URL", [label]));
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  )
    throw usage(t("{0} 必须是无凭据、查询和片段的 HTTP(S) URL", [label]));
  return url.href.replace(/\/$/, "");
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw usage(t("无法读取 JSON 配置或操作状态"));
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
    throw usage(t("--input 需要一个 JSON 对象"));
  }
}
export async function stdinText() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 1024 * 1024) throw usage(t("输入超过 1 MiB"));
  }
  return value;
}
export async function hiddenToken(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw usage(t("请使用 --token-stdin 或 DECKFLOW_TOKEN"));
  const previous = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((done, fail) => {
      let value = "";
      function finish(error?: Error) {
        input.off("keypress", onKey);
        if (error) fail(error);
        else done(value);
      }
      function onKey(text: string | undefined, key: Key) {
        if (key.ctrl && ["c", "d"].includes(key.name ?? ""))
          return finish(usage(t("已取消")));
        if (["return", "enter"].includes(key.name ?? "")) return finish();
        if (key.name === "backspace")
          value = Array.from(value).slice(0, -1).join("");
        else if (
          text &&
          !key.ctrl &&
          !key.meta &&
          !/[\x00-\x1f\x7f]/.test(text)
        )
          value = (value + text).slice(0, 8192);
      }
      input.on("keypress", onKey);
      process.stderr.write("DeckBase API Key / Token: ");
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
    throw usage(t("时长应为正数和单位，例如 30s 或 10m"));
  return ms;
}
export function integer(
  value: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
    throw usage(t("整数范围为 {0}–{1}", [min, max]));
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
export type LocalAccount = {
  id: string;
  token: string;
  name?: string;
  expiredAt?: string | null;
  kind?: string;
};
export function selectAccount<T extends { id: string; name?: string }>(
  accounts: T[],
  selector: string,
): T {
  const matches = accounts.filter(
    (a) => a.id === selector || a.name === selector,
  );
  if (matches.length !== 1)
    throw usage(
      "Account not found or ambiguous; use auth accounts to list account IDs",
    );
  return matches[0];
}
type StoredCredentials = Partial<
  Record<
    (typeof configFields)[keyof Config]["storedAs"] | "token" | "tokenApiRoot",
    string
  >
> & {
  accounts?: Record<string, Record<string, LocalAccount>>;
  activeAccounts?: Record<string, string>;
};

export class Context {
  readonly cwd: string;
  readonly credentialsPath: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly interactive: boolean;
  readonly canOpen: boolean;
  readonly requestMs: number;
  readonly waitMs: number;
  private readonly dryRunUUID = randomUUID();
  constructor(
    public opts: Globals,
    private deps: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      fetch?: typeof fetch;
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
    this.credentialsPath = join(homedir(), ".deckflow", "credentials");
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
    this.requestMs = duration(
      /^\d+$/.test(opts.timeout ?? "30")
        ? `${opts.timeout ?? "30"}s`
        : opts.timeout!,
    );
    this.waitMs = duration(opts.waitTimeout ?? "10m");
  }
  async initialize() {
    if (this.opts.dryRun) return;
    const dir = dirname(this.credentialsPath);
    const path = join(dir, "auth-uuid");
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const temp = join(dir, `.auth-uuid.${id}.tmp`);
    try {
      await writeFile(temp, id + "\n", { mode: 0o600, flag: "wx" });
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async clientUUID(readOnly = false) {
    if (!this.opts.dryRun && !readOnly) await this.initialize();
    let value: string;
    try {
      value = (
        await readFile(join(dirname(this.credentialsPath), "auth-uuid"), "utf8")
      ).trim();
    } catch (error) {
      if (
        (this.opts.dryRun || readOnly) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return this.dryRunUUID;
      throw error;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new CliError(
        "INVALID_CLIENT_UUID",
        t("客户端标识文件 ~/.deckflow/auth-uuid 不是有效的 UUID v4"),
        2,
      );
    return value;
  }
  private async credentials() {
    const data = await readJson<unknown>(this.credentialsPath);
    if (data === undefined) return {};
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.entries(data).some(
        ([key, value]) =>
          !["accounts", "activeAccounts"].includes(key) &&
          typeof value !== "string",
      )
    )
      throw usage(t("凭据配置必须是字符串字段组成的 JSON 对象"));
    const stored = data as StoredCredentials;
    const record = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    if (stored.accounts !== undefined) {
      if (!record(stored.accounts))
        throw usage("Invalid account configuration");
      for (const accounts of Object.values(stored.accounts)) {
        if (!record(accounts)) throw usage("Invalid account configuration");
        for (const [id, account] of Object.entries(accounts)) {
          if (
            !record(account) ||
            account.id !== id ||
            typeof account.token !== "string" ||
            !account.token ||
            /\s/.test(account.token) ||
            (account.name !== undefined && typeof account.name !== "string") ||
            (account.expiredAt != null && typeof account.expiredAt !== "string")
          )
            throw usage("Invalid account configuration");
        }
      }
    }
    if (
      stored.activeAccounts !== undefined &&
      (!record(stored.activeAccounts) ||
        Object.values(stored.activeAccounts).some(
          (id) => typeof id !== "string",
        ))
    )
      throw usage("Invalid active account configuration");
    for (const [url, id] of Object.entries(stored.activeAccounts ?? {}))
      if (!stored.accounts?.[url] || !Object.hasOwn(stored.accounts[url], id))
        throw usage("Active account is missing from account configuration");
    return stored;
  }
  private async updateCredentials(update: (data: StoredCredentials) => void) {
    await mkdir(dirname(this.credentialsPath), {
      recursive: true,
      mode: 0o700,
    });
    const release = await lockfile.lock(this.credentialsPath, {
      realpath: false,
      retries: { retries: 30, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      const data = await this.credentials();
      update(data);
      await saveJson(this.credentialsPath, data);
    } finally {
      await release();
    }
  }
  async config(): Promise<Config> {
    const data = await this.credentials();
    return {
      lang: "auto",
      ...Object.fromEntries(
        Object.entries(configFields)
          .map(([key, field]) => [key, data[field.storedAs]])
          .filter(([, value]) => value !== undefined),
      ),
    };
  }
  async setConfig(key: keyof Config, value: string) {
    await this.updateCredentials((data) => {
      data[configFields[key].storedAs] = value;
    });
  }
  async localAccount(url = ""): Promise<LocalAccount | undefined> {
    url ||= await this.apiUrl();
    const data = await this.credentials();
    const active = data.activeAccounts?.[url];
    const account = active && data.accounts?.[url]?.[active];
    if (account) return account;
    if ((data.tokenApiRoot ?? data.apiRoot) === url && data.token)
      return {
        id:
          "credential-" +
          createHash("sha256").update(data.token).digest("hex").slice(0, 16),
        token: data.token,
      };
  }
  async saveToken(
    url: string,
    token: string,
    metadata?: Omit<LocalAccount, "token">,
  ) {
    const account: LocalAccount = {
      ...metadata,
      id:
        metadata?.id ||
        "credential-" +
          createHash("sha256").update(token).digest("hex").slice(0, 16),
      token,
    };
    await this.updateCredentials((data) => {
      const previousUrl = data.tokenApiRoot ?? data.apiRoot;
      data.apiRoot ??= url;
      data.accounts ??= {};
      data.activeAccounts ??= {};
      if (
        data.token &&
        previousUrl &&
        !(previousUrl === url && data.token === token) &&
        !Object.values(data.accounts[previousUrl] ?? {}).some(
          (account) => account.token === data.token,
        )
      ) {
        const previousId =
          "credential-" +
          createHash("sha256").update(data.token).digest("hex").slice(0, 16);
        data.accounts[previousUrl] = {
          ...data.accounts[previousUrl],
          [previousId]: { id: previousId, token: data.token },
        };
        data.activeAccounts[previousUrl] ??= previousId;
      }
      for (const [id, existing] of Object.entries(data.accounts[url] ?? {}))
        if (existing.token === token && id !== account.id)
          delete data.accounts[url][id];
      data.accounts[url] = { ...data.accounts[url], [account.id]: account };
      data.activeAccounts ??= {};
      data.activeAccounts[url] = account.id;
      data.tokenApiRoot = url;
      data.token = token;
    });
  }
  async accountList() {
    const url = await this.apiUrl(),
      data = await this.credentials();
    const accounts = Object.values(data.accounts?.[url] ?? {});
    const legacy = await this.localAccount(url);
    if (legacy && !accounts.some((a) => a.id === legacy.id))
      accounts.push(legacy);
    return accounts.map(({ token: _token, ...account }) => ({
      ...account,
      active: account.id === (data.activeAccounts?.[url] ?? legacy?.id),
    }));
  }
  async switchAccount(selector: string) {
    const url = await this.apiUrl();
    await this.updateCredentials((data) => {
      const accounts = { ...data.accounts?.[url] };
      if (
        data.token &&
        (data.tokenApiRoot ?? data.apiRoot) === url &&
        !Object.values(accounts).some((a) => a.token === data.token)
      ) {
        const id =
          "credential-" +
          createHash("sha256").update(data.token).digest("hex").slice(0, 16);
        accounts[id] = { id, token: data.token };
      }
      const selected = selectAccount(Object.values(accounts), selector);
      data.accounts ??= {};
      data.accounts[url] = accounts;
      data.activeAccounts ??= {};
      data.activeAccounts[url] = selected.id;
      data.tokenApiRoot = url;
      data.token = selected.token;
    });
    return (await this.accountList()).find((a) => a.active);
  }
  async clearToken(url: string) {
    let removed = false;
    await this.updateCredentials((data) => {
      const id = data.activeAccounts?.[url];
      if (id && data.accounts?.[url]?.[id]) {
        delete data.accounts[url][id];
        delete data.activeAccounts![url];
        removed = true;
      }
      if ((data.tokenApiRoot ?? data.apiRoot) === url) {
        removed ||= data.token !== undefined;
        delete data.token;
        delete data.tokenApiRoot;
      }
    });
    return removed;
  }
  async spaceInfo() {
    if (this.opts.ws !== undefined) {
      if (!this.opts.ws.trim())
        throw usage(t("--ws 不能为空，请用 ws ls 获取工作空间 ID"));
      return { id: this.opts.ws, source: "flag" };
    }
    if (this.env.DECKFLOW_WORKSPACE)
      return { id: this.env.DECKFLOW_WORKSPACE, source: "environment" };
    return { id: (await this.config()).space, source: "user" };
  }

  async space() {
    const { id } = await this.spaceInfo();
    if (!id)
      throw new CliError(
        "WORKSPACE_REQUIRED",
        t("请用 ws use <id> 绑定工作空间，或指定 --ws"),
        2,
      );
    return id;
  }
  async apiUrl() {
    const value = this.env.DECKFLOW_API_URL || (await this.config()).apiUrl;
    if (!value) throw usage(t("请配置 DECKFLOW_API_URL 或 config set apiUrl"));
    return endpoint(value, t("API 地址"));
  }
  async webUrl() {
    const value = this.env.DECKFLOW_WEB_URL || (await this.config()).webUrl;
    if (!value) throw usage(t("请配置 DECKFLOW_WEB_URL 或 config set webUrl"));
    return endpoint(value, t("Web 地址"));
  }
  async credentialScope() {
    const url = await this.apiUrl();
    const token =
      this.env.DECKFLOW_TOKEN || (await this.localAccount(url))?.token;
    if (!token) throw new CliError("AUTH_REQUIRED", t("请先登录"), 3);
    return createHash("sha256").update(token).digest("hex");
  }
  async client(
    credential?: string,
    apiUrl?: string,
    readOnly = false,
  ): Promise<ApiCall> {
    const url = apiUrl ?? (await this.apiUrl());
    let token = credential ?? this.env.DECKFLOW_TOKEN;
    if (!token && credential === undefined) {
      token = (await this.localAccount(url))?.token;
    }
    if (!token)
      throw new CliError(
        "AUTH_REQUIRED",
        t("请先 auth login 或设置 DECKFLOW_TOKEN"),
        3,
      );
    credentialValues.add(token);
    const client = createClient(
      url,
      token,
      async (input, init) => {
        const response = await this.fetch(input, {
          ...init,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new CliError(
            "INVALID_API_ENDPOINT",
            t("API 地址返回重定向，请更新配置中的 API 基础地址"),
            2,
            { status: response.status },
          );
        }
        if (
          !response.ok &&
          response.headers.get("X-Transient-Network-Error") === "1"
        ) {
          const error = await response.json().catch(() => ({}));
          throw Object.assign(new Error(t("API 暂态网络故障")), error, {
            status: response.status,
            transientNetwork: true,
          });
        }
        return response;
      },
      await this.clientUUID(readOnly),
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
        const e = error as {
          status?: number;
          name?: string;
          cause?: unknown;
          transientNetwork?: boolean;
        };
        const transient =
          e.transientNetwork === true ||
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
    if (!this.interactive) throw usage(t("此操作需要 --yes 或 --dry-run"));
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    rl.once("SIGINT", cancel);
    try {
      const suffix = cost ? t("，费用未知") : "";
      const answer = await rl.question(
        t("{0} {1}{2}。继续？[y/N] ", [label, JSON.stringify(impact), suffix]),
        { signal: cancellation.signal },
      );
      if (!/^y(es)?$/i.test(answer.trim()))
        throw new CliError("CANCELLED", t("已取消"));
    } catch (error) {
      if (cancellation.signal.aborted)
        throw new CliError("CANCELLED", t("已取消"), 2);
      throw error;
    } finally {
      rl.off("SIGINT", cancel);
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
  if (!Object.hasOwn(methods, value)) throw usage(t("未知 DeckBase SDK 方法"));
  return value as Method;
}
export const isRead = (method: Method) =>
  (["search.find", "search.query"].includes(method) ||
    methods[method] === "get") &&
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
