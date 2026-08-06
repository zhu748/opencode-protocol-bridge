import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildManagedTunnelConfig } from '../src/tunnel-proxy.js';

const executable = resolve(import.meta.dirname, '..', 'vendor', 'sing-box', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
const uuid = 'bf000d23-0752-40b4-affe-68f7707a9661';

test('生成的常见托管隧道配置可通过项目内 sing-box 校验', {
  skip: existsSync(executable) ? false : '项目内未安装 sing-box'
}, async () => {
  const vmessPayload = Buffer.from(JSON.stringify({
    add: 'example.com', port: 443, id: uuid, aid: 0, scy: 'auto', net: 'ws',
    host: 'cdn.example.com', path: '/ws?ed=2560', tls: 'tls', sni: 'example.com'
  })).toString('base64url');
  const cases = new Map([
    ['hysteria2', 'hy2://password@example.com:443?sni=example.com&obfs=salamander&obfs-password=secret'],
    ['tuic', `tuic://${uuid}:password@example.com:443?sni=example.com&congestion_control=bbr&udp_relay_mode=native`],
    ['vless-reality', `vless://${uuid}@example.com:443?security=reality&pbk=7OdYhVWvclHDvt-oRrhc72sope9JB5Ifx7Bml_k9yU8&sid=abcd&type=tcp&flow=xtls-rprx-vision&fp=chrome`],
    ['vless-ws', `vless://${uuid}@example.com:443?security=tls&sni=example.com&type=ws&host=cdn.example.com&path=%2Fws`],
    ['vmess', `vmess://${vmessPayload}`],
    ['trojan', 'trojan://password@example.com:443?sni=example.com&type=ws&host=cdn.example.com&path=%2Fws'],
    ['shadowsocks', 'ss://YWVzLTI1Ni1nY206cGFzcw@example.com:8388'],
    ['hysteria', 'hysteria://example.com:443?auth=secret&upmbps=20&downmbps=50&sni=example.com']
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'opencode-bridge-sing-box-check-'));
  await mkdir(directory, { recursive: true });
  try {
    for (const [name, proxyUrl] of cases) {
      const configPath = join(directory, `${name}.json`);
      await writeFile(configPath, `${JSON.stringify(buildManagedTunnelConfig(proxyUrl, 29080), null, 2)}\n`, 'utf8');
      const result = await run(executable, ['check', '-c', configPath]);
      assert.equal(result.code, 0, `${name} 配置校验失败：${result.stderr}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', rejectRun);
    child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
  });
}
