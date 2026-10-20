import { createPublicKey, verify as verifySignature } from "node:crypto";

import { coreSchemaHash } from "../../contract/src/core-schema-hash.js";
import {
  canonicalRequestSignatureInput,
  canonicalRequestTarget,
  type SignedRequestInput,
} from "../../contract/src/request-signature.js";
import {
  schemaFor,
  validateGatewayValue,
  type GatewaySchemaName,
} from "../../contract/src/schema-registry.js";
import {
  joinMessageBatch,
  maximumDeviceRequestQueueSeconds,
  nextAttachmentState,
  nextDeviceRequestState,
  nextGenerationState,
} from "../../contract/src/state-machines.js";

export {
  canonicalRequestSignatureInput,
  canonicalRequestTarget,
  joinMessageBatch,
  maximumDeviceRequestQueueSeconds,
  nextAttachmentState,
  nextDeviceRequestState,
  nextGenerationState,
  schemaFor,
  validateGatewayValue,
};
export type { GatewaySchemaName, SignedRequestInput };

/**
 * 契约 §4 的 core Schema 摘要。值在模块加载时从随包快照计算，
 * 与手机端使用同一份文件字节，因此两边得到同一个数。
 */
export const CORE_SCHEMA_HASH: string = coreSchemaHash();

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 严格解码 canonical unpadded base64url；长度不符即返回 undefined。 */
export const decodeCanonicalBase64Url = (value: string, byteLength: number): Buffer | undefined => {
  if (typeof value !== "string" || !BASE64URL.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== byteLength) return undefined;
  if (decoded.toString("base64url") !== value) return undefined;
  return decoded;
};

/**
 * 用设备 Ed25519 公钥验证请求签名。
 * 公钥是契约的 canonical unpadded base64url 32 字节形式。
 */
export const verifyEd25519Signature = (
  publicKeyBase64Url: string,
  message: Uint8Array,
  signatureBase64Url: string,
): boolean => {
  const keyBytes = decodeCanonicalBase64Url(publicKeyBase64Url, 32);
  const signature = decodeCanonicalBase64Url(signatureBase64Url, 64);
  if (keyBytes === undefined || signature === undefined) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, message, key, signature);
  } catch {
    return false;
  }
};

/** 校验并返回 false 时抛出契约错误码的便捷包装。 */
export const isSchemaValid = (name: GatewaySchemaName, value: unknown): boolean =>
  validateGatewayValue(name, value).ok;

export const requireSchema = (name: GatewaySchemaName, value: unknown): void => {
  const result = validateGatewayValue(name, value);
  if (!result.ok) {
    throw new Error(`SCHEMA_INVALID:${name}`);
  }
};
