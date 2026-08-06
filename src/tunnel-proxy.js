const TUNNEL_PROTOCOL_LABELS = new Map([
  ['tuic:', 'TUIC'],
  ['vless:', 'VLESS'],
  ['vmess:', 'VMess'],
  ['trojan:', 'Trojan'],
  ['ss:', 'Shadowsocks'],
  ['ssr:', 'ShadowsocksR'],
  ['hysteria:', 'Hysteria'],
  ['hysteria2:', 'Hysteria2'],
  ['hy2:', 'Hysteria2']
]);

const MANAGED_TUNNEL_PROTOCOLS = new Set(['tuic:', 'vless:', 'vmess:', 'trojan:', 'ss:', 'hysteria:', 'hysteria2:', 'hy2:']);
const SUPPORTED_V2RAY_TRANSPORTS = new Set(['http', 'ws', 'grpc', 'httpupgrade', 'quic']);
const VMESS_SECURITIES = new Set(['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305', 'aes-128-ctr']);

export function tunnelProxyProtocolLabel(protocol) {
  return TUNNEL_PROTOCOL_LABELS.get(String(protocol || '').toLowerCase()) || '';
}

export function isKnownTunnelProxyProtocol(protocol) {
  return TUNNEL_PROTOCOL_LABELS.has(String(protocol || '').toLowerCase());
}

export function isManagedTunnelProxyProtocol(protocol) {
  return MANAGED_TUNNEL_PROTOCOLS.has(String(protocol || '').toLowerCase());
}

export function protocolOfProxyUrl(value) {
  const match = String(value || '').trim().match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  return match ? `${match[1].toLowerCase()}:` : '';
}

export function parseManagedTunnelProxy(value) {
  const input = cleanInput(value, '代理分享链接');
  const protocol = protocolOfProxyUrl(input);
  if (!isManagedTunnelProxyProtocol(protocol)) throw new Error('该代理协议不支持托管隧道');
  const parsed = protocol === 'vmess:' ? parseVmess(input)
    : protocol === 'vless:' ? parseVless(input)
      : protocol === 'tuic:' ? parseTuic(input)
        : protocol === 'trojan:' ? parseTrojan(input)
          : protocol === 'ss:' ? parseShadowsocks(input)
            : protocol === 'hysteria:' ? parseHysteria(input)
              : parseHysteria2(input);
  return { ...parsed, protocol, label: tunnelProxyProtocolLabel(protocol) };
}

export function buildManagedTunnelConfig(proxyUrl, listenPort) {
  const { outbound } = parseManagedTunnelProxy(proxyUrl);
  return {
    log: { disabled: true, level: 'error' },
    inbounds: [{
      type: 'socks',
      tag: 'bridge-socks-in',
      listen: '127.0.0.1',
      listen_port: listenPort,
      users: []
    }],
    outbounds: [
      { ...outbound, tag: 'bridge-managed-out' },
      { type: 'direct', tag: 'direct' }
    ],
    route: { final: 'bridge-managed-out' }
  };
}

export function maskManagedTunnelProxyUrl(value) {
  const protocol = protocolOfProxyUrl(value);
  const scheme = protocol ? protocol.slice(0, -1) : 'tunnel';
  try {
    const { outbound } = parseManagedTunnelProxy(value);
    const host = outbound.server || 'unknown';
    const port = outbound.server_port || (Array.isArray(outbound.server_ports) ? outbound.server_ports[0] : '');
    return `${scheme}://••••@${host}${port ? `:${port}` : ''}`;
  } catch {
    return `${scheme}://••••`;
  }
}

function parseVless(input) {
  const url = parsedUrl(input, 'VLESS');
  const uuid = decodedUser(url, 'VLESS uuid');
  if (!uuid) throw new Error('VLESS 分享链接缺少 uuid');
  const encryption = firstParam(url, ['encryption']);
  if (encryption && encryption.toLowerCase() !== 'none') throw new Error('VLESS 仅支持 encryption=none');
  const outbound = {
    type: 'vless',
    server: requiredHost(url, 'VLESS'),
    server_port: requiredPort(url, 'VLESS'),
    uuid
  };
  addString(outbound, 'flow', firstParam(url, ['flow']));
  addString(outbound, 'network', oneOf(firstParam(url, ['network']), ['tcp', 'udp'], 'VLESS network'));
  addString(outbound, 'packet_encoding', firstParam(url, ['packet_encoding', 'packetEncoding']));
  const tls = tlsFromUrl(url, { security: firstParam(url, ['security']), defaultEnabled: false });
  if (tls) outbound.tls = tls;
  const transport = transportFromUrl(url, 'VLESS');
  if (transport) outbound.transport = transport;
  return { outbound };
}

function parseVmess(input) {
  const payload = input.slice(input.indexOf('://') + 3);
  const main = payload.split('#', 1)[0].split('?', 1)[0];
  if (main && !main.includes('@')) return parseVmessJson(main);
  return parseVmessUrl(input);
}

function parseVmessJson(rawPayload) {
  let data;
  try { data = JSON.parse(base64DecodeText(rawPayload, 'VMess 配置')); }
  catch { throw new Error('VMess base64 配置必须是有效 JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('VMess 配置必须是 JSON 对象');
  const outbound = {
    type: 'vmess',
    server: requiredString(data.add, 'VMess server'),
    server_port: parsePort(data.port, 'VMess port'),
    uuid: requiredString(data.id, 'VMess uuid'),
    security: normalizeVmessSecurity(data.scy || data.security || 'auto'),
    alter_id: parseNonNegativeInteger(data.aid ?? 0, 'VMess alterId')
  };
  const tls = tlsFromFields({
    enabled: ['tls', '1', 'true', true].includes(typeof data.tls === 'string' ? data.tls.toLowerCase() : data.tls),
    serverName: data.sni || data.serverName,
    insecure: data.allowInsecure || data.insecure,
    alpn: data.alpn,
    fingerprint: data.fp
  });
  if (tls) outbound.tls = tls;
  const transport = transportFromFields({
    type: data.net,
    headerType: data.type,
    host: data.host,
    path: data.path,
    serviceName: data.serviceName || (data.net === 'grpc' ? data.path : ''),
    earlyData: data.ed ?? data.max_early_data,
    earlyDataHeader: data.eh ?? data.early_data_header_name
  }, 'VMess');
  if (transport) outbound.transport = transport;
  return { outbound };
}

function parseVmessUrl(input) {
  const url = parsedUrl(input, 'VMess');
  const outbound = {
    type: 'vmess',
    server: requiredHost(url, 'VMess'),
    server_port: requiredPort(url, 'VMess'),
    uuid: decodedUser(url, 'VMess uuid'),
    security: normalizeVmessSecurity(firstParam(url, ['security', 'encryption']) || 'auto'),
    alter_id: parseNonNegativeInteger(firstParam(url, ['alterId', 'alter_id', 'aid']) || 0, 'VMess alterId')
  };
  if (!outbound.uuid) throw new Error('VMess 分享链接缺少 uuid');
  const tls = tlsFromUrl(url, { security: firstParam(url, ['tls', 'security']), defaultEnabled: false });
  if (tls) outbound.tls = tls;
  const transport = transportFromUrl(url, 'VMess');
  if (transport) outbound.transport = transport;
  return { outbound };
}

function parseTuic(input) {
  const url = parsedUrl(input, 'TUIC');
  const uuid = decodedUser(url, 'TUIC uuid');
  const password = decodedPassword(url, 'TUIC password');
  if (!uuid) throw new Error('TUIC 分享链接缺少 uuid');
  if (!password) throw new Error('TUIC 分享链接缺少 password');
  const outbound = {
    type: 'tuic',
    server: requiredHost(url, 'TUIC'),
    server_port: requiredPort(url, 'TUIC', 443),
    uuid,
    password,
    tls: tlsFromUrl(url, { defaultEnabled: true })
  };
  addString(outbound, 'congestion_control', oneOf(firstParam(url, ['congestion_control', 'congestion-control', 'congestionControl']), ['cubic', 'new_reno', 'bbr'], 'TUIC congestion_control'));
  addString(outbound, 'udp_relay_mode', oneOf(firstParam(url, ['udp_relay_mode', 'udp-relay-mode', 'udpRelayMode']), ['native', 'quic'], 'TUIC udp_relay_mode'));
  addString(outbound, 'network', oneOf(firstParam(url, ['network']), ['tcp', 'udp'], 'TUIC network'));
  const zeroRtt = optionalBooleanParam(url, ['zero_rtt_handshake', 'zero-rtt-handshake', 'zeroRTT']);
  if (zeroRtt !== undefined) outbound.zero_rtt_handshake = zeroRtt;
  addString(outbound, 'heartbeat', firstParam(url, ['heartbeat']));
  return { outbound };
}

function parseTrojan(input) {
  const url = parsedUrl(input, 'Trojan');
  const user = decodedUser(url, 'Trojan password');
  const pass = decodedPassword(url, 'Trojan password');
  const password = pass ? `${user}:${pass}` : user;
  if (!password) throw new Error('Trojan 分享链接缺少 password');
  const outbound = {
    type: 'trojan',
    server: requiredHost(url, 'Trojan'),
    server_port: requiredPort(url, 'Trojan', 443),
    password
  };
  const security = firstParam(url, ['security']);
  if (security?.toLowerCase() !== 'none') outbound.tls = tlsFromUrl(url, { security, defaultEnabled: true });
  const transport = transportFromUrl(url, 'Trojan');
  if (transport) outbound.transport = transport;
  return { outbound };
}

function parseShadowsocks(input) {
  const raw = input.slice(input.indexOf('://') + 3);
  const [withoutFragment] = raw.split('#', 1);
  const queryIndex = withoutFragment.indexOf('?');
  const main = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  const query = queryIndex >= 0 ? withoutFragment.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);
  let userInfo;
  let authority;
  if (main.includes('@')) {
    const at = main.lastIndexOf('@');
    userInfo = main.slice(0, at);
    authority = main.slice(at + 1);
  } else {
    const decoded = base64DecodeText(main, 'Shadowsocks 配置');
    const at = decoded.lastIndexOf('@');
    if (at < 0) throw new Error('Shadowsocks 分享链接缺少服务器地址');
    userInfo = decoded.slice(0, at);
    authority = decoded.slice(at + 1);
  }
  const decodedUserInfo = decodeUserInfo(userInfo, 'Shadowsocks method:password');
  const separator = decodedUserInfo.indexOf(':');
  if (separator <= 0) throw new Error('Shadowsocks 分享链接缺少 method 或 password');
  const method = decodedUserInfo.slice(0, separator);
  const password = decodedUserInfo.slice(separator + 1);
  const hostUrl = parsedUrl(`ss://${authority}`, 'Shadowsocks');
  const outbound = {
    type: 'shadowsocks',
    server: requiredHost(hostUrl, 'Shadowsocks'),
    server_port: requiredPort(hostUrl, 'Shadowsocks', 8388),
    method,
    password
  };
  const plugin = params.get('plugin')?.trim();
  if (plugin) {
    const [pluginName, ...pluginOptions] = plugin.split(';');
    addString(outbound, 'plugin', pluginName);
    addString(outbound, 'plugin_opts', pluginOptions.join(';'));
  }
  addString(outbound, 'network', oneOf(params.get('network') || '', ['tcp', 'udp'], 'Shadowsocks network'));
  return { outbound };
}

function parseHysteria2(input) {
  const url = parsedUrl(input, 'Hysteria2');
  const user = decodedUser(url, 'Hysteria2 password');
  const pass = decodedPassword(url, 'Hysteria2 password');
  const password = firstParam(url, ['password', 'auth', 'auth_str']) || (pass ? `${user}:${pass}` : user);
  if (!password) throw new Error('Hysteria2 分享链接缺少 password');
  const outbound = {
    type: 'hysteria2',
    server: requiredHost(url, 'Hysteria2'),
    password,
    tls: tlsFromUrl(url, { defaultEnabled: true })
  };
  const serverPorts = portRangeParam(firstParam(url, ['mport', 'ports', 'server_ports']));
  if (serverPorts) outbound.server_ports = [serverPorts];
  else outbound.server_port = requiredPort(url, 'Hysteria2', 443);
  addPositiveInteger(outbound, 'up_mbps', firstParam(url, ['up_mbps', 'upmbps', 'up']));
  addPositiveInteger(outbound, 'down_mbps', firstParam(url, ['down_mbps', 'downmbps', 'down']));
  const obfs = hysteria2Obfs(url);
  if (obfs) outbound.obfs = obfs;
  addString(outbound, 'hop_interval', firstParam(url, ['hop_interval', 'hop-interval', 'hopInterval']));
  addString(outbound, 'network', oneOf(firstParam(url, ['network']), ['tcp', 'udp'], 'Hysteria2 network'));
  return { outbound };
}

function parseHysteria(input) {
  const url = parsedUrl(input, 'Hysteria');
  const outbound = {
    type: 'hysteria',
    server: requiredHost(url, 'Hysteria'),
    server_port: requiredPort(url, 'Hysteria', 443),
    tls: tlsFromUrl(url, { defaultEnabled: true })
  };
  const authStr = firstParam(url, ['auth_str', 'auth-str', 'auth']);
  const auth = firstParam(url, ['auth_base64', 'auth-base64']);
  if (authStr) outbound.auth_str = authStr;
  else if (auth) outbound.auth = auth;
  else throw new Error('Hysteria 分享链接缺少 auth 参数');
  const up = firstParam(url, ['up_mbps', 'upmbps']);
  const down = firstParam(url, ['down_mbps', 'downmbps']);
  if (!up || !down) throw new Error('Hysteria 分享链接需要 upmbps 和 downmbps 参数');
  addPositiveInteger(outbound, 'up_mbps', up);
  addPositiveInteger(outbound, 'down_mbps', down);
  addString(outbound, 'obfs', firstParam(url, ['obfs']));
  addString(outbound, 'network', oneOf(firstParam(url, ['network', 'protocol']), ['tcp', 'udp'], 'Hysteria network'));
  return { outbound };
}

function tlsFromUrl(url, { security = '', defaultEnabled = false } = {}) {
  const normalizedSecurity = String(security || '').toLowerCase();
  const enabled = defaultEnabled
    || ['tls', 'reality', '1', 'true'].includes(normalizedSecurity)
    || Boolean(firstParam(url, ['sni', 'peer', 'serverName', 'server_name', 'alpn', 'fp', 'fingerprint', 'pbk', 'publicKey', 'public-key']));
  if (!enabled) return null;
  return tlsFromFields({
    enabled: true,
    serverName: firstParam(url, ['sni', 'peer', 'serverName', 'server_name']),
    insecure: optionalBooleanParam(url, ['insecure', 'allowInsecure', 'allow_insecure', 'allow-insecure', 'skip-cert-verify']),
    alpn: firstParam(url, ['alpn']),
    fingerprint: firstParam(url, ['fp', 'fingerprint']),
    reality: normalizedSecurity === 'reality' || Boolean(firstParam(url, ['pbk', 'publicKey', 'public-key'])),
    publicKey: firstParam(url, ['pbk', 'publicKey', 'public-key']),
    shortId: firstParam(url, ['sid', 'shortId', 'short_id', 'short-id'])
  });
}

function tlsFromFields(fields) {
  if (!fields.enabled) return null;
  const tls = { enabled: true };
  addString(tls, 'server_name', cleanString(fields.serverName));
  const insecure = normalizeBoolean(fields.insecure);
  if (insecure !== undefined) tls.insecure = insecure;
  const alpn = splitList(cleanString(fields.alpn));
  if (alpn.length) tls.alpn = alpn;
  const fingerprint = cleanString(fields.fingerprint);
  if (fingerprint) tls.utls = { enabled: true, fingerprint };
  if (fields.reality) {
    const publicKey = cleanString(fields.publicKey);
    if (!publicKey) throw new Error('REALITY TLS 缺少 public key');
    tls.reality = { enabled: true, public_key: publicKey };
    addString(tls.reality, 'short_id', cleanString(fields.shortId));
  }
  return tls;
}

function transportFromUrl(url, label) {
  return transportFromFields({
    type: firstParam(url, ['type', 'transport', 'net']),
    host: firstParam(url, ['host']),
    path: firstParam(url, ['path']),
    method: firstParam(url, ['method']),
    serviceName: firstParam(url, ['serviceName', 'service_name', 'service']),
    earlyData: firstParam(url, ['ed', 'max_early_data']),
    earlyDataHeader: firstParam(url, ['eh', 'early_data_header_name'])
  }, label);
}

function transportFromFields(fields, label) {
  const rawType = cleanString(fields.type).toLowerCase();
  const headerType = cleanString(fields.headerType).toLowerCase();
  let type = rawType;
  if (type === 'h2') type = 'http';
  if (type === 'httpupgrade') type = 'httpupgrade';
  if ((!type || type === 'tcp') && headerType === 'http') type = 'http';
  if (!type || type === 'tcp' || type === 'none') return null;
  if (!SUPPORTED_V2RAY_TRANSPORTS.has(type)) throw new Error(`${label} 暂不支持 ${type} 传输，请先转换为本地 HTTP/SOCKS 端口`);
  let path = cleanString(fields.path);
  const host = cleanString(fields.host);
  const transport = { type };
  if (type === 'ws') {
    const pathOptions = websocketPathOptions(path, label);
    path = pathOptions.path;
    addString(transport, 'path', path);
    const headers = {};
    addString(headers, 'Host', firstListItem(host));
    if (Object.keys(headers).length) transport.headers = headers;
    const explicitEarlyData = cleanString(fields.earlyData);
    const explicitValue = explicitEarlyData ? parseWebsocketEarlyData(explicitEarlyData, label) : null;
    const pathValue = pathOptions.earlyData === null ? null : parseWebsocketEarlyData(pathOptions.earlyData, label);
    if (explicitValue !== null && pathValue !== null && explicitValue !== pathValue) {
      throw new Error(`${label} ws early data 与路径中的 ed 参数冲突`);
    }
    const earlyData = explicitValue ?? pathValue;
    if (earlyData !== null) transport.max_early_data = earlyData;
    const earlyDataHeader = cleanString(fields.earlyDataHeader)
      || (earlyData !== null && earlyData > 0 ? 'Sec-WebSocket-Protocol' : '');
    addString(transport, 'early_data_header_name', earlyDataHeader);
    return transport;
  }
  if (type === 'grpc') {
    addString(transport, 'service_name', cleanString(fields.serviceName) || path.replace(/^\/+/, ''));
    return transport;
  }
  if (type === 'http') {
    const hosts = splitList(host);
    if (hosts.length) transport.host = hosts;
    addString(transport, 'path', path);
    addString(transport, 'method', cleanString(fields.method));
    return transport;
  }
  if (type === 'httpupgrade') {
    addString(transport, 'host', firstListItem(host));
    addString(transport, 'path', path);
    return transport;
  }
  return transport;
}

function websocketPathOptions(value, label) {
  const path = cleanString(value);
  const queryOffset = path.indexOf('?');
  if (queryOffset < 0) return { path, earlyData: null };
  const fragmentOffset = path.indexOf('#', queryOffset);
  const queryEnd = fragmentOffset < 0 ? path.length : fragmentOffset;
  const parameters = new URLSearchParams(path.slice(queryOffset + 1, queryEnd));
  const earlyDataValues = parameters.getAll('ed');
  if (!earlyDataValues.length) return { path, earlyData: null };
  if (earlyDataValues.length > 1) throw new Error(`${label} ws 路径中的 ed 参数不能重复`);
  parameters.delete('ed');
  const remainingQuery = parameters.toString();
  return {
    path: `${path.slice(0, queryOffset)}${remainingQuery ? `?${remainingQuery}` : ''}${fragmentOffset < 0 ? '' : path.slice(fragmentOffset)}`,
    earlyData: earlyDataValues[0]
  };
}

function parseWebsocketEarlyData(value, label) {
  const earlyData = parseNonNegativeInteger(value, `${label} ws early data`);
  if (earlyData > 0xffffffff) throw new Error(`${label} ws early data 不能超过 4294967295`);
  return earlyData;
}

function parsedUrl(input, label) {
  try { return new URL(input); }
  catch { throw new Error(`${label} 分享链接必须是有效 URL`); }
}

function requiredHost(url, label) {
  const host = cleanString(url.hostname).replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`${label} 分享链接缺少服务器地址`);
  return host;
}

function requiredPort(url, label, fallback) {
  return parsePort(url.port || fallback, `${label} port`);
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 必须是 1–65535 的端口`);
  return port;
}

function parseNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} 必须是非负整数`);
  return number;
}

function addPositiveInteger(target, key, value) {
  if (!cleanString(value)) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${key} 必须是正整数`);
  target[key] = number;
}

function addString(target, key, value) {
  const text = cleanString(value);
  if (text) target[key] = text;
}

function cleanInput(value, label) {
  const input = String(value ?? '').trim();
  if (!input) throw new Error(`${label}不能为空`);
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error(`${label}不能包含控制字符`);
  return input;
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function requiredString(value, label) {
  const text = cleanString(value);
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

function decodedUser(url, label) {
  return decodePercent(url.username, label);
}

function decodedPassword(url, label) {
  return decodePercent(url.password, label);
}

function decodePercent(value, label) {
  try { return decodeURIComponent(String(value || '')); }
  catch { throw new Error(`${label} 包含无效的百分号编码`); }
}

function decodeUserInfo(value, label) {
  const decoded = decodePercent(value, label);
  if (decoded.includes(':')) return decoded;
  return base64DecodeText(value, label);
}

function base64DecodeText(value, label) {
  const raw = decodePercent(value, label).replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
  const decoded = Buffer.from(padded, 'base64').toString('utf8');
  if (!decoded) throw new Error(`${label} base64 为空`);
  return decoded;
}

function firstParam(url, names) {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null && value !== '') return value.trim();
  }
  return '';
}

function oneOf(value, values, label) {
  const text = cleanString(value);
  if (!text) return '';
  const normalized = text.toLowerCase();
  if (!values.includes(normalized)) throw new Error(`${label} 仅支持 ${values.join('、')}`);
  return normalized;
}

function normalizeVmessSecurity(value) {
  const security = cleanString(value || 'auto').toLowerCase();
  if (!VMESS_SECURITIES.has(security)) throw new Error(`VMess security 不支持 ${security}`);
  return security;
}

function optionalBooleanParam(url, names) {
  for (const name of names) {
    if (!url.searchParams.has(name)) continue;
    const value = url.searchParams.get(name);
    return value === '' ? true : normalizeBoolean(value);
  }
  return undefined;
}

function normalizeBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return undefined;
}

function splitList(value) {
  return cleanString(value).split(/[,|]/).map((item) => item.trim()).filter(Boolean);
}

function firstListItem(value) {
  return splitList(value)[0] || '';
}

function portRangeParam(value) {
  const text = cleanString(value);
  if (!text) return '';
  const normalized = text.replace('-', ':');
  const [left, right] = normalized.split(':');
  parsePort(left, '端口范围起点');
  parsePort(right || left, '端口范围终点');
  return normalized;
}

function hysteria2Obfs(url) {
  const rawType = firstParam(url, ['obfs', 'obfs_type', 'obfs-type']);
  const rawPassword = firstParam(url, ['obfs-password', 'obfs_password', 'obfsPassword']);
  if (!rawType && !rawPassword) return null;
  const normalizedType = rawType.toLowerCase();
  if (['salamander', 'gecko'].includes(normalizedType)) {
    const obfs = { type: normalizedType };
    addString(obfs, 'password', rawPassword);
    return obfs;
  }
  return { type: 'salamander', password: rawPassword || rawType };
}
