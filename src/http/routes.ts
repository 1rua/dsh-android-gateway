import {
  DEFAULT_MOUNT_PATH,
  isGatewayMethod,
  splitRawTarget,
} from "./headers.js";

/** 认证前端点：这些路由永远不进入验签器（契约 §4/§5）。 */
export type PreAuthOperation =
  | "negotiate"
  | "password"
  | "refresh"
  | "invite-challenge"
  | "invite-exchange"
  | "device-challenge"
  | "device-login";

export type GatewayRoute =
  | { readonly kind: "pre-auth"; readonly operation: PreAuthOperation }
  | { readonly kind: "logout" }
  /** GET /events：验签后由 Accept/cursor 决定走 SSE 还是 JSON（core.handle）。 */
  | { readonly kind: "events" }
  | { readonly kind: "attachment-content" }
  /** 其余已认证 JSON 路由，全部交给 core.handle 按 method + path 分派。 */
  | { readonly kind: "core" }
  | { readonly kind: "not-found" };

export interface RouteMatch {
  readonly route: GatewayRoute;
  /** 原样 target 的 path 部分（未解码、未 canonical 化）。 */
  readonly rawPath: string;
  /** 原样 target 的 query 部分（不含 `?`）。 */
  readonly rawQuery: string;
  readonly hasQuery: boolean;
}

const PRE_AUTH_ROUTES: ReadonlyMap<string, PreAuthOperation> = new Map([
  ["POST /negotiate", "negotiate"],
  ["POST /sessions/password", "password"],
  ["POST /sessions/refresh", "refresh"],
  ["POST /sessions/invite/challenge", "invite-challenge"],
  ["POST /pairings/exchange", "invite-exchange"],
  // 参考实现同时暴露的别名；App 当前使用 /pairings/exchange。
  ["POST /sessions/invite/exchange", "invite-exchange"],
  ["POST /sessions/device/challenge", "device-challenge"],
  ["POST /sessions/device", "device-login"],
]);

/** mountPath 只做首尾规范化；非法输入属于插件装配错误，直接抛出。 */
export const normalizeMountPath = (mountPath: string | undefined): string => {
  const raw = mountPath ?? DEFAULT_MOUNT_PATH;
  if (!raw.startsWith("/")) throw new Error(`mountPath must start with '/': ${raw}`);
  if (raw.length === 1) return "/";
  return raw.replace(/\/+$/u, "");
};

/**
 * `PUT /attachments/{attachmentId}/content` 的精确段匹配。
 * 不做 percent 解码：canonical target 与路径语义属于 verifier/core。
 */
const isAttachmentContentPath = (relativePath: string): boolean => {
  if (!relativePath.startsWith("/attachments/")) return false;
  const segments = relativePath.split("/");
  if (segments.length !== 4) return false;
  if (segments[0] !== "" || segments[1] !== "attachments" || segments[3] !== "content") return false;
  const attachmentId = segments[2];
  return attachmentId !== undefined && attachmentId.length > 0 && attachmentId !== "." && attachmentId !== "..";
};

/**
 * 按契约 §1.3/§1.4 分类请求。
 *
 * 固定前缀之外（以及非法 method）一律 404；前缀内未精确命中的路径
 * 视为「其余已认证 JSON 路由」，交给 core.handle 决定 404/405/SCHEMA_INVALID。
 */
export const matchRoute = (
  method: string | undefined,
  target: string,
  mountPath: string,
): RouteMatch => {
  const { rawPath, rawQuery, hasQuery } = splitRawTarget(target);
  const notFound = (): RouteMatch => ({
    route: { kind: "not-found" },
    rawPath,
    rawQuery,
    hasQuery,
  });

  if (method === undefined || !isGatewayMethod(method)) return notFound();
  if (!rawPath.startsWith(mountPath)) return notFound();
  if (
    mountPath !== "/" &&
    rawPath.length > mountPath.length &&
    rawPath.charAt(mountPath.length) !== "/"
  ) {
    return notFound();
  }

  // 前缀边界检查保证 mountPath 不会吞掉 `/v2x` 这类相似路径。
  const relativePath = mountPath === "/" ? rawPath : rawPath.slice(mountPath.length);
  const routeKey = `${method} ${relativePath}`;

  const preAuthOperation = PRE_AUTH_ROUTES.get(routeKey);
  if (preAuthOperation !== undefined) {
    return {
      route: { kind: "pre-auth", operation: preAuthOperation },
      rawPath,
      rawQuery,
      hasQuery,
    };
  }
  if (routeKey === "DELETE /sessions/current") {
    return { route: { kind: "logout" }, rawPath, rawQuery, hasQuery };
  }
  if (routeKey === "GET /events") {
    return { route: { kind: "events" }, rawPath, rawQuery, hasQuery };
  }
  if (method === "PUT" && isAttachmentContentPath(relativePath)) {
    return { route: { kind: "attachment-content" }, rawPath, rawQuery, hasQuery };
  }
  return { route: { kind: "core" }, rawPath, rawQuery, hasQuery };
};
