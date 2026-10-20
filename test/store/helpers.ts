import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** 在系统临时目录创建一个独立测试目录（mkdtemp 自动 0700）。 */
export const createTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/**
 * 清理测试自建临时目录。
 *
 * 项目规范禁止删除仓库文件；这里只对测试自己在 `os.tmpdir()` 下通过 mkdtemp
 * 创建的目录做递归清理，并先断言目标确实位于系统临时目录内，绝不触碰仓库内容。
 */
export const removeTempDir = (dir: string): void => {
  const target = resolve(dir);
  const tempRoot = resolve(tmpdir());
  if (!target.startsWith(tempRoot + sep)) {
    throw new Error(`拒绝清理系统临时目录之外的路径：${target}`);
  }
  rmSync(target, { recursive: true, force: true });
};
