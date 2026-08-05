import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export async function canonicalStaticRoot(root) {
  return realpath(resolve(root));
}

export async function resolveStaticFile(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw staticError(400, '静态资源路径编码无效'); }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) throw staticError(400, '静态资源路径包含非法字符');

  const requested = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const candidate = resolve(root, requested);
  if (outsideRoot(root, candidate) || candidate === root) throw staticError(403, '禁止访问');

  let canonical;
  try { canonical = await realpath(candidate); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw staticError(404, '文件不存在');
    throw error;
  }
  if (outsideRoot(root, canonical) || canonical === root) throw staticError(403, '禁止访问');

  const information = await stat(canonical);
  if (!information.isFile()) throw staticError(404, '文件不存在');
  return {
    filePath: canonical,
    size: information.size,
    etag: weakEtag(information.size, information.mtimeMs),
    lastModified: information.mtime.toUTCString()
  };
}

export function ifNoneMatchMatches(value, etag) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const expected = String(etag).replace(/^W\//, '');
  return value.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*' || normalized.replace(/^W\//, '') === expected;
  });
}

function outsideRoot(root, target) {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function weakEtag(size, mtimeMs) {
  return `W/"${size.toString(16)}-${Math.max(0, Math.trunc(mtimeMs)).toString(16)}"`;
}

function staticError(status, message) {
  return Object.assign(new Error(message), { status });
}
