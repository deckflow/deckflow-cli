import { Context, type ApiCall } from "./core.js";
import { t } from "./i18n.mjs";

type Check = {
  id: string;
  status: "pass" | "fail" | "warning" | "skipped";
  code: string;
  suggestion?: string;
  source?: string;
  http_status?: number;
};

// Never include API payloads, local configuration values, or exception messages.
export async function doctor(ctx: Context) {
  const checks: Check[] = [];
  const check = async (
    id: string,
    run: () => Promise<Partial<Check> | void>,
    suggestion: string,
  ) => {
    try {
      const extra = await run();
      checks.push({ id, status: "pass", code: "OK", ...extra });
      return true;
    } catch (error) {
      const e = error as { status?: number; code?: string };
      const code =
        e.code === "INVALID_API_ENDPOINT"
          ? "INVALID_API_ENDPOINT"
          : [405, 501].includes(e.status ?? 0)
            ? "NOT_IMPLEMENTED"
            : e.status === 401
              ? "UNAUTHENTICATED"
              : e.status === 403
                ? "PERMISSION_DENIED"
                : e.status === 404
                  ? "ENDPOINT_OR_RESOURCE_NOT_FOUND"
                  : e.status === 429
                    ? "RATE_LIMITED"
                    : e.status
                      ? "BACKEND_UNAVAILABLE"
                      : id === "config"
                        ? "CONFIG_UNREADABLE"
                        : id === "api_url"
                          ? "INVALID_API_ENDPOINT"
                          : id === "credentials"
                            ? "CREDENTIALS_UNAVAILABLE"
                            : id === "workspace"
                              ? "WORKSPACE_REQUIRED"
                              : "BACKEND_UNAVAILABLE";
      checks.push({
        id,
        status: "fail",
        code,
        suggestion,
        ...(e.status ? { http_status: e.status } : {}),
      });
      return false;
    }
  };
  const skip = (id: string) =>
    checks.push({
      id,
      status: "skipped",
      code: "DEPENDENCY_FAILED",
      suggestion: t("先修复配置、地址或凭据检查"),
    });
  await check(
    "config",
    async () => {
      await ctx.config();
    },
    t("检查本地凭据文件的 JSON 格式和读取权限"),
  );
  let url: string | undefined;
  await check(
    "api_url",
    async () => {
      url = await ctx.apiUrl();
      return {
        source: ctx.env.DECKFLOW_API_URL ? "environment" : "credential-store",
      };
    },
    t("配置正确的 HTTP(S) API 基础地址"),
  );
  let api: ApiCall | undefined;
  if (url || ctx.env.DECKFLOW_TOKEN)
    await check(
      "credentials",
      async () => {
        if (url) api = await ctx.client(undefined, url, true);
        return {
          source: ctx.env.DECKFLOW_TOKEN ? "environment" : "credential-store",
        };
      },
      t("设置 DECKFLOW_TOKEN 或重新登录，并检查客户端标识文件"),
    );
  else skip("credentials");
  if (api) {
    await check(
      "identity_api",
      async () => {
        await api!("user.self", { _full: "no" });
      },
      t("重新登录或检查 API Key 是否允许身份接口"),
    );
    const spaces = await check(
      "workspaces_api",
      async () => {
        await api!("my.spaces", {});
      },
      t("检查 API 地址、网络以及凭据的空间列表权限"),
    );
    const identity = checks.find((c) => c.id === "identity_api")!;
    if (spaces && [401, 403, 404].includes(identity.http_status ?? 0)) {
      identity.status = "warning";
      identity.code = "IDENTITY_ROUTE_RESTRICTED";
    }
  } else {
    skip("identity_api");
    skip("workspaces_api");
  }
  let workspace: string | undefined;
  await check(
    "workspace",
    async () => {
      workspace = await ctx.space();
      return { source: (await ctx.spaceInfo()).source };
    },
    t("用 ws use <id> 设置空间，或指定 --ws / DECKFLOW_WORKSPACE"),
  );
  if (api && workspace)
    await check(
      "workspace_api",
      async () => {
        await api!("space.detail", { id: workspace! });
      },
      t("确认选定空间存在且当前凭据拥有访问权限"),
    );
  else skip("workspace_api");
  const healthy = !checks.some(
    (c) => c.status === "fail" || c.status === "skipped",
  );
  return { schema_version: 1, healthy, exit_code: healthy ? 0 : 1, checks };
}
