import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const MAGIC = Buffer.from("OAIGW1\r\n", "ascii");
const CHUNK_BYTES = 64 * 1024;
const HEADER_BYTES = 4 + 4 + 12; // index + plainLen + nonce
const TAG_BYTES = 16;

const deriveKey = (masterKey: Buffer, accountId: string, attachmentId: string): Buffer =>
  Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(accountId, "utf8"),
      Buffer.from(`open-android-intelligence/attachment/v1/${attachmentId}`, "utf8"),
      32,
    ),
  );

const aadOf = (accountId: string, attachmentId: string, index: number, length: number): Buffer =>
  Buffer.from(`OAIGW1\u0000${accountId}\u0000${attachmentId}\u0000${index}\u0000${length}`, "utf8");

export interface StoredAttachmentBytes {
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * 附件暂存区的加密存储。
 *
 * 契约 §13 要求暂存字节加密、TTL 后删除；算法未强制，这里用每附件派生的
 * AES-256-GCM 分块（64 KiB），每块独立 nonce 与 AAD，避免整文件读入内存。
 * 文件头带 magic，读到未知格式 fail-closed。
 */
export class AttachmentStorage {
  readonly #accountId: string;
  readonly #masterKey: Buffer;
  readonly #directory: string;

  constructor(options: { accountId: string; masterKey: Buffer; directory: string }) {
    this.#accountId = options.accountId;
    this.#masterKey = options.masterKey;
    this.#directory = options.directory;
    if (!existsSync(this.#directory)) mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
  }

  pathFor(attachmentId: string): string {
    return join(this.#directory, `${attachmentId}.oaigw`);
  }

  /** 把字节流加密写入正式路径（先写 `.stage` 再原子 rename）。 */
  async write(attachmentId: string, source: AsyncIterable<Uint8Array>): Promise<StoredAttachmentBytes> {
    const finalPath = this.pathFor(attachmentId);
    const stagePath = `${finalPath}.${process.pid}.stage`;
    const key = deriveKey(this.#masterKey, this.#accountId, attachmentId);
    const fd = openSync(stagePath, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    let pending = Buffer.alloc(0);
    let index = 0;

    const writeChunk = (plain: Buffer): void => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aadOf(this.#accountId, attachmentId, index, plain.length));
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32BE(index, 0);
      header.writeUInt32BE(plain.length, 4);
      nonce.copy(header, 8);
      writeSync(fd, header);
      writeSync(fd, ciphertext);
      writeSync(fd, tag);
      index += 1;
    };

    try {
      writeSync(fd, MAGIC);
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        hash.update(bytes);
        total += bytes.length;
        pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
        while (pending.length >= CHUNK_BYTES) {
          writeChunk(pending.subarray(0, CHUNK_BYTES));
          pending = pending.subarray(CHUNK_BYTES);
        }
      }
      if (pending.length > 0) writeChunk(pending);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagePath, finalPath);
    return { storagePath: finalPath, sizeBytes: total, sha256: hash.digest("hex") };
  }

  /** 解密读取为块流。读取失败（篡改/截断）抛错而不是返回半文件。 */
  async *read(storagePath: string, attachmentId: string): AsyncGenerator<Uint8Array> {
    const key = deriveKey(this.#masterKey, this.#accountId, attachmentId);
    const fd = openSync(storagePath, "r");
    try {
      const magic = Buffer.alloc(MAGIC.length);
      readExact(fd, magic, 0);
      if (!magic.equals(MAGIC)) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE:bad-magic");
      let offset = MAGIC.length;
      const header = Buffer.alloc(HEADER_BYTES);
      while (true) {
        const headerRead = readUpTo(fd, header, offset);
        if (headerRead === 0) break;
        if (headerRead !== HEADER_BYTES) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE:truncated-header");
        offset += HEADER_BYTES;
        const index = header.readUInt32BE(0);
        const length = header.readUInt32BE(4);
        const nonce = header.subarray(8, 20);
        if (length === 0 || length > CHUNK_BYTES) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE:bad-length");
        const ciphertext = Buffer.alloc(length);
        readExact(fd, ciphertext, offset);
        offset += length;
        const tag = Buffer.alloc(TAG_BYTES);
        readExact(fd, tag, offset);
        offset += TAG_BYTES;
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aadOf(this.#accountId, attachmentId, index, length));
        decipher.setAuthTag(tag);
        yield Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      }
    } finally {
      closeSync(fd);
    }
  }

  async readAll(storagePath: string, attachmentId: string): Promise<{ bytes: Buffer; sha256: string }> {
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    for await (const chunk of this.read(storagePath, attachmentId)) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      chunks.push(bytes);
    }
    return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
  }

  /** 删除暂存字节；文件不存在视为成功（幂等清理）。 */
  remove(storagePath: string): void {
    try {
      // 运行时清理暂存文件是契约 §8/§13 的要求；路径只可能是本账号暂存目录内的文件。
      unlinkSync(storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const readExact = (fd: number, buffer: Buffer, position: number): void => {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE:unexpected-eof");
    offset += read;
  }
};

const readUpTo = (fd: number, buffer: Buffer, position: number): number => {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return offset;
};

/** 供 core 使用的文件流构造（HTTP 层已把 body 落到临时文件）。 */
export const fileStream = (path: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const stream = createReadStream(path);
    for await (const chunk of stream) {
      yield chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    }
  },
});
