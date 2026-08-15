const LEGACY_HEALTH_PATHS = new Set(['/health', '/healthz']);

export function applySecurityResponseHeaders(res, secure) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-xss-protection', '0');
  res.setHeader('x-permitted-cross-domain-policies', 'none');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
}

export function healthEndpointKind(pathname) {
  if (LEGACY_HEALTH_PATHS.has(pathname)) return 'legacy';
  if (pathname === '/livez') return 'liveness';
  if (pathname === '/readyz') return 'readiness';
  return null;
}

export function healthResponse(kind, { ready, configured, uptime }) {
  if (!kind) return null;
  const normalizedReady = Boolean(ready);
  return {
    status: kind === 'readiness' && !normalizedReady ? 503 : 200,
    body: {
      ok: kind === 'readiness' ? normalizedReady : true,
      ready: normalizedReady,
      configured: Boolean(configured),
      uptime: Math.max(0, Math.floor(Number(uptime) || 0))
    }
  };
}
