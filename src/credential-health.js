import { createHash } from 'node:crypto';

const DEFAULTS = {
  authCooldownMs: 5 * 60 * 1000,
  rateLimitCooldownMs: 30 * 1000,
  transientThreshold: 3,
  transientCooldownMs: 30 * 1000,
  maxCooldownMs: 5 * 60 * 1000,
  maxStates: 256
};

export class CredentialHealthTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = options.now || Date.now;
    this.states = new Map();
    this.cursors = new Map();
  }

  select(provider, credentials) {
    if (!credentials.length) return { credential: null, reason: 'unconfigured', retryAfterMs: 0 };
    const now = this.now();
    const start = (this.cursors.get(provider) || 0) % credentials.length;
    let retryAfterMs = Infinity;
    for (let offset = 0; offset < credentials.length; offset++) {
      const index = (start + offset) % credentials.length;
      const credential = credentials[index];
      const key = identity(provider, credential);
      const state = this.states.get(key);
      if (!state || (!state.probeInFlight && state.cooldownUntil <= now)) {
        if (state?.cooldownUntil) this.states.set(key, { ...state, probeInFlight: true, touchedAt: now });
        this.cursors.set(provider, index + 1);
        return { credential, reason: null, retryAfterMs: 0 };
      }
      retryAfterMs = Math.min(retryAfterMs, state.probeInFlight ? 1000 : state.cooldownUntil - now);
    }
    return { credential: null, reason: 'cooldown', retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) };
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

  recordFailure(provider, credential, kind, status, retryAfter = null) {
    const now = this.now();
    const key = identity(provider, credential);
    const previous = this.states.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
    let cooldownMs = 0;
    if (kind === 'auth') cooldownMs = this.options.authCooldownMs;
    else if (kind === 'rate_limit') cooldownMs = boundedRetryAfter(retryAfter, now, this.options.rateLimitCooldownMs, this.options.maxCooldownMs);
    else if (previous?.probeInFlight || consecutiveFailures >= this.options.transientThreshold) {
      const exponent = Math.max(0, consecutiveFailures - this.options.transientThreshold);
      cooldownMs = Math.min(this.options.maxCooldownMs, this.options.transientCooldownMs * (2 ** exponent));
    }
    this.states.set(key, {
      consecutiveFailures,
      cooldownUntil: cooldownMs ? now + cooldownMs : 0,
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
    const now = this.now();
    return credentials.map((credential) => {
      const state = this.states.get(identity(provider, credential));
      const cooling = Boolean(state?.cooldownUntil > now);
      return {
        provider,
        credentialId: credential.credentialId || 'unknown',
        name: credentialDisplayName(provider, credential.credentialId, credential.credentialLabel),
        state: state?.probeInFlight ? 'probing' : cooling ? 'cooldown' : state?.consecutiveFailures ? 'degraded' : state?.lastSuccessAt ? 'healthy' : 'unknown',
        consecutiveFailures: state?.consecutiveFailures || 0,
        retryAfterMs: cooling ? state.cooldownUntil - now : 0,
        cooldownUntil: cooling ? new Date(state.cooldownUntil).toISOString() : null,
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
    const key = identity(provider, credential);
    const state = this.states.get(key);
    if (!state?.probeInFlight) return false;
    this.states.set(key, { ...state, probeInFlight: false, touchedAt: this.now() });
    return true;
  }

  trim() {
    while (this.states.size > this.options.maxStates) {
      const oldest = [...this.states.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) break;
      this.states.delete(oldest[0]);
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
  const fingerprint = createHash('sha256').update(`${String(credential.apiKey || '')}\0${String(credential.proxyUrl || '')}`).digest('hex').slice(0, 16);
  return `${provider}:${credential.credentialId || 'unknown'}:${fingerprint}`;
}

function boundedRetryAfter(value, now, fallback, maximum) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maximum, Math.max(1000, Math.ceil(seconds * 1000)));
  const date = Date.parse(String(value || ''));
  if (Number.isFinite(date) && date > now) return Math.min(maximum, Math.max(1000, date - now));
  return fallback;
}

function iso(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
