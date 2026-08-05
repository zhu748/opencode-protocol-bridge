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
const PUBLIC_IMAGE_PATH = '/_bridge/images/';

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

export class ImageHandoffStore {
  constructor({ enabled = true, baseDirectory = tmpdir(), publicBaseUrl = '', publicTtlMs = DEFAULT_PUBLIC_TTL_MS, now = Date.now } = {}) {
    this.publicBaseUrl = normalizeImageHandoffPublicUrl(publicBaseUrl);
    this.enabled = enabled || Boolean(this.publicBaseUrl);
    this.publicTtlMs = publicTtlMs;
    this.now = now;
    this.directory = resolve(baseDirectory, `opencode-protocol-bridge-images-${process.pid}-${randomBytes(6).toString('hex')}`);
    this.savedPaths = new Set();
    this.publishedByToken = new Map();
    this.publishedByPath = new Map();
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
    await mkdir(this.directory, { recursive: true });
    const digest = createHash('sha256').update(data).digest('hex');
    const filePath = resolve(this.directory, `image-${digest}.${extension}`);
    await writeFile(filePath, data, { mode: 0o600 });
    this.savedPaths.add(filePath);
    return filePath;
  }

  publish(filePath, mediaType, extension) {
    const existing = this.publishedByPath.get(filePath);
    if (existing) {
      existing.expiresAt = this.now() + this.publicTtlMs;
      return `${this.publicBaseUrl}${PUBLIC_IMAGE_PATH}${existing.token}`;
    }
    const entry = {
      token: randomBytes(32).toString('hex'), filePath, mediaType, extension,
      expiresAt: this.now() + this.publicTtlMs
    };
    this.publishedByToken.set(entry.token, entry);
    this.publishedByPath.set(filePath, entry);
    return `${this.publicBaseUrl}${PUBLIC_IMAGE_PATH}${entry.token}`;
  }

  publicImage(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    const entry = this.publishedByToken.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.publishedByToken.delete(token);
      this.publishedByPath.delete(entry.filePath);
      return null;
    }
    return { filePath: entry.filePath, mediaType: entry.mediaType, extension: entry.extension, expiresAt: entry.expiresAt };
  }

  async close() {
    this.publishedByToken.clear();
    this.publishedByPath.clear();
    await Promise.all([...this.savedPaths].map((filePath) => unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    })));
    this.savedPaths.clear();
    await rmdir(this.directory).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
  }
}
