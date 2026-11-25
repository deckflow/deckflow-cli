import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createClient, type Method, type Params } from "@deckflow/deckbase-sdk";
import { setTimeout as delay } from "node:timers/promises";
import openBrowser from "open";
import { CliError, Context, usage } from "./core.js";
import { callbackPage, callbackPageCsp } from "./auth-page.js";

export function authorizationMode(value?: string) {
  const mode = value?.toLowerCase();
  if (mode !== undefined && mode !== "apikey" && mode !== "token")
    throw usage("--mode 必须是 apikey 或 token");
  return mode;
}

function secureEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw usage("浏览器授权需要 HTTPS 地址（localhost 除外）");
  return url;
}

export async function browserLogin(
  ctx: Context,
  apiUrl: string,
  mode?: "apikey" | "token",
  browser = true,
) {
  secureEndpoint(apiUrl);
  const web = secureEndpoint(await ctx.webUrl());
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, ctx.waitMs);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let deviceCode: string | undefined;
  let redeemed = false;
  let retryAfterMs = 0;
  const state = randomBytes(32).toString("base64url");
  let received = false;
  let notify!: (received: boolean) => void;
  const callback = new Promise<boolean>((resolve) => {
    notify = resolve;
  });
  const stopWaiting = () => notify(false);
  controller.signal.addEventListener("abort", stopWaiting, { once: true });
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("Invalid callback URL");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end("Method not allowed");
      return;
    }
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const address = server.address();
    if (
      !address ||
      typeof address === "string" ||
      req.headers.host !== `127.0.0.1:${address.port}` ||
      url.searchParams.get("state") !== state
    ) {
      res.writeHead(400).end("Invalid callback state or host");
      return;
    }
    if (received) {
      res.writeHead(409).end("Callback already received");
      return;
    }
    received = true;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", callbackPageCsp);
    res.end(callbackPage);
    notify(true);
  });
  const client = createClient(apiUrl, "", async (input, init) => {
    retryAfterMs = 0;
    const response = await ctx.fetch(input, { ...init, redirect: "manual" });
    const retry = response.headers.get("Retry-After");
    if (retry)
      retryAfterMs =
        Math.max(
          0,
          /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now(),
        ) || 0;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CliError(
        "INVALID_API_ENDPOINT",
        "API 地址返回重定向，请更新 API 基础地址",
      );
    }
    return response;
  });
  const call = async <M extends Method>(method: M, params: Params<M>) => {
    controller.signal.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () =>
        request.abort(new DOMException("Request timed out", "TimeoutError")),
      ctx.requestMs,
    );
    try {
      return await client.call(method, params, { signal: request.signal });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    controller.signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new CliError("AUTH_CALLBACK_FAILED", "无法启动本地授权回调服务");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    process.stderr.write("正在创建浏览器授权请求…\n");
    const request = await call("cliAuth.create", {
      clientName: "DeckFlow CLI",
      mode,
      redirectUri,
      state,
    });
    deviceCode = request.deviceCode;
    if (
      !deviceCode ||
      !request.userCode ||
      !Number.isFinite(request.expiresIn) ||
      request.expiresIn <= 0 ||
      !request.verificationPath
    )
      throw new CliError("INVALID_AUTH_RESPONSE", "服务端返回了无效的授权请求");
    expiryTimer = setTimeout(
      () => {
        expired = true;
        cancel();
      },
      Math.min(request.expiresIn * 1000, ctx.waitMs),
    );
    const link = new URL(request.verificationPath, web.origin);
    if (link.origin !== web.origin || link.username || link.password)
      throw new CliError(
        "INVALID_AUTH_RESPONSE",
        "授权链接必须属于配置的 Web 地址",
      );
    process.stderr.write(
      `请在浏览器中授权：${link.href}\n核对授权码：${request.userCode}\n`,
    );
    if (browser && ctx.canOpen) {
      try {
        await openBrowser(link.href);
      } catch {
        process.stderr.write("无法自动打开浏览器，请手动打开上面的链接。\n");
      }
    }
    process.stderr.write("正在等待浏览器授权…（Ctrl+C 取消）\n");
    if (!(await callback)) controller.signal.throwIfAborted();
    let retries = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      try {
        const result = await call("cliAuth.exchange", { deviceCode });
        if (result.status === "pending")
          throw new CliError(
            "AUTH_CALLBACK_FAILED",
            "授权尚未完成，请重新登录",
            3,
          );
        if (result.status !== "redeemed") {
          const messages = {
            denied: "用户拒绝了授权",
            cancelled: "授权已取消",
            expired: "授权已过期，请重新登录",
          };
          throw new CliError(
            `AUTH_${result.status.toUpperCase()}`,
            messages[result.status],
            3,
          );
        }
        redeemed = true;
        if (
          !["apikey", "token"].includes(result.mode) ||
          !result.credential ||
          /\s/.test(result.credential) ||
          (mode && result.mode !== mode)
        )
          throw new CliError(
            "INVALID_AUTH_RESPONSE",
            "服务端返回了无效的授权凭据",
            3,
          );
        try {
          await ctx.saveToken(apiUrl, result.credential);
        } catch {
          throw new CliError(
            "AUTH_SAVE_FAILED",
            "无法保存登录凭据，请检查本地配置目录权限",
            2,
          );
        }
        process.stderr.write("授权完成，凭据已安全保存。\n");
        return {
          authenticated: true,
          mode: result.mode,
          user: { id: result.userId },
          expiredAt: result.expiredAt,
          environmentTokenActive: !!ctx.env.DECKFLOW_TOKEN,
        };
      } catch (error) {
        const e = error as { status?: number; name?: string };
        if (
          e.status === 429 ||
          (e.status && e.status >= 500) ||
          error instanceof TypeError ||
          e.name === "TimeoutError"
        ) {
          if (++retries > 3) throw error;
          process.stderr.write("凭据兑换暂时失败，稍后重试…\n");
          await delay(
            Math.min(
              2147483647,
              Math.max(1000 * 2 ** (retries - 1), retryAfterMs),
            ),
            undefined,
            { signal: controller.signal },
          );
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new CliError(
        expired ? "AUTH_EXPIRED" : "CANCELLED",
        expired ? "授权等待超时，请重新登录" : "授权已取消",
        expired ? 3 : 2,
      );
    if (error instanceof CliError) throw error;
    throw new CliError(
      "AUTH_FAILED",
      "浏览器授权失败，请检查服务地址和网络后重试",
      3,
      { status: (error as { status?: number }).status },
    );
  } finally {
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    try {
      if (deviceCode && !redeemed)
        await client
          .call(
            "cliAuth.cancel",
            { deviceCode },
            { signal: AbortSignal.timeout(Math.min(ctx.requestMs, 5000)) },
          )
          .catch(() => undefined);
    } finally {
      controller.signal.removeEventListener("abort", stopWaiting);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
