import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import canonicalize from "canonicalize";

import {
  DeviceCapabilityService,
  type DeviceCapabilityServiceOptions,
} from "../../src/devices/device-service.js";
import { DeviceRequestStore } from "../../src/devices/device-store.js";
import { DEVICE_REQUESTED_EVENT } from "../../src/devices/device-service.js";
import type {
  CapabilityPublication,
  CapabilityRisk,
  DeviceRequestRecord,
  PublishedCapabilityBinding,
} from "../../src/devices/contract.js";
import type { JsonObject, VerifiedRequest } from "../../src/shared/types.js";
import { createTempDir, removeTempDir } from "../store/helpers.js";

export const ACCOUNT_ID = "acct_test";
export const DEVICE_ID = "dev_test";
export const CONVERSATION_ID = "conv_test";
export const GRANT_REVISION = 7;
export const PAIRING_GENERATION = 3;
export const FIXED_NOW = new Date("2026-10-20T12:00:00.000Z");

/** 与 App 侧 `Json.sha256` / pairing-service 相同的 JCS + SHA-256。 */
export const sha256OfSchema = (schema: JsonObject): string =>
  `sha256:${createHash("sha256")
    .update(canonicalize(schema) ?? "null")
    .digest("hex")}`;

export const sampleSchema = (): JsonObject => ({
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1 },
  },
});

export const sampleBinding = (
  overrides: Partial<PublishedCapabilityBinding> & { readonly schema?: JsonObject } = {},
): PublishedCapabilityBinding => {
  const schema = overrides.schema ?? sampleSchema();
  return {
    pluginId: "org.openandroidintelligence.sms",
    authorKeyId:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capabilityId: "org.openandroidintelligence.sms.query",
    capabilityVersion: "1.0.0",
    risk: "read",
    ...overrides,
    schema,
    schemaSha256: overrides.schemaSha256 ?? sha256OfSchema(schema),
  };
};

export const samplePublication = (
  overrides: Partial<CapabilityPublication> = {},
): CapabilityPublication => ({
  bindings: [sampleBinding()],
  inventory: [
    {
      pluginId: "org.openandroidintelligence.sms",
      capabilityId: "org.openandroidintelligence.sms.query",
      capabilityVersion: "1.0.0",
      status: "READY",
      reason: "",
    },
    {
      pluginId: "org.openandroidintelligence.sms",
      capabilityId: "org.openandroidintelligence.sms.send",
      capabilityVersion: "1.0.0",
      status: "ANDROID_PERMISSION_REQUIRED",
      reason: "READ_SMS_REQUIRED",
    },
  ],
  grantRevision: GRANT_REVISION,
  updatedAt: FIXED_NOW.toISOString(),
  ...overrides,
});

export interface EmittedEvent {
  readonly accountId: string;
  readonly type: string;
  readonly payload: JsonObject;
}

export interface HarnessClock {
  now: Date;
}

export interface Harness {
  readonly rootDir: string;
  readonly service: DeviceCapabilityService;
  readonly events: EmittedEvent[];
  readonly warnings: string[];
  readonly clock: HarnessClock;
  readonly store: (accountId?: string) => DeviceRequestStore;
  readonly verified: (overrides?: {
    readonly accountId?: string;
    readonly deviceId?: string;
    readonly pairingGeneration?: number;
    readonly requestId?: string;
  }) => VerifiedRequest;
  readonly cleanup: () => void;
}

/**
 * 每个测试独立的临时目录 + 真实 SQLite 存储 + 假事件发射器 + 可控时钟。
 * 临时目录只在 `os.tmpdir()` 下创建，结束后自清理。
 */
export const createHarness = (): Harness => {
  const rootDir = createTempDir("device-service-");
  const events: EmittedEvent[] = [];
  const warnings: string[] = [];
  const clock: HarnessClock = { now: new Date(FIXED_NOW) };
  const stores = new Map<string, DeviceRequestStore>();

  const store = (accountId: string = ACCOUNT_ID): DeviceRequestStore => {
    const cached = stores.get(accountId);
    if (cached !== undefined) return cached;
    const dir = join(rootDir, "accounts", accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const created = new DeviceRequestStore(join(dir, "device-requests.db"));
    stores.set(accountId, created);
    return created;
  };

  const options: DeviceCapabilityServiceOptions = {
    storeFor: (accountId) => store(accountId),
    emit: (accountId, type, payload) => {
      events.push({ accountId, type, payload });
    },
    now: () => new Date(clock.now),
    logger: {
      info: () => undefined,
      warn: (message) => {
        warnings.push(message);
      },
      error: (message) => {
        warnings.push(message);
      },
    },
  };

  const service = new DeviceCapabilityService(options);

  const verified = (overrides: {
    readonly accountId?: string;
    readonly deviceId?: string;
    readonly pairingGeneration?: number;
    readonly requestId?: string;
  } = {}): VerifiedRequest => {
    const accountId = overrides.accountId ?? ACCOUNT_ID;
    const deviceId = overrides.deviceId ?? DEVICE_ID;
    const pairingGeneration = overrides.pairingGeneration ?? PAIRING_GENERATION;
    const requestId = overrides.requestId ?? "req_test";
    return {
      method: "POST",
      target: "/open-android-intelligence/v2/device-requests/request/claim",
      path: "/open-android-intelligence/v2/device-requests/request/claim",
      query: new URLSearchParams(),
      requestId,
      correlationId: requestId,
      accountId,
      deviceId,
      sessionId: "sess_test",
      device: {
        deviceId,
        installationId: "install_test",
        publicKey: "A".repeat(43),
        displayName: "Pixel Test",
        pairingId: "pair_test",
        pairingGeneration,
        pairedAt: FIXED_NOW.toISOString(),
        revokedAt: null,
      },
      body: new Uint8Array(),
      bodyText: "",
      json: null,
      idempotencyKey: null,
      contentType: null,
      contentLength: null,
      headers: [],
    };
  };

  const cleanup = (): void => {
    service.close();
    removeTempDir(rootDir);
  };

  return { rootDir, service, events, warnings, clock, store, verified, cleanup };
};

/** 轮询等待异步路径发射的事件（createRequest 内部会 await resolver）。 */
export const waitForEvent = async (
  harness: Pick<Harness, "events">,
  type: string = DEVICE_REQUESTED_EVENT,
): Promise<EmittedEvent> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = harness.events.filter((candidate) => candidate.type === type).at(-1);
    if (event !== undefined) return event;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`event ${type} was not emitted`);
};

export const requestInput = (options: {
  readonly signal: AbortSignal;
  readonly risk?: CapabilityRisk;
  readonly capabilityId?: string;
  readonly capabilityVersion?: string;
  readonly parameters?: JsonObject;
  readonly grantRevision?: number;
  readonly pairingGeneration?: number;
  readonly conversationId?: string;
}): {
  accountId: string;
  conversationId: string;
  device: { deviceId: string; pairingGeneration: number };
  capability: { id: string; version: string };
  provider: { pluginId: string; authorKeyId: string };
  parameters: JsonObject;
  risk: CapabilityRisk;
  grantRevision: number;
  requiresForegroundConfirmation: boolean;
  signal: AbortSignal;
} => ({
  accountId: ACCOUNT_ID,
  conversationId: options.conversationId ?? CONVERSATION_ID,
  device: {
    deviceId: DEVICE_ID,
    pairingGeneration: options.pairingGeneration ?? PAIRING_GENERATION,
  },
  capability: {
    id: options.capabilityId ?? "org.openandroidintelligence.sms.query",
    version: options.capabilityVersion ?? "1.0.0",
  },
  provider: {
    pluginId: "org.openandroidintelligence.sms",
    authorKeyId:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  parameters: options.parameters ?? { query: "from:alice" },
  risk: options.risk ?? "read",
  grantRevision: options.grantRevision ?? GRANT_REVISION,
  requiresForegroundConfirmation: false,
  signal: options.signal,
});

export const makeStoredRecord = (
  overrides: Partial<DeviceRequestRecord> & {
    readonly requestId: string;
    readonly expiresAt: string;
  },
): DeviceRequestRecord => ({
  conversationId: CONVERSATION_ID,
  deviceId: DEVICE_ID,
  pairingGeneration: PAIRING_GENERATION,
  capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" },
  provider: {
    pluginId: "org.openandroidintelligence.sms",
    authorKeyId:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  parameters: { query: "from:alice" },
  risk: "read",
  grantRevision: GRANT_REVISION,
  requiresForegroundConfirmation: false,
  state: "pending",
  claimId: null,
  result: null,
  errorCode: null,
  createdAt: FIXED_NOW.toISOString(),
  ...overrides,
});
