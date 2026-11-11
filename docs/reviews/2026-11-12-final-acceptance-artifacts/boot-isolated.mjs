import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 使用已安装 DSH 的官方启动模块，不经过会落完整异常诊断的 CLI 错误分支。
const [dshBin, overlay] = process.argv.slice(2);
try {
  const dshRequire = createRequire(dshBin);
  const { runProfile } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh/profile-boot')).href);
  const { loadLayeredEnv } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [overlay],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
  });
} catch (error) {
  // 不输出异常正文、请求头或请求内容；上层只需阶段与稳定错误码。
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(error.code)
    ? error.code : 'DSH_STARTUP_FAILED';
  process.stderr.write(JSON.stringify({ stage: 'boot', code: safeCode, errorType: error?.constructor?.name }) + '\n');
  process.exitCode = 1;
}
