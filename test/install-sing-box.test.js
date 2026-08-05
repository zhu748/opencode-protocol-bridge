import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const projectDir = resolve(import.meta.dirname, '..');

test('install-sing-box 脚本可从指定下载 URL 解包到安装目录', async (t) => {
  if (!await commandAvailable('tar')) return t.skip('tar 不可用');
  const executableName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const sourceExecutable = resolve(projectDir, 'vendor', 'sing-box', executableName);
  try { await access(sourceExecutable); }
  catch { return t.skip('项目内未安装 sing-box'); }
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-install-sing-box-'));
  const archivePath = join(temporary, process.platform === 'win32' ? 'fake-sing-box.zip' : 'fake-sing-box.tar.gz');
  const sourceDirectory = join(temporary, 'source', 'sing-box-1.13.16-test');
  const installDirectory = join(temporary, 'install');
  await mkdir(sourceDirectory, { recursive: true });
  await cp(sourceExecutable, join(sourceDirectory, executableName));
  await run('tar', process.platform === 'win32'
    ? ['-acf', archivePath, '-C', join(temporary, 'source'), '.']
    : ['-czf', archivePath, '-C', join(temporary, 'source'), '.']);
  const archiveSha256 = await fileSha256(archivePath);

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(archivePath).pipe(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(process.execPath, [resolve(projectDir, 'scripts/install-sing-box.mjs')], {
      cwd: projectDir,
      env: {
        ...process.env,
        OPENCODE_BRIDGE_SING_BOX_DOWNLOAD_URL: `http://127.0.0.1:${server.address().port}/sing-box`,
        OPENCODE_BRIDGE_SING_BOX_INSTALL_DIR: installDirectory,
        OPENCODE_BRIDGE_SING_BOX_VERSION: '1.13.16',
        OPENCODE_BRIDGE_SING_BOX_FLAVOR: 'glibc',
        OPENCODE_BRIDGE_SING_BOX_SHA256: archiveSha256
      }
    });
    const installed = join(installDirectory, executableName);
    await access(installed);
    assert.equal(await fileSha256(installed), await fileSha256(sourceExecutable));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('install-sing-box 使用自定义下载 URL 时强制要求 SHA-256', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-install-sing-box-sha-'));
  const env = {
    ...process.env,
    OPENCODE_BRIDGE_SING_BOX_DOWNLOAD_URL: 'https://mirror.invalid/sing-box',
    OPENCODE_BRIDGE_SING_BOX_INSTALL_DIR: join(temporary, 'install'),
    OPENCODE_BRIDGE_SING_BOX_VERSION: '1.13.16'
  };
  delete env.OPENCODE_BRIDGE_SING_BOX_SHA256;
  try {
    await assert.rejects(
      run(process.execPath, [resolve(projectDir, 'scripts/install-sing-box.mjs')], { cwd: projectDir, env }),
      /必须设置 OPENCODE_BRIDGE_SING_BOX_SHA256/
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function commandAvailable(command) {
  try {
    await run(command, ['--version']);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096); });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} 退出码 ${code}${stderr ? `：${stderr.replace(/\s+/g, ' ').trim()}` : ''}`));
    });
  });
}
