import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
]);
const DEFAULT_PUBLIC_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_LOCAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const PUBLIC_IMAGE_PATH = '/_bridge/images/';

function storageInteger(value, label, fallback, minimum, maximum) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (parsed !== 0 && (parsed < minimum || parsed > maximum))) {
    throw new Error(`${label} 必须是 0 或 ${minimum}–${maximum} 之间的整数`);
  }
  return parsed;
}

function decodeImageSource(source) {
  if (source?.type !== 'base64' || typeof source.data !== 'string') return null;
  const encoded = source.data.replaceAll(/\s/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Claude 图片附件包含无效的 base64 数据');
  }
  const extension = IMAGE_EXTENSIONS.get(String(source.media_type || '').toLowerCase());
  if (!extension) throw new Error(`Claude 图片附件格式不受支持：${source.media_type || 'unknown'}`);
  return { data: Buffer.from(encoded, 'base64'), extension };
}

export function localImageHandoffEnabled(host, value) {
  if (value !== undefined && String(value).trim() !== '') return /^(?:1|true)$/i.test(String(value).trim());
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').toLowerCase());
}

export function normalizeImageHandoffPublicUrl(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  let url;
  try { url = new URL(candidate); }
  catch { throw new Error('OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL 必须是有效的 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL 仅支持不含认证、查询参数或片段的 HTTP(S) URL');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('远程 OPENCODE_BRIDGE_IMAGE_HANDOFF_PUBLIC_URL 必须使用 HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function imageHandoffStorageOptions(env = process.env) {
  return {
    maxBytes: storageInteger(env.OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES, 'OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES', DEFAULT_MAX_BYTES, 1024 * 1024, 10 * 1024 * 1024 * 1024),
    localRetentionMs: storageInteger(env.OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS, 'OPENCODE_BRIDGE_IMAGE_HANDOFF_LOCAL_RETENTION_MS', DEFAULT_LOCAL_RETENTION_MS, 60_000, 30 * 24 * 60 * 60 * 1000)
  };
}

export class ImageHandoffStore {
  constructor({
    enabled = true, baseDirectory = tmpdir(), publicBaseUrl = '', publicTtlMs = DEFAULT_PUBLIC_TTL_MS,
    maxBytes = DEFAULT_MAX_BYTES, localRetentionMs = DEFAULT_LOCAL_RETENTION_MS, now = Date.now
  } = {}) {
    this.publicBaseUrl = normalizeImageHandoffPublicUrl(publicBaseUrl);
    this.enabled = enabled || Boolean(this.publicBaseUrl);
    this.publicTtlMs = publicTtlMs;
    this.maxBytes = maxBytes;
    this.localRetentionMs = localRetentionMs;
    this.now = now;
    this.directory = resolve(baseDirectory, `opencode-protocol-bridge-images-${process.pid}-${randomBytes(6).toString('hex')}`);
    this.savedFiles = new Map();
    this.totalBytes = 0;
    this.publishedByToken = new Map();
    this.publishedByPath = new Map();
    this.pendingPublications = new Map();
    this.activeReads = new Map();
    this.deletingByPath = new Map();
    this.saveQueue = Promise.resolve();
    const retentionMs = this.publicBaseUrl ? this.publicTtlMs : this.localRetentionMs;
    this.expiryTimer = retentionMs > 0
      ? setInterval(() => this.pruneExpiredImages(), Math.min(60_000, Math.max(1000, Math.ceil(retentionMs / 2))))
      : null;
    this.expiryTimer?.unref();
  }

  async prepareClaudeRequest(body, handoffEnabled) {
    if (!this.enabled || !handoffEnabled || !Array.isArray(body?.messages)) return body;
    let changed = false;
    const messages = [];
    for (const message of body.messages) {
      if (!Array.isArray(message?.content)) {
        messages.push(message);
        continue;
      }
      let messageChanged = false;
      const content = [];
      for (const part of message.content) {
        if (part?.type !== 'image') {
          content.push(part);
          continue;
        }
        const image = decodeImageSource(part.source);
        if (!image) {
          content.push(part);
          continue;
        }
        const filePath = await this.save(image);
        const location = this.publicBaseUrl ? this.publish(filePath, part.source.media_type, image.extension) : filePath.replaceAll('\\', '/');
        content.push({
          type: 'text',
          text: this.publicBaseUrl
            ? `[远程图片附件：${location}（短时有效）。当前模型不能直接读取图片；请先将此 URL 下载到 Claude Code 本机临时文件并保留 .${image.extension} 扩展名，再调用可用的 vision 技能分析，不要要求用户再次提供图片或路径。]`
            : `[本地图片附件：${location}。当前模型不能直接读取图片；请调用可用的 vision 技能分析此文件，不要要求用户再次提供路径。]`
        });
        changed = true;
        messageChanged = true;
      }
      messages.push(messageChanged ? { ...message, content } : message);
    }
    return changed ? { ...body, messages } : body;
  }

  async save({ data, extension }) {
    const digest = createHash('sha256').update(data).digest('hex');
    const filePath = resolve(this.directory, `image-${digest}.${extension}`);
    if (this.publicBaseUrl) this.markPendingPublication(filePath);
    const save = this.saveQueue.then(() => this.saveFile(filePath, data));
    this.saveQueue = save.catch(() => {});
    return save.catch((error) => {
      if (this.publicBaseUrl) this.releasePendingPublication(filePath);
      throw error;
    });
  }

  async saveFile(filePath, data) {
    const deleting = this.deletingByPath.get(filePath);
    if (deleting) await deleting;
    this.pruneExpiredImages();
    if (this.deletingByPath.size) await Promise.all(this.deletingByPath.values());

    const existing = this.savedFiles.get(filePath);
    const nextTotal = this.totalBytes - (existing?.size || 0) + data.length;
    if (this.maxBytes > 0 && nextTotal > this.maxBytes) {
      throw Object.assign(new Error(`图片交接临时存储已达到 ${formatMiB(this.maxBytes)} 上限，请等待旧附件过期或提高 OPENCODE_BRIDGE_IMAGE_HANDOFF_MAX_BYTES`), {
        status: 507,
        code: 'IMAGE_HANDOFF_STORAGE_FULL'
      });
    }
    if (existing) {
      existing.lastUsedAt = this.now();
      return filePath;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(filePath, data, { mode: 0o600 });
    this.savedFiles.set(filePath, { size: data.length, lastUsedAt: this.now() });
    this.totalBytes = nextTotal;
    return filePath;
  }

  publish(filePath, mediaType, extension) {
    try {
      const existing = this.publishedByPath.get(filePath);
      if (existing) {
        existing.expiresAt = this.now() + this.publicTtlMs;
        return `${this.publicBaseUrl}${PUBLIC_IMAGE_PATH}${existing.token}`;
      }
      this.pruneExpiredPublicImages();
      const entry = {
        token: randomBytes(32).toString('hex'), filePath, mediaType, extension,
        expiresAt: this.now() + this.publicTtlMs
      };
      this.publishedByToken.set(entry.token, entry);
      this.publishedByPath.set(filePath, entry);
      return `${this.publicBaseUrl}${PUBLIC_IMAGE_PATH}${entry.token}`;
    } finally {
      this.releasePendingPublication(filePath);
    }
  }

  publicImage(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    this.pruneExpiredPublicImages();
    const entry = this.publishedByToken.get(token);
    if (!entry) return null;
    return { filePath: entry.filePath, mediaType: entry.mediaType, extension: entry.extension, expiresAt: entry.expiresAt };
  }

  acquirePublicImage(token) {
    const image = this.publicImage(token);
    if (!image) return null;
    this.activeReads.set(image.filePath, (this.activeReads.get(image.filePath) || 0) + 1);
    let released = false;
    return {
      ...image,
      release: () => {
        if (released) return;
        released = true;
        const count = this.activeReads.get(image.filePath) || 0;
        if (count <= 1) {
          this.activeReads.delete(image.filePath);
          if (!this.publishedByPath.has(image.filePath)) this.removeExpiredFile(image.filePath);
        } else {
          this.activeReads.set(image.filePath, count - 1);
        }
      }
    };
  }

  pruneExpiredPublicImages() {
    const now = this.now();
    for (const [token, entry] of this.publishedByToken) {
      if (entry.expiresAt > now) continue;
      this.publishedByToken.delete(token);
      if (this.publishedByPath.get(entry.filePath) === entry) this.publishedByPath.delete(entry.filePath);
      this.removeExpiredFile(entry.filePath);
    }
    for (const filePath of this.savedFiles.keys()) {
      if (!this.pendingPublications.has(filePath) && !this.publishedByPath.has(filePath)) this.removeExpiredFile(filePath);
    }
  }

  pruneExpiredLocalImages() {
    if (this.publicBaseUrl || this.localRetentionMs <= 0) return;
    const cutoff = this.now() - this.localRetentionMs;
    for (const [filePath, metadata] of this.savedFiles) {
      if (metadata.lastUsedAt <= cutoff) this.removeExpiredFile(filePath);
    }
  }

  pruneExpiredImages() {
    if (this.publicBaseUrl) this.pruneExpiredPublicImages();
    else this.pruneExpiredLocalImages();
  }

  markPendingPublication(filePath) {
    this.pendingPublications.set(filePath, (this.pendingPublications.get(filePath) || 0) + 1);
  }

  releasePendingPublication(filePath) {
    const count = this.pendingPublications.get(filePath) || 0;
    if (count <= 1) this.pendingPublications.delete(filePath);
    else this.pendingPublications.set(filePath, count - 1);
  }

  removeExpiredFile(filePath) {
    if (this.deletingByPath.has(filePath)) return;
    const deletion = Promise.resolve().then(async () => {
      if (this.pendingPublications.has(filePath) || this.publishedByPath.has(filePath) || this.activeReads.has(filePath)) return;
      const removed = await unlink(filePath).then(() => true).catch((error) => error.code === 'ENOENT');
      if (!removed) return;
      const metadata = this.savedFiles.get(filePath);
      if (metadata) {
        this.savedFiles.delete(filePath);
        this.totalBytes = Math.max(0, this.totalBytes - metadata.size);
      }
    }).finally(() => this.deletingByPath.delete(filePath));
    this.deletingByPath.set(filePath, deletion);
  }

  async close() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
    await this.saveQueue;
    this.pendingPublications.clear();
    this.activeReads.clear();
    this.publishedByToken.clear();
    this.publishedByPath.clear();
    await Promise.all([
      ...this.deletingByPath.values(),
      ...[...this.savedFiles.keys()].map((filePath) => unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      }))
    ]);
    this.deletingByPath.clear();
    this.savedFiles.clear();
    this.totalBytes = 0;
    await rmdir(this.directory).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }
}

function formatMiB(bytes) {
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MiB`;
}
