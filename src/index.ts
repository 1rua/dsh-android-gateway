import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveConfig, type AndroidGatewayConfig } from "./config.js";
import { AccountManager } from "./core/accounts.js";
import { AttachmentService } from "./core/attachment-service.js";
import { AuthService } from "./core/auth-service.js";
import { ConversationService } from "./core/conversation-service.js";
import { GatewayEventHub } from "./core/event-hub.js";
import { AndroidGatewayCore, MOUNT_PATH } from "./core/gateway.js";
import { NegotiationManager } from "./core/negotiation.js";
import { PairingService } from "./core/pairing-service.js";
import { DshBridge } from "./dsh/bridge.js";
import type { DshContext, DshLogger, DshWebServer } from "./dsh/types.js";
import { RequestAuthenticator } from "./auth/authenticator.js";
import { createGatewayHttpHandler } from "./http/index.js";
import type { GatewayHttpHandler } from "./http/contract.js";

export const name = "dsh-android-gateway";

/** 复用 DSH 自己的 HTTP 服务器，不另起端口。 */
export const inject = ["webServer"] as const;

export type { AndroidGatewayConfig };

const fallbackLogger: DshLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const writeBootstrapFailure = (res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({
    requestId: `req_${Date.now().toString(36)}`,
    correlationId: `cor_${Date.now().toString(36)}`,
    protocol: "2.1",
    error: {
      code: "INTERNAL_ERROR",
      message: "Gateway is not ready",
      retryable: true,
      retryAfterSeconds: 5,
      details: {},
    },
  });
  res.writeHead(503, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
};

/**
 * DSH 宿主插件入口。
 *
 * 激活时完成：账号注册表与每账号数据库初始化 → DSH 服务桥 → 协议服务装配 →
 * 在 `ctx.webServer` 上挂载 `/open-android-intelligence/v2` 前缀路由。
 * 卸载时逆序释放：路由、订阅、定时器、数据库。
 */
export function apply(ctx: DshContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger ?? fallbackLogger;
  const webServer = ctx.get("webServer") as DshWebServer | undefined;
  if (webServer === undefined) {
    logger.error("[dsh-android-gateway] webServer 不可用：插件需要 dsh-host-webserver");
    throw new Error("dsh-android-gateway requires the webServer service");
  }

  let handler: GatewayHttpHandler | undefined;
  let bootstrapError: unknown;
  const ready = (async () => {
    const accounts = new AccountManager({
      rootDir: config.dataDir,
      defaultUsername: config.defaultUsername,
      configuredAccounts: config.accounts,
      logger,
    });
    await accounts.initialize();

    const bridge = new DshBridge(ctx, {
      ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    });
    const availability = bridge.availability;
    if (!availability.available) {
      logger.warn(
        `[dsh-android-gateway] DSH 服务不完整，缺失 ${availability.missing.join(", ")}；网关将拒绝创建会话。`,
      );
    }

    const events = new GatewayEventHub({
      openStore: (accountId) => accounts.openStore(accountId),
      retentionSeconds: config.eventRetentionSeconds,
      logger,
    });
    const negotiations = new NegotiationManager({
      deploymentId: () => accounts.deploymentId(),
      limits: {
        attachmentTtlSeconds: config.attachmentTtlSeconds,
        eventRetentionSeconds: config.eventRetentionSeconds,
        maxClockSkewSeconds: config.maxClockSkewSeconds,
      },
      tlsSpkiSha256: config.tlsSpkiSha256,
      logger,
    });
    const auth = new AuthService({ accounts, negotiations, logger });
    const attachments = new AttachmentService({
      accounts,
      bridge,
      ttlSeconds: config.attachmentTtlSeconds,
      maxBytes: config.maxAttachmentBytes,
      logger,
    });
    const pairing = new PairingService({ accounts, events, logger });
    const conversations = new ConversationService({
      accounts,
      events,
      bridge,
      attachments,
      ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
      logger,
    });
    conversations.start();

    const core = new AndroidGatewayCore({
      accounts,
      negotiations,
      auth,
      conversations,
      attachments,
      pairing,
      events,
      logger,
    });
    const authenticator = new RequestAuthenticator({
      openStore: (accountId) => accounts.openStore(accountId),
      options: { maxClockSkewMs: config.maxClockSkewSeconds * 1000 },
    });
    handler = createGatewayHttpHandler(core, authenticator, events, {
      maxAttachmentBytes: config.maxAttachmentBytes,
      heartbeatMs: config.heartbeatMs,
      logger,
    });

    const timer = setInterval(() => {
      try {
        core.maintenance();
      } catch (error) {
        logger.warn(
          `[dsh-android-gateway] maintenance failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, 10 * 60 * 1000);
    timer.unref?.();

    ctx.effect(
      () => () => {
        clearInterval(timer);
        conversations.stop();
        bridge.dispose();
        accounts.close();
      },
      "dsh-android-gateway.cleanup",
    );

    logger.info(
      `[dsh-android-gateway] Gateway 已挂载于 ${MOUNT_PATH}（${webServer.getOrigin?.() ?? "unknown origin"}），账号 ${accounts.registry.list().length} 个。`,
    );
  })();

  const route = webServer.register({
    kind: "prefix",
    path: MOUNT_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await ready;
      } catch (error) {
        bootstrapError = error;
      }
      if (handler === undefined) {
        writeBootstrapFailure(res, bootstrapError);
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        logger.error(
          `[dsh-android-gateway] 请求处理失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
        writeBootstrapFailure(res, error);
      }
    },
  });

  ctx.effect(
    () => () => {
      route();
    },
    "dsh-android-gateway.route",
  );
}

