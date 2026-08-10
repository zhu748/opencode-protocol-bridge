export function clientAbortController(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.off('aborted', abort);
    res.off('close', onClose);
    res.off('finish', cleanup);
  };
  const abort = () => {
    cleanup();
    controller.abort(Object.assign(new Error('客户端已断开'), { code: 'CLIENT_CLOSED' }));
  };
  const onClose = () => {
    if (!res.writableEnded) abort();
    else cleanup();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  res.once('finish', cleanup);
  if (req.aborted || res.destroyed) abort();
  return controller;
}

export function clientAbortSignal(req, res) {
  return clientAbortController(req, res).signal;
}
