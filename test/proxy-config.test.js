import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { listModels } from '../src/upstream.js';
import { closeProxyDispatchers, normalizeProxyUrl, providerProxyUrl, proxyDispatcher, proxyDispatcherForUrl, singBoxRuntimeStatus } from '../src/proxy.js';
import { buildManagedTunnelConfig } from '../src/tunnel-proxy.js';

const TEST_UUID = 'bf000d23-0752-40b4-affe-68f7707a9661';

test('代理地址支持 HTTP、HTTPS、SOCKS4/4a/5/5h、省略协议和托管隧道分享链接', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('mixed://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('mixed://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890/');
  for (const protocol of ['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    assert.match(normalizeProxyUrl(`${protocol}://user:pass@127.0.0.1:1080`), new RegExp(`^${protocol}:`));
  }
  const vmessPayload = Buffer.from(JSON.stringify({ add: 'example.com', port: 443, id: TEST_UUID, aid: 0, scy: 'auto', net: 'ws', host: 'cdn.example.com', path: '/ws', tls: 'tls', sni: 'example.com' })).toString('base64url');
  for (const proxyUrl of [
    `tuic://${TEST_UUID}:secret@example.com:443?sni=example.com&congestion_control=bbr`,
    `vless://${TEST_UUID}@example.com:443?security=reality&pbk=public-key&sid=abcd&type=tcp&flow=xtls-rprx-vision`,
    `vmess://${vmessPayload}`,
    'trojan://password@example.com:443?sni=example.com&type=ws&path=%2Fws',
    'ss://YWVzLTI1Ni1nY206cGFzcw@example.com:8388',
    'hysteria2://password@example.com:443?sni=example.com',
    'hy2://password@example.com:443?obfs=salamander&obfs-password=secret',
    'hysteria://example.com:443?auth=secret&upmbps=20&downmbps=50'
  ]) {
    assert.equal(normalizeProxyUrl(proxyUrl), proxyUrl);
  }
  assert.throws(() => normalizeProxyUrl('ftp://127.0.0.1:21'), /仅支持/);
  assert.throws(() => normalizeProxyUrl('ssr://example'), /ShadowsocksR 分享链接暂不支持内置托管/);
  assert.throws(() => normalizeProxyUrl('vless://example.com:443?type=tcp'), /VLESS 分享链接无效.*缺少 uuid/);
  assert.throws(() => normalizeProxyUrl('vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9'), /VMess 分享链接无效/);
  assert.throws(() => normalizeProxyUrl('socks5://127.0.0.1:0'), /1–65535/);
  assert.throws(() => normalizeProxyUrl('mixed://127.0.0.1:7890/path'), /不能包含路径/);
  assert.throws(() => normalizeProxyUrl('http://127.0.0.1:7890/path'), /不能包含路径/);
  assert.throws(() => normalizeProxyUrl('socks5://user:%zz@127.0.0.1:1080'), /百分号编码/);
});

test('每个 Key 优先使用独立代理并回退到默认代理', () => {
  const config = { proxyUrl: 'http://default:7890', zenProxyUrl: 'socks5://zen:1080', goProxyUrl: '' };
  assert.equal(providerProxyUrl(config, 'zen'), 'socks5://zen:1080');
  assert.equal(providerProxyUrl(config, 'go'), 'http://default:7890');
  assert.equal(proxyDispatcher('socks5://127.0.0.1:1080'), proxyDispatcher('socks5://127.0.0.1:1080'));
});

test('VMess JSON 会将 WebSocket 路径中的 Xray early data 转为 sing-box 字段', () => {
  const payload = (overrides = {}) => `vmess://${Buffer.from(JSON.stringify({
    add: 'example.com', port: 443, id: TEST_UUID, aid: 0, scy: 'auto', net: 'ws',
    host: 'cdn.example.com', path: '/vmess-argo?ed=2560&token=one', tls: 'tls', sni: 'cdn.example.com',
    ...overrides
  })).toString('base64url')}`;
  const outbound = buildManagedTunnelConfig(payload(), 29080).outbounds[0];
  assert.equal(outbound.transport.path, '/vmess-argo?token=one');
  assert.equal(outbound.transport.max_early_data, 2560);
  assert.equal(outbound.transport.early_data_header_name, 'Sec-WebSocket-Protocol');

  const explicit = buildManagedTunnelConfig(payload({ path: '/vmess-argo', ed: 2048, eh: 'X-Early-Data' }), 29080).outbounds[0];
  assert.equal(explicit.transport.path, '/vmess-argo');
  assert.equal(explicit.transport.max_early_data, 2048);
  assert.equal(explicit.transport.early_data_header_name, 'X-Early-Data');

  assert.throws(() => normalizeProxyUrl(payload({ ed: 2048 })), /early data.*冲突/);
  assert.throws(() => normalizeProxyUrl(payload({ path: '/vmess-argo?ed=1&ed=2' })), /ed 参数不能重复/);
});

test('普通代理 dispatcher 缓存按最近使用顺序淘汰', async () => {
  await closeProxyDispatchers({ force: true });
  try {
    const oldest = proxyDispatcher('http://127.0.0.1:11000');
    const second = proxyDispatcher('http://127.0.0.1:11001');
    for (let index = 2; index < 64; index++) proxyDispatcher(`http://127.0.0.1:${11000 + index}`);

    assert.equal(proxyDispatcher('http://127.0.0.1:11000'), oldest);
    proxyDispatcher('http://127.0.0.1:11064');
    assert.equal(proxyDispatcher('http://127.0.0.1:11000'), oldest);
    assert.notEqual(proxyDispatcher('http://127.0.0.1:11001'), second);
  } finally {
    await closeProxyDispatchers({ force: true });
  }
});

test('sing-box 运行时状态只暴露版本和来源，不暴露可执行文件路径', async () => {
  const previous = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  try {
    const status = await singBoxRuntimeStatus({ refresh: true });
    assert.deepEqual(status, { available: true, version: '9.9.9-test', source: 'environment', errorCode: null });
    assert.doesNotMatch(JSON.stringify(status), /fake-sing-box|test-fixtures|[A-Z]:\\/i);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previous);
    await singBoxRuntimeStatus({ refresh: true });
  }
});

test('托管 sing-box 隧道会生成本地 SOCKS 入口并转发上游请求', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'through-managed-tunnel' }] }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-fake-sing-box-'));
  const capturedConfigPath = join(temporary, 'sing-box-config.json');
  const previousBase = process.env.OPENCODE_ZEN_BASE_URL;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousCapture = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT = capturedConfigPath;
  try {
    const response = await listModels({
      provider: 'zen',
      apiKey: 'test',
      proxyUrl: `vless://${TEST_UUID}@example.com:443?security=reality&pbk=public-key&sid=abcd&type=ws&host=cdn.example.com&path=%2Fws&fp=chrome`,
      timeoutMs: 5000
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, 'through-managed-tunnel');
    const config = JSON.parse(await readFile(capturedConfigPath, 'utf8'));
    assert.equal(config.inbounds[0].type, 'socks');
    assert.equal(config.inbounds[0].listen, '127.0.0.1');
    const outbound = config.outbounds[0];
    assert.equal(outbound.type, 'vless');
    assert.equal(outbound.server, 'example.com');
    assert.equal(outbound.server_port, 443);
    assert.equal(outbound.uuid, TEST_UUID);
    assert.equal(outbound.tls.reality.public_key, 'public-key');
    assert.equal(outbound.tls.reality.short_id, 'abcd');
    assert.equal(outbound.tls.utls.fingerprint, 'chrome');
    assert.equal(outbound.transport.type, 'ws');
    assert.equal(outbound.transport.path, '/ws');
    assert.equal(outbound.transport.headers.Host, 'cdn.example.com');
  } finally {
    if (previousBase === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previousBase;
    if (previousSingBox === undefined) delete process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
    else process.env.OPENCODE_BRIDGE_SING_BOX_PATH = previousSingBox;
    if (previousCapture === undefined) delete process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT;
    else process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT = previousCapture;
    await closeProxyDispatchers({ force: true });
    target.close();
    await once(target, 'close');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('托管隧道意外退出后会清理临时目录并在下次请求自动重建', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'restarted-managed-tunnel' }] }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-exit-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@restart.example.com:443?type=tcp`;
  const previousBase = process.env.OPENCODE_ZEN_BASE_URL;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousExitAfter = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_EXIT_AFTER_MS;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_EXIT_AFTER_MS = '600';
  try {
    const first = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl, timeoutMs: 5000 });
    assert.equal((await first.json()).data[0].id, 'restarted-managed-tunnel');
    const firstPid = Number(await readFile(pidPath, 'utf8'));
    await waitFor(async () => !processAlive(firstPid) && (await managedTempDirectories(proxyUrl)).length === 0, 5000);

    const second = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl, timeoutMs: 5000 });
    assert.equal((await second.json()).data[0].id, 'restarted-managed-tunnel');
    const secondPid = Number(await readFile(pidPath, 'utf8'));
    assert.notEqual(secondPid, firstPid);
  } finally {
    restoreEnvironment('OPENCODE_ZEN_BASE_URL', previousBase);
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_EXIT_AFTER_MS', previousExitAfter);
    await closeProxyDispatchers({ force: true });
    target.close();
    await once(target, 'close');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('关闭正在启动的托管隧道不会遗留子进程或临时配置', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-close-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@closing.example.com:443?type=tcp`;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousListenDelay = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS = '5000';
  try {
    const pending = proxyDispatcherForUrl(proxyUrl);
    const rejected = assert.rejects(pending, /托管隧道代理不可用/);
    await waitFor(async () => Number(await readFile(pidPath, 'utf8').catch(() => '0')) > 0, 3000);
    const pid = Number(await readFile(pidPath, 'utf8'));
    await closeProxyDispatchers({ force: true });
    await rejected;
    await waitFor(async () => !processAlive(pid) && (await managedTempDirectories(proxyUrl)).length === 0, 3000);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS', previousListenDelay);
    await closeProxyDispatchers({ force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('最后一个等待者取消会关闭正在启动的托管隧道', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-abort-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@abort.example.com:443?type=tcp`;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousListenDelay = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS = '5000';
  const controller = new AbortController();
  try {
    const pending = proxyDispatcherForUrl(proxyUrl, { signal: controller.signal });
    await waitFor(async () => Number(await readFile(pidPath, 'utf8').catch(() => '0')) > 0, 3000);
    const pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort(Object.assign(new Error('客户端已断开'), { code: 'CLIENT_CLOSED' }));
    await assert.rejects(pending, (error) => error.code === 'CLIENT_CLOSED');
    await waitFor(async () => !processAlive(pid) && (await managedTempDirectories(proxyUrl)).length === 0, 3000);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS', previousListenDelay);
    await closeProxyDispatchers({ force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('共享隧道仍有等待者时单个取消不会关闭启动进程', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-shared-abort-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@shared-abort.example.com:443?type=tcp`;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousListenDelay = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS = '250';
  const controller = new AbortController();
  try {
    const canceled = proxyDispatcherForUrl(proxyUrl, { signal: controller.signal });
    const retained = proxyDispatcherForUrl(proxyUrl);
    await waitFor(async () => Number(await readFile(pidPath, 'utf8').catch(() => '0')) > 0, 3000);
    const pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort(Object.assign(new Error('客户端已断开'), { code: 'CLIENT_CLOSED' }));
    await assert.rejects(canceled, (error) => error.code === 'CLIENT_CLOSED');
    assert.ok(await retained);
    assert.equal(processAlive(pid), true);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS', previousListenDelay);
    await closeProxyDispatchers({ force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('上游超时覆盖托管隧道启动阶段并清理未就绪进程', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-timeout-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@timeout.example.com:443?type=tcp`;
  const previousBase = process.env.OPENCODE_ZEN_BASE_URL;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousListenDelay = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS;
  process.env.OPENCODE_ZEN_BASE_URL = 'http://127.0.0.1:1';
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS = '5000';
  const started = Date.now();
  try {
    await assert.rejects(
      listModels({ provider: 'zen', apiKey: 'test-key', proxyUrl, timeoutMs: 150 }),
      (error) => error.name === 'TimeoutError'
    );
    assert.ok(Date.now() - started < 2000, '超时不应等待托管隧道自身的 8 秒就绪上限');
    const pid = Number(await readFile(pidPath, 'utf8').catch(() => '0'));
    if (pid) await waitFor(() => !processAlive(pid), 3000);
    await waitFor(async () => (await managedTempDirectories(proxyUrl)).length === 0, 3000);
  } finally {
    restoreEnvironment('OPENCODE_ZEN_BASE_URL', previousBase);
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS', previousListenDelay);
    await closeProxyDispatchers({ force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('sing-box 启动错误不会泄露代理凭据或临时配置路径', async () => {
  const proxyUrl = `tuic://${TEST_UUID}:super-secret@example.com:443?sni=example.com`;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousFailure = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_FAIL_MESSAGE;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_FAIL_MESSAGE = `password=super-secret uuid=${TEST_UUID} ${proxyUrl}`;
  try {
    await assert.rejects(proxyDispatcherForUrl(proxyUrl), (error) => {
      assert.equal(error.code, 'PROXY_TUNNEL_ERROR');
      assert.match(error.message, /sing-box 已退出/);
      assert.doesNotMatch(error.message, /super-secret|bf000d23|tuic:\/\/|opencode-protocol-bridge-tunnel/i);
      assert.match(error.message, /password=••••|已隐藏的代理地址/);
      return true;
    });
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_FAIL_MESSAGE', previousFailure);
    await closeProxyDispatchers({ force: true });
  }
});

test('空闲托管隧道会自动关闭并在后续请求时重建', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-idle-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@idle.example.com:443?type=tcp`;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousIdle = process.env.OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS = '1000';
  try {
    await proxyDispatcherForUrl(proxyUrl);
    const firstPid = Number(await readFile(pidPath, 'utf8'));
    assert.equal(processAlive(firstPid), true);
    await waitFor(async () => !processAlive(firstPid) && (await managedTempDirectories(proxyUrl)).length === 0, 4000);

    await proxyDispatcherForUrl(proxyUrl);
    const secondPid = Number(await readFile(pidPath, 'utf8'));
    assert.notEqual(secondPid, firstPid);
    assert.equal(processAlive(secondPid), true);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS', previousIdle);
    await closeProxyDispatchers({ force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('闲置回收不会关闭仍在传输响应的托管隧道', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"object":"list","data":[');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const temporary = await mkdtemp(join(tmpdir(), 'opencode-bridge-managed-active-idle-'));
  const pidPath = join(temporary, 'pid.txt');
  const proxyUrl = `vless://${TEST_UUID}@active-idle.example.com:443?type=tcp`;
  const previousBase = process.env.OPENCODE_ZEN_BASE_URL;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousPidOut = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT;
  const previousIdle = process.env.OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT = pidPath;
  process.env.OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS = '1000';
  let response;
  try {
    response = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl, timeoutMs: 5000 });
    const pid = Number(await readFile(pidPath, 'utf8'));
    await delay(1300);
    assert.equal(processAlive(pid), true);

    await response.body.cancel();
    await waitFor(async () => !processAlive(pid) && (await managedTempDirectories(proxyUrl)).length === 0, 3500);
  } finally {
    await response?.body?.cancel().catch(() => {});
    restoreEnvironment('OPENCODE_ZEN_BASE_URL', previousBase);
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT', previousPidOut);
    restoreEnvironment('OPENCODE_BRIDGE_MANAGED_TUNNEL_IDLE_MS', previousIdle);
    await closeProxyDispatchers({ force: true });
    target.closeAllConnections();
    target.close();
    await once(target, 'close');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('并发创建达到容量时不会取消已经启动的托管隧道', async () => {
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousLimit = process.env.OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS;
  const previousListenDelay = process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS = '1';
  process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS = '250';
  try {
    const first = proxyDispatcherForUrl(`vless://${TEST_UUID}@first-starting.example.com:443?type=tcp`);
    const second = proxyDispatcherForUrl(`vless://${TEST_UUID}@second-starting.example.com:443?type=tcp`);
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    assert.equal(firstResult.status, 'fulfilled');
    assert.equal(secondResult.status, 'rejected');
    assert.equal(secondResult.reason?.code, 'PROXY_TUNNEL_ERROR');
    assert.match(secondResult.reason?.message || '', /已达到 1 个且全部正在使用/);
  } finally {
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS', previousLimit);
    restoreEnvironment('OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS', previousListenDelay);
    await closeProxyDispatchers({ force: true });
  }
});

test('托管隧道容量不会淘汰仍在传输响应的实例', async () => {
  const responses = new Set();
  const target = createHttpServer((req, res) => {
    responses.add(res);
    res.once('close', () => responses.delete(res));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"object":"list","data":[');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const previousBase = process.env.OPENCODE_ZEN_BASE_URL;
  const previousSingBox = process.env.OPENCODE_BRIDGE_SING_BOX_PATH;
  const previousLimit = process.env.OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  process.env.OPENCODE_BRIDGE_SING_BOX_PATH = fileURLToPath(new URL('../test-fixtures/fake-sing-box.mjs', import.meta.url));
  process.env.OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS = '2';
  const firstProxy = `vless://${TEST_UUID}@active-one.example.com:443?type=tcp`;
  const secondProxy = `vless://${TEST_UUID}@active-two.example.com:443?type=tcp`;
  const thirdProxy = `vless://${TEST_UUID}@waiting.example.com:443?type=tcp`;
  let first;
  let second;
  try {
    first = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl: firstProxy, timeoutMs: 5000 });
    second = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl: secondProxy, timeoutMs: 5000 });
    await assert.rejects(proxyDispatcherForUrl(thirdProxy), /已达到 2 个且全部正在使用/);

    await first.body.cancel();
    let available = null;
    await waitFor(async () => {
      try {
        available = await proxyDispatcherForUrl(thirdProxy);
        return true;
      }
      catch (error) {
        if (error?.code === 'PROXY_TUNNEL_ERROR') return false;
        throw error;
      }
    }, 3000);
    assert.ok(available);
  } finally {
    await first?.body?.cancel().catch(() => {});
    await second?.body?.cancel().catch(() => {});
    restoreEnvironment('OPENCODE_ZEN_BASE_URL', previousBase);
    restoreEnvironment('OPENCODE_BRIDGE_SING_BOX_PATH', previousSingBox);
    restoreEnvironment('OPENCODE_BRIDGE_MAX_MANAGED_TUNNELS', previousLimit);
    await closeProxyDispatchers({ force: true });
    for (const response of responses) response.destroy();
    target.closeAllConnections();
    target.close();
    await once(target, 'close');
  }
});

test('HTTP dispatcher 可以携带认证并实际转发模型请求', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'through-http-proxy' }] }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  let connectTarget = '';
  let proxyAuthorization = '';
  const proxy = createHttpServer();
  proxy.on('connect', (req, client, head) => {
    connectTarget = req.url;
    proxyAuthorization = req.headers['proxy-authorization'] || '';
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const remote = createConnection({ host, port });
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
    remote.on('error', () => client.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  try {
    const response = await listModels({
      provider: 'zen',
      apiKey: 'test',
      proxyUrl: `http://alice:secret@127.0.0.1:${proxy.address().port}`,
      timeoutMs: 5000
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, 'through-http-proxy');
    assert.equal(connectTarget, `127.0.0.1:${target.address().port}`);
    assert.equal(proxyAuthorization, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeProxyDispatchers();
    proxy.close();
    target.close();
    await Promise.all([once(proxy, 'close'), once(target, 'close')]);
  }
});

test('SOCKS5 dispatcher 可以实际转发模型请求', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'through-socks' }] }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const socks = createNetServer((client) => {
    client.once('data', (greeting) => {
      assert.equal(greeting[0], 5);
      client.write(Buffer.from([5, 0]));
      client.once('data', (request) => {
        const addressType = request[3];
        let host;
        let offset;
        if (addressType === 1) {
          host = [...request.subarray(4, 8)].join('.');
          offset = 8;
        } else if (addressType === 3) {
          const length = request[4];
          host = request.subarray(5, 5 + length).toString('utf8');
          offset = 5 + length;
        } else {
          client.destroy(new Error(`不支持测试地址类型 ${addressType}`));
          return;
        }
        const port = request.readUInt16BE(offset);
        const remote = createConnection({ host, port });
        remote.once('connect', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(remote).pipe(client);
        });
        remote.on('error', () => client.destroy());
      });
    });
  });
  socks.listen(0, '127.0.0.1');
  await once(socks, 'listening');

  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://127.0.0.1:${target.address().port}`;
  try {
    const response = await listModels({ provider: 'zen', apiKey: 'test', proxyUrl: `socks5://127.0.0.1:${socks.address().port}`, timeoutMs: 5000 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, 'through-socks');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeProxyDispatchers();
    socks.close();
    target.close();
    await Promise.all([once(socks, 'close'), once(target, 'close')]);
  }
});

test('SOCKS4a dispatcher 可以携带 USERID 并由代理解析目标域名', async () => {
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'through-socks4a' }] }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  let receivedUser = '';
  let receivedHost = '';
  const socks = createNetServer((client) => {
    client.once('data', (request) => {
      assert.equal(request[0], 4);
      assert.equal(request[1], 1);
      assert.deepEqual([...request.subarray(4, 8)], [0, 0, 0, 1]);
      const userEnd = request.indexOf(0, 8);
      const hostEnd = request.indexOf(0, userEnd + 1);
      receivedUser = request.subarray(8, userEnd).toString('utf8');
      receivedHost = request.subarray(userEnd + 1, hostEnd).toString('utf8');
      const port = request.readUInt16BE(2);
      const remote = createConnection({ host: '127.0.0.1', port });
      remote.once('connect', () => {
        client.write(Buffer.from([0, 90, request[2], request[3], 0, 0, 0, 0]));
        client.pipe(remote).pipe(client);
      });
      remote.on('error', () => client.destroy());
    });
  });
  socks.listen(0, '127.0.0.1');
  await once(socks, 'listening');

  const previous = process.env.OPENCODE_ZEN_BASE_URL;
  process.env.OPENCODE_ZEN_BASE_URL = `http://localhost:${target.address().port}`;
  try {
    const response = await listModels({
      provider: 'zen',
      apiKey: 'test',
      proxyUrl: `socks4a://alice@127.0.0.1:${socks.address().port}`,
      timeoutMs: 5000
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, 'through-socks4a');
    assert.equal(receivedUser, 'alice');
    assert.equal(receivedHost, 'localhost');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ZEN_BASE_URL;
    else process.env.OPENCODE_ZEN_BASE_URL = previous;
    await closeProxyDispatchers();
    socks.close();
    target.close();
    await Promise.all([once(socks, 'close'), once(target, 'close')]);
  }
});

async function managedTempDirectories(proxyUrl) {
  const fingerprint = createHash('sha256').update(proxyUrl).digest('hex').slice(0, 12);
  const prefix = `opencode-protocol-bridge-tunnel-${process.pid}-${fingerprint}-`;
  return (await readdir(tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(`等待条件在 ${timeoutMs}ms 内未满足`);
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
