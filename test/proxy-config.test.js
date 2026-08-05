import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { listModels } from '../src/upstream.js';
import { closeProxyDispatchers, normalizeProxyUrl, providerProxyUrl, proxyDispatcher } from '../src/proxy.js';

test('代理地址支持 HTTP、HTTPS、SOCKS4/4a/5/5h 和省略协议的 host:port', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('mixed://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('mixed://user:pass@127.0.0.1:7890'), 'http://user:pass@127.0.0.1:7890/');
  for (const protocol of ['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    assert.match(normalizeProxyUrl(`${protocol}://user:pass@127.0.0.1:1080`), new RegExp(`^${protocol}:`));
  }
  assert.throws(() => normalizeProxyUrl('ftp://127.0.0.1:21'), /仅支持/);
  assert.throws(() => normalizeProxyUrl('tuic://user:pass@example.com:443'), /TUIC 分享链接不能直接.*sing-box.*HTTP\/SOCKS/);
  assert.throws(() => normalizeProxyUrl('vless://uuid@example.com:443?type=tcp'), /VLESS 分享链接不能直接.*Xray.*127\.0\.0\.1:7890/);
  assert.throws(() => normalizeProxyUrl('vmess://eyJhZGQiOiJleGFtcGxlLmNvbSJ9'), /VMess 分享链接不能直接.*socks5h:\/\/127\.0\.0\.1:1080/);
  assert.throws(() => normalizeProxyUrl('trojan://password@example.com:443'), /Trojan 分享链接不能直接/);
  assert.throws(() => normalizeProxyUrl('ss://YWVzLTI1Ni1nY206cGFzcw@example.com:8388'), /Shadowsocks 分享链接不能直接/);
  assert.throws(() => normalizeProxyUrl('hysteria2://password@example.com:443'), /Hysteria2 分享链接不能直接/);
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
