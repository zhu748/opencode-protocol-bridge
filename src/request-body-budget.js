export class RequestBodyBudgetError extends Error {
  constructor(scope, limit) {
    const global = scope === 'global';
    super(global
      ? `服务器在途请求正文已达到 ${limit} 字节上限`
      : `当前客户端在途请求正文已达到 ${limit} 字节上限`);
    this.name = 'RequestBodyBudgetError';
    this.scope = scope;
    this.limit = limit;
    this.status = global ? 503 : 429;
    this.type = global ? 'overloaded_error' : 'rate_limit_error';
    this.code = global ? 'inflight_request_body_capacity_exhausted' : 'client_inflight_request_body_limit_exceeded';
  }
}

function safeBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} 必须是非负安全整数`);
  return value;
}

export class RequestBodyBudget {
  #currentBytes = 0;
  #clientBytes = new Map();

  constructor({ maxBytes, maxClientBytes }) {
    this.maxBytes = safeBytes(maxBytes, 'maxBytes');
    this.maxClientBytes = safeBytes(maxClientBytes, 'maxClientBytes');
    if (this.maxBytes === 0 || this.maxClientBytes === 0) throw new TypeError('正文预算上限必须大于 0');
  }

  acquire(clientId, initialBytes = 0) {
    if (typeof clientId !== 'string' || !clientId) throw new TypeError('clientId 不能为空');
    let heldBytes = 0;
    let released = false;
    const reserveTo = (requestedBytes) => {
      safeBytes(requestedBytes, 'requestedBytes');
      if (released) throw new Error('请求正文预算租约已释放');
      if (requestedBytes <= heldBytes) return heldBytes;
      const delta = requestedBytes - heldBytes;
      const clientCurrent = this.#clientBytes.get(clientId) || 0;
      if (clientCurrent + delta > this.maxClientBytes) {
        throw new RequestBodyBudgetError('client', this.maxClientBytes);
      }
      if (this.#currentBytes + delta > this.maxBytes) {
        throw new RequestBodyBudgetError('global', this.maxBytes);
      }
      heldBytes = requestedBytes;
      this.#currentBytes += delta;
      this.#clientBytes.set(clientId, clientCurrent + delta);
      return heldBytes;
    };
    const release = () => {
      if (released) return;
      released = true;
      if (!heldBytes) return;
      this.#currentBytes -= heldBytes;
      const remaining = (this.#clientBytes.get(clientId) || heldBytes) - heldBytes;
      if (remaining > 0) this.#clientBytes.set(clientId, remaining);
      else this.#clientBytes.delete(clientId);
      heldBytes = 0;
    };
    try {
      reserveTo(initialBytes);
    } catch (error) {
      release();
      throw error;
    }
    return {
      reserveTo,
      release,
      get bytes() { return heldBytes; }
    };
  }

  status() {
    return {
      currentBytes: this.#currentBytes,
      maxBytes: this.maxBytes,
      activeClients: this.#clientBytes.size,
      maxClientBytes: this.maxClientBytes
    };
  }
}
