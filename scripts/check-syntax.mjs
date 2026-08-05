import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOTS = ['src', 'public', 'scripts', 'test-fixtures'];
const JAVASCRIPT_EXTENSIONS = /\.(?:cjs|js|mjs)$/i;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && JAVASCRIPT_EXTENSIONS.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

const files = (await Promise.all(SOURCE_ROOTS.map((directory) => sourceFiles(resolve(ROOT, directory)))))
  .flat()
  .sort((left, right) => left.localeCompare(right, 'en'));

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) continue;
  failures++;
  process.stderr.write(`语法检查失败：${relative(ROOT, file)}\n`);
  process.stderr.write(result.stderr || result.stdout || `node --check 退出码：${result.status}\n`);
}

if (failures) process.exitCode = 1;
else console.log(`语法检查通过：${files.length} 个 JavaScript 文件`);
