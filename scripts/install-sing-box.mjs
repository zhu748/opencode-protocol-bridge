import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '1.13.16';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const OFFICIAL_DIGESTS = new Map([
  ['sing-box-1.13.16-darwin-amd64.tar.gz', '2bfad58d034e280c773e194be03649555e5a7040c48b559dd0898ad293fe793d'],
  ['sing-box-1.13.16-darwin-arm64.tar.gz', '32fa21fd75ad62d86a2dcb7e0be77359c35e12798cdbb6a0e30654ef487d90d6'],
  ['sing-box-1.13.16-linux-amd64-glibc.tar.gz', '1c2d3fb2294a5d4ff32d9f5b82052cd70ba4264b0d7b000ef12e3e927f77ce1e'],
  ['sing-box-1.13.16-linux-amd64-musl.tar.gz', '9ff0345fde4157a6bdab45a615668d41ccc93f6d0f361108042a48b8a49a9baa'],
  ['sing-box-1.13.16-linux-amd64.tar.gz', 'e37c312859dfa84cba148f41072ff6369f08361ae91d622dc1fd3aab49611a8d'],
  ['sing-box-1.13.16-linux-arm64-glibc.tar.gz', '1e73046abb8d3560275997f1a4e7d0220b2d6a6e35d403514349213511ae2e2a'],
  ['sing-box-1.13.16-linux-arm64-musl.tar.gz', '3ea951c68f2eea10fd3ee8f8cc7794c12ccc7405afa99279a79e0b41cb183adf'],
  ['sing-box-1.13.16-linux-arm64.tar.gz', 'd587fb00bdc3c044227f35d15d154f271bc75108475091eda2542e4b82bb2949'],
  ['sing-box-1.13.16-windows-amd64.zip', '6cbf90ec4ee87122ffce09b73928fb31e763bc1c75a119f79c61d24734c78807'],
  ['sing-box-1.13.16-windows-arm64.zip', '8412e9751a776a1cd5138fde8a6b60784af91b0fe596cba1b6efcd05144ef511']
]);

await main();

async function main() {
  const version = cleanVersion(process.env.OPENCODE_BRIDGE_SING_BOX_VERSION || process.env.SING_BOX_VERSION || DEFAULT_VERSION);
  const installDirectory = resolve(ROOT, process.env.OPENCODE_BRIDGE_SING_BOX_INSTALL_DIR || 'vendor/sing-box');
  const executableName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const targetExecutable = join(installDirectory, executableName);
  const currentVersion = await executableVersion(targetExecutable).catch(() => '');
  if (currentVersion === version) {
    console.log(`sing-box ${version} 已存在：${targetExecutable}`);
    return;
  }
  if (currentVersion) console.log(`sing-box 当前版本 ${currentVersion}，准备更新到 ${version}`);

  const asset = assetName(version);
  const customDownloadUrl = String(process.env.OPENCODE_BRIDGE_SING_BOX_DOWNLOAD_URL || '').trim();
  const downloadUrl = customDownloadUrl || `https://github.com/SagerNet/sing-box/releases/download/v${version}/${asset}`;
  const expectedSha256 = await expectedArchiveSha256(version, asset, customDownloadUrl);
  await mkdir(resolve(installDirectory, '..'), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(resolve(installDirectory, '..'), '.sing-box-'));
  const archivePath = join(temporaryDirectory, asset);
  const extractDirectory = join(temporaryDirectory, 'extract');
  const stagedExecutable = join(temporaryDirectory, executableName);
  await mkdir(extractDirectory, { recursive: true });

  try {
    console.log(`下载 sing-box ${version}${customDownloadUrl ? '（自定义下载地址）' : `：${downloadUrl}`}`);
    await download(downloadUrl, archivePath);
    await verifyArchiveSha256(archivePath, expectedSha256);
    await verifyArchiveEntries(archivePath);
    await run('tar', archiveArgs(asset, archivePath, extractDirectory));
    const extracted = await findExecutable(extractDirectory, executableName);
    await cp(extracted, stagedExecutable, { force: true });
    if (process.platform !== 'win32') await chmod(stagedExecutable, 0o755);
    const extractedVersion = await executableVersion(stagedExecutable);
    if (extractedVersion !== version) throw new Error(`下载包中的 sing-box 版本为 ${extractedVersion || '未知'}，期望 ${version}`);
    await mkdir(installDirectory, { recursive: true });
    await cp(stagedExecutable, targetExecutable, { force: true });
    if (process.platform !== 'win32') await chmod(targetExecutable, 0o755);
    console.log(`sing-box ${version} 已安装：${targetExecutable}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function cleanVersion(value) {
  const versionText = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(versionText)) throw new Error('sing-box 版本号无效');
  return versionText;
}

function assetName(versionText) {
  const platform = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!platform || !arch) throw new Error(`当前平台暂不支持自动安装 sing-box：${process.platform}/${process.arch}`);
  if (process.platform === 'win32') return `sing-box-${versionText}-${platform}-${arch}.zip`;
  if (process.platform === 'linux') {
    const flavor = String(process.env.OPENCODE_BRIDGE_SING_BOX_FLAVOR || '').trim().toLowerCase() || detectLinuxFlavor();
    if (!['glibc', 'musl', 'purego'].includes(flavor)) throw new Error('OPENCODE_BRIDGE_SING_BOX_FLAVOR 仅支持 glibc、musl 或 purego');
    return `sing-box-${versionText}-${platform}-${arch}${flavor === 'purego' ? '' : `-${flavor}`}.tar.gz`;
  }
  return `sing-box-${versionText}-${platform}-${arch}.tar.gz`;
}

function detectLinuxFlavor() {
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
  return glibc ? 'glibc' : 'musl';
}

function archiveArgs(asset, source, destination) {
  const flags = asset.endsWith('.zip') ? ['-xf'] : ['-xzf'];
  if (process.platform === 'win32') {
    return ['--force-local', ...flags, source.replaceAll('\\', '/'), '-C', destination.replaceAll('\\', '/')];
  }
  return [...flags, source, '-C', destination];
}

async function expectedArchiveSha256(version, asset, customDownloadUrl) {
  const configured = normalizeSha256(process.env.OPENCODE_BRIDGE_SING_BOX_SHA256 || '');
  if (configured) return configured;
  if (customDownloadUrl) throw new Error('使用自定义 sing-box 下载地址时必须设置 OPENCODE_BRIDGE_SING_BOX_SHA256');
  if (OFFICIAL_DIGESTS.has(asset)) return OFFICIAL_DIGESTS.get(asset);
  const response = await fetch(`https://api.github.com/repos/SagerNet/sing-box/releases/tags/v${encodeURIComponent(version)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'opencode-protocol-bridge' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`读取 sing-box 发布摘要失败：HTTP ${response.status}`);
  const release = await response.json();
  const digest = release.assets?.find((item) => item?.name === asset)?.digest || '';
  const sha256 = normalizeSha256(digest);
  if (!sha256) throw new Error(`sing-box ${version} 的 ${asset} 缺少 SHA-256 摘要`);
  return sha256;
}

function normalizeSha256(value) {
  const digest = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
  if (!digest) return '';
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('OPENCODE_BRIDGE_SING_BOX_SHA256 必须是 64 位十六进制摘要');
  return digest;
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'opencode-protocol-bridge' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok || !response.body) throw new Error(`下载 sing-box 失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error('sing-box 下载包超过 256 MiB 上限');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      callback(received > MAX_ARCHIVE_BYTES ? new Error('sing-box 下载包超过 256 MiB 上限') : null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination));
}

async function verifyArchiveSha256(path, expected) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expected) throw new Error(`sing-box 下载包 SHA-256 校验失败：期望 ${expected}，实际 ${actual}`);
}

async function verifyArchiveEntries(path) {
  const args = process.platform === 'win32'
    ? ['--force-local', '-tf', path.replaceAll('\\', '/')]
    : ['-tf', path];
  const { stdout } = await run('tar', args, { capture: true });
  for (const entry of stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`sing-box 压缩包包含不安全路径：${entry.slice(0, 256)}`);
    }
  }
}

async function executableVersion(executable) {
  const { stdout } = await run(executable, ['version'], { capture: true });
  return stdout.match(/sing-box version\s+([^\s]+)/i)?.[1]?.replace(/^v/i, '') || '';
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096); });
    child.once('error', (error) => rejectRun(new Error(`执行 ${command} 失败：${error.message}`)));
    child.once('exit', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`${command} 退出码 ${code}${stderr ? `：${stderr.replace(/\s+/g, ' ').trim()}` : ''}`));
    });
  });
}

async function findExecutable(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(path, name).catch(() => '');
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return path;
    }
  }
  throw new Error('sing-box 压缩包中未找到可执行文件');
}
