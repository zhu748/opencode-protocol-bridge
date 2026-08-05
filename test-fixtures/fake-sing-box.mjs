import { createConnection, createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';

if (process.argv[2] === 'version') {
  console.log('sing-box version 9.9.9-test');
  process.exit(0);
}

const configFlag = process.argv.findIndex((item) => item === '-c' || item === '--config');
if (configFlag < 0 || !process.argv[configFlag + 1]) {
  console.error('missing sing-box config path');
  process.exit(2);
}

const config = JSON.parse(await readFile(process.argv[configFlag + 1], 'utf8'));
if (process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT) {
  await writeFile(process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_CONFIG_OUT, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
if (process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT) {
  await writeFile(process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_PID_OUT, String(process.pid), 'utf8');
}
if (process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_FAIL_MESSAGE) {
  console.error(`${process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_FAIL_MESSAGE} config=${process.argv[configFlag + 1]}`);
  process.exit(23);
}

const inbound = config.inbounds?.find((entry) => entry.type === 'socks');
if (!inbound?.listen_port) {
  console.error('missing socks inbound');
  process.exit(2);
}

const server = createServer((client) => {
  client.once('data', (greeting) => {
    if (greeting[0] !== 5) return client.destroy();
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
      } else if (addressType === 4) {
        host = request.subarray(4, 20).toString('hex').match(/.{1,4}/g).join(':');
        offset = 20;
      } else {
        return client.destroy();
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

const listenDelayMs = Number(process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_LISTEN_DELAY_MS || 0);
const startListening = () => server.listen(inbound.listen_port, inbound.listen || '127.0.0.1');
if (Number.isFinite(listenDelayMs) && listenDelayMs > 0) setTimeout(startListening, listenDelayMs);
else startListening();

const exitAfterMs = Number(process.env.OPENCODE_BRIDGE_FAKE_SING_BOX_EXIT_AFTER_MS || 0);
if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
  setTimeout(() => server.close(() => process.exit(17)), exitAfterMs);
}

const shutdown = () => server.listening ? server.close(() => process.exit(0)) : process.exit(0);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
