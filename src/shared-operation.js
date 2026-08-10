function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('操作已取消'), { name: 'AbortError' });
}

export class SharedOperationPool {
  #entries = new Map();

  get size() {
    return this.#entries.size;
  }

  run(key, signal, operation) {
    if (typeof operation !== 'function') throw new TypeError('共享操作必须是函数');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('共享操作 signal 必须是 AbortSignal');
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    let entry = this.#entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, promise: null, settled: false, waiters: 0 };
      const operationPromise = Promise.resolve().then(() => operation(controller.signal));
      entry.promise = operationPromise.finally(() => {
        entry.settled = true;
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      });
      this.#entries.set(key, entry);
    }

    entry.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, abortReason(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    }).finally(() => {
      entry.waiters--;
      if (entry.waiters === 0 && !entry.settled) {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        entry.controller.abort(Object.assign(new Error('共享操作已无等待者'), { code: 'NO_WAITERS' }));
      }
    });
  }
}
