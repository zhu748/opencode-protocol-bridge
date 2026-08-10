import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_IMAGE_HANDOFF_MODELS } from '../src/config.js';

const projectDirectory = resolve(import.meta.dirname, '..');
const loadConfigScript = "import('./src/config.js').then(({ loadConfig }) => loadConfig())";
const loadConfigPrintImagesScript = "import('./src/config.js').then(async ({ loadConfig }) => console.log(JSON.stringify((await loadConfig()).imageHandoffModels)))";
const saveUnsupportedVersionScript = "import('./src/config.js').then(({ saveConfig }) => saveConfig({ version: 2 }))";
const saveOversizedConfigScript = `import('./src/config.js').then(({ saveConfig }) => {
  const longProxy = \`http://user:\${'p'.repeat(4000)}@127.0.0.1:8080\`;
  const credentials = Array.from({ length: 32 }, (_, index) => ({
    id: \`\${String(index).padStart(2, '0')}-\${'s'.repeat(61)}\`,
    name: \`\${String(index).padStart(2, '0')}-\${'n'.repeat(61)}\`,
    apiKey: 'k'.repeat(4096), proxyUrl: longProxy
  }));
  const promptRewriteRules = Array.from({ length: 8 }, (_, index) => ({
    id: \`rule-\${index}\`, name: \`\${index}-\${'r'.repeat(98)}\`, find: \`f\${index}\`, replace: 'x'.repeat(128 * 1024 - 2)
  }));
  const modelRoutes = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
    \`\${String(index).padStart(3, '0')}-\${'m'.repeat(252)}\`,
    { provider: 'zen', protocol: 'responses', upstreamModel: \`\${String(index).padStart(3, '0')}-\${'u'.repeat(252)}\`, toolChoiceFallback: 'auto' }
  ]));
  const imageHandoffModels = Array.from({ length: 500 }, (_, index) => ({
    provider: index % 2 ? 'go' : 'zen', model: \`\${String(index).padStart(3, '0')}-\${'i'.repeat(252)}\`
  }));
  const apiClients = Array.from({ length: 100 }, (_, index) => ({
    id: index.toString(16).padStart(16, '0'), name: \`\${String(index).padStart(3, '0')}-\${'c'.repeat(60)}\`,
    tokenHash: 'a'.repeat(43), tokenPrefix: \`ocb\${index}\`, enabled: true,
    maxConcurrentRequests: 1000, createdAt: '2026-08-05T00:00:00.000Z'
  }));
  return saveConfig({
    password: 'p'.repeat(512), sessionSecret: 's'.repeat(512), clientToken: 't'.repeat(256),
    zenKey: 'z'.repeat(4096), goKey: 'g'.repeat(4096),
    proxyUrl: longProxy, zenProxyUrl: longProxy, goProxyUrl: longProxy,
    zenCredentials: credentials, goCredentials: credentials,
    promptRewriteRules, modelRoutes, imageHandoffModels, apiClients
  });
})`;

test('配置加载拒绝超过 2 MiB 的文件并返回明确诊断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-limit-test-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const result = await runConfigLoader(file);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /配置文件超过 2 MiB 安全上限/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置加载拒绝字符串中的无效 UTF-8 而不是静默替换', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-utf8-test-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    const result = await runConfigLoader(file);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /配置文件不是有效的 UTF-8 文件/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置加载会移除上次异常退出遗留的固定临时副本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-recovery-test-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, '{}\n', 'utf8');
    await writeFile(`${file}.tmp`, 'stale-plaintext-secret', 'utf8');
    const result = await runConfigLoader(file);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(`${file}.tmp`, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置加载会迁移上一版未修改的图片交接默认项', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-image-migration-test-'));
  const file = join(directory, 'config.json');
  try {
    const imageHandoffModels = ['zen', 'go'].flatMap((provider) => [
      { provider, model: 'deepseek-v4-flash' },
      { provider, model: 'deepseek-v4-flash-free' }
    ]);
    await writeFile(file, `${JSON.stringify({ imageHandoffModels })}\n`, 'utf8');
    const result = await runConfigLoader(file, loadConfigPrintImagesScript);
    assert.equal(result.code, 0, result.stderr);
    const migrated = JSON.parse(result.stdout.trim());
    assert.deepEqual(migrated, DEFAULT_IMAGE_HANDOFF_MODELS);
    assert.ok(migrated.some((entry) => entry.provider === 'go' && entry.model === 'qwen3.7-max'));
    assert.ok(!migrated.some((entry) => entry.provider === 'go' && entry.model === 'minimax-m3'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置加载拒绝可能绕过运行时限制的损坏字段类型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-validation-test-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, '{"maxConcurrentRequests":"unlimited"}\n', 'utf8');
    const result = await runConfigLoader(file);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /最大并发请求必须是 1–1000 的整数/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置保存不会静默覆盖调用方传入的未知版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-version-test-'));
  const file = join(directory, 'config.json');
  try {
    const result = await runConfigLoader(file, saveUnsupportedVersionScript);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /不支持的配置版本：2/);
    await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置保存拒绝生成下次启动无法读取的超大文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-config-save-limit-test-'));
  const file = join(directory, 'config.json');
  try {
    const result = await runConfigLoader(file, saveOversizedConfigScript);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /配置序列化后超过 2 MiB 安全上限/);
    await assert.rejects(readFile(file, 'utf8'), (error) => error.code === 'ENOENT');
    await assert.rejects(readFile(`${file}.tmp`, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runConfigLoader(file, script = loadConfigScript) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: projectDirectory,
    env: { ...process.env, CONFIG_FILE: file, CONFIG_ENCRYPTION_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}
