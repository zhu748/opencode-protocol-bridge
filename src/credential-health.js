import { createHash } from 'node:crypto';

const DEFAULTS = {
  maxStates: 256
};
const identityCache = new WeakMap();

export class CredentialHealthTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = options.now || Date.now;
    this.states = new Map();
    this.cursors = new Map();
  }

  select(provider, credentials, excludedCredentialIds = null) {
    if (!credentials.length) return { credential: null, reason: 'unconfigured', retryAfterMs: 0 };
    const start = (this.cursors.get(provider) || 0) % credentials.length;
    let considered = 0;
    let degradedFallback;
    for (let offset = 0; offset < credentials.length; offset++) {
      const index = (start + offset) % credentials.length;
      const credential = credentials[index];
      if (excludedCredentialIds?.has(credential.credentialId)) continue;
      considered++;
      const key = identity(provider, credential);
      const state = this.states.get(key);
      if (state?.consecutiveFailures) {
        degradedFallback ||= { credential, index };
        continue;
      }
      this.cursors.set(provider, index + 1);
      return { credential, reason: null, retryAfterMs: 0 };
    }
    if (!considered) return { credential: null, reason: 'exhausted', retryAfterMs: 0 };
    // 失败状态只用于排序和展示，绝不封锁已配置的 Key。全部 Key 都失败时仍继续轮询。
    this.cursors.set(provider, degradedFallback.index + 1);
    return { credential: degradedFallback.credential, reason: null, retryAfterMs: 0 };
  }

  recordResponse(provider, credential, status, retryAfter = null) {
    if ([401, 403].includes(status)) return this.recordFailure(provider, credential, 'auth', status);
    if (status === 429) return this.recordFailure(provider, credential, 'rate_limit', status, retryAfter);
    if (status >= 500) return this.recordFailure(provider, credential, 'transient', status);
    return this.recordSuccess(provider, credential, status);
  }

  recordNetworkFailure(provider, credential, status = 502) {
    return this.recordFailure(provider, credential, 'network', status);
  }

  recordSuccess(provider, credential, status = 200) {
    const now = this.now();
    this.states.set(identity(provider, credential), {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastSuccessAt: now,
      lastFailureAt: null,
      lastStatus: status,
      lastFailureKind: null,
      probeInFlight: false,
      touchedAt: now
    });
    this.trim();
  }

  recordFailure(provider, credential, kind, status) {
    const now = this.now();
    const key = identity(provider, credential);
    const previous = this.states.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
    this.states.set(key, {
      consecutiveFailures,
      cooldownUntil: 0,
      lastSuccessAt: previous?.lastSuccessAt || null,
      lastFailureAt: now,
      lastStatus: status,
      lastFailureKind: kind,
      probeInFlight: false,
      touchedAt: now
    });
    this.trim();
  }

  snapshot(provider, credentials) {
    return credentials.map((credential) => {
      const state = this.states.get(identity(provider, credential));
      return {
        provider,
        credentialId: credential.credentialId || 'unknown',
        name: credentialDisplayName(provider, credential.credentialId, credential.credentialLabel),
        state: state?.consecutiveFailures ? 'degraded' : state?.lastSuccessAt ? 'healthy' : 'unknown',
        consecutiveFailures: state?.consecutiveFailures || 0,
        retryAfterMs: 0,
        cooldownUntil: null,
        lastSuccessAt: iso(state?.lastSuccessAt),
        lastFailureAt: iso(state?.lastFailureAt),
        lastStatus: state?.lastStatus ?? null,
        lastFailureKind: state?.lastFailureKind || null
      };
    });
  }

  reset(provider, credential) {
    return this.states.delete(identity(provider, credential));
  }

  releaseProbe(provider, credential) {
    return false;
  }

  trim() {
    while (this.states.size > this.options.maxStates) {
      let oldestKey;
      let oldestTouchedAt = Infinity;
      for (const [key, state] of this.states) {
        if (oldestKey !== undefined && state.touchedAt >= oldestTouchedAt) continue;
        oldestKey = key;
        oldestTouchedAt = state.touchedAt;
      }
      if (oldestKey === undefined) break;
      this.states.delete(oldestKey);
    }
  }
}

export function credentialDisplayName(provider, credentialId = '', credentialLabel = '') {
  const label = String(provider || '未知').toUpperCase();
  const [source, slot] = String(credentialId).split(':');
  if (source === 'environment' && /^\d+$/.test(slot)) return `${label} 环境 #${slot}`;
  if (source === 'config') return `${label} · ${String(credentialLabel || '面板 Key').slice(0, 64)}`;
  return `${label} 旧记录`;
}

function identity(provider, credential) {
  const apiKey = credential.apiKey || '';
  const proxyUrl = credential.proxyUrl || '';
  const credentialId = credential.credentialId || 'unknown';
  const cached = identityCache.get(credential);
  if (cached?.provider === provider && cached.apiKey === apiKey && cached.proxyUrl === proxyUrl && cached.credentialId === credentialId) {
    return cached.identity;
  }
  const fingerprint = createHash('sha256').update(`${String(apiKey)}\0${String(proxyUrl)}`).digest('hex').slice(0, 16);
  const value = `${provider}:${credentialId}:${fingerprint}`;
  identityCache.set(credential, { provider, apiKey, proxyUrl, credentialId, identity: value });
  return value;
}

function iso(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
