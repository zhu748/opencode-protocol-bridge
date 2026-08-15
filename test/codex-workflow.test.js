import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectDir = resolve(import.meta.dirname, '..');

test('定时 Codex CLI 探针在 Linux 与 Windows 使用最新客户端和隔离模拟端点', async () => {
  const [workflow, manifestText] = await Promise.all([
    readFile(resolve(projectDir, '.github/workflows/codex-compat.yml'), 'utf8'),
    readFile(resolve(projectDir, 'package.json'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.scripts['test:cli:codex'], 'node scripts/probe-cli-compat.mjs --codex-only');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /os: \[ubuntu-24\.04, windows-2022\]/);
  assert.match(workflow, /npm install --global @openai\/codex@latest/);
  assert.match(workflow, /codex --version/);
  assert.match(workflow, /npm run test:cli:codex/);
  for (const reference of [...workflow.matchAll(/\buses:\s+([^\s#]+)/g)].map((match) => match[1])) {
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/);
  }
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|OPENCODE_BRIDGE_TOKEN|secrets\./);
});
