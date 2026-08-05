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
      const error = clientWriteError('客户端读取流式响应超时', 'CLIENT_WRITE_TIMEOUT');
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

function clientWriteError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
