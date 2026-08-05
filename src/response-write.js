export async function writeResponseChunk(res, chunk, timeoutMs = 30_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('写入超时必须是正整数');
  if (res.destroyed || res.writableEnded) throw clientWriteError('客户端已断开', 'CLIENT_CLOSED');
  if (res.write(chunk)) return;

  await new Promise((resolveWrite, rejectWrite) => {
    let timeout;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolveWrite(); };
    const onClose = () => { cleanup(); rejectWrite(clientWriteError('客户端已断开', 'CLIENT_CLOSED')); };
    const onError = (error) => {
      cleanup();
      rejectWrite(clientWriteError('向客户端写入流失败', 'CLIENT_CLOSED', error));
    };
    const onTimeout = () => {
      cleanup();
      const error = clientWriteError('客户端读取响应超时', 'CLIENT_WRITE_TIMEOUT');
      if (!res.destroyed) res.destroy();
      rejectWrite(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    timeout = setTimeout(onTimeout, timeoutMs);
    if (res.destroyed || res.writableEnded) onClose();
  });
}

export async function writeResponseStream(res, readable, timeoutMs = 30_000) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') throw new TypeError('响应来源必须是可异步迭代的可读流');
  try {
    for await (const chunk of readable) await writeResponseChunk(res, chunk, timeoutMs);
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    readable.destroy?.();
    throw error;
  }
}

export async function writeResponseBuffer(res, body, timeoutMs = 30_000, chunkBytes = 64 * 1024) {
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new TypeError('响应正文必须是 Buffer 或 Uint8Array');
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new TypeError('响应分块大小必须是正整数');
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    await writeResponseChunk(res, buffer.subarray(offset, Math.min(buffer.length, offset + chunkBytes)), timeoutMs);
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

function clientWriteError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
