import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const failures = new Map();
const MAX_FAILURE_IPS = 4096;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || typeof encoded !== 'string') return false;
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(encoded);
  if (!match) return false;
  try {
    const actual = await scrypt(password, match[1], 64);
    const expected = Buffer.from(match[2], 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createSession(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 86_400_000, nonce: randomBytes(8).toString('hex') })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token || token.length > 1024 || typeof secret !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payload, signature] = parts;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url'));
    return session && typeof session === 'object' && !Array.isArray(session)
      && Number.isFinite(session.exp) && session.exp > Date.now();
  } catch { return false; }
}

export function loginAllowed(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry) return true;
  if (now - entry.start > 15 * 60_000) {
    failures.delete(ip);
    return true;
  }
  return entry.count < 10;
}

export function recordLogin(ip, success) {
  if (success) return failures.delete(ip);
  const now = Date.now();
  if (failures.size >= MAX_FAILURE_IPS && !failures.has(ip)) {
    for (const [address, item] of failures) if (now - item.start > 15 * 60_000) failures.delete(address);
    while (failures.size >= MAX_FAILURE_IPS) failures.delete(failures.keys().next().value);
  }
  const entry = failures.get(ip);
  failures.set(ip, !entry || now - entry.start > 15 * 60_000
    ? { count: 1, start: now }
    : { ...entry, count: entry.count + 1 });
}

export function cookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

export function hashClientToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('base64url');
}

export function clientAddress(req, trustProxy = false) {
  const socketAddress = req?.socket?.remoteAddress || 'unknown';
  if (!trustProxy || typeof req?.headers?.['x-forwarded-for'] !== 'string') return socketAddress;
  const forwarded = req.headers['x-forwarded-for'].split(',', 1)[0].trim();
  return isIP(forwarded) ? forwarded : socketAddress;
}
