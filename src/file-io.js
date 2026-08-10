import { open, rename, unlink } from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

export async function readUtf8FileLimited(file, maxBytes, label = '文件') {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes 必须是正整数');
  const handle = await open(file, 'r');
  try {
    const information = await handle.stat();
    if (information.size > maxBytes) throw fileTooLarge(label, maxBytes);
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw fileTooLarge(label, maxBytes);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch {
      throw Object.assign(new Error(`${label}不是有效的 UTF-8 文件`), { code: 'FILE_INVALID_UTF8' });
    }
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(file, data, options = {}) {
  const temporary = atomicTemporaryPath(file);
  let handle = null;
  let ownsTemporary = false;
  try {
    handle = await open(temporary, 'wx', options.mode ?? 0o600);
    ownsTemporary = true;
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    ownsTemporary = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    // 保留原始写入/重命名错误；临时文件清理失败不应覆盖真正的故障原因。
    if (ownsTemporary) await unlink(temporary).catch(() => {});
  }
}

export async function cleanupAtomicTemporary(file) {
  return unlink(atomicTemporaryPath(file)).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export function atomicTemporaryPath(file) {
  return `${file}.tmp`;
}

function fileTooLarge(label, maxBytes) {
  return Object.assign(new Error(`${label}超过 ${formatMiB(maxBytes)} 安全上限`), {
    code: 'FILE_TOO_LARGE',
    maxBytes
  });
}

function formatMiB(bytes) {
  const mib = bytes / 1024 / 1024;
  return `${Number.isInteger(mib) ? mib : Math.round(mib * 10) / 10} MiB`;
}
