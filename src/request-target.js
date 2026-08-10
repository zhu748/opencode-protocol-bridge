export const MAX_REQUEST_TARGET_BYTES = 8 * 1024;
export const MAX_QUERY_PARAMETERS = 64;

const SINGLETON_QUERY_PARAMETERS = new Set(['provider', 'window', 'beta']);

function requestTargetError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function parseRequestTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    throw requestTargetError('请求目标必须使用 origin-form 路径');
  }
  if (Buffer.byteLength(target, 'utf8') > MAX_REQUEST_TARGET_BYTES) {
    throw requestTargetError(`请求目标不能超过 ${MAX_REQUEST_TARGET_BYTES / 1024} KiB`, 414);
  }
  if (target.includes('\\')) throw requestTargetError('请求目标不能包含反斜杠');
  if (target.includes('#')) throw requestTargetError('请求目标不能包含 URL 片段');

  let url;
  try {
    url = new URL(target, 'http://localhost');
  } catch {
    throw requestTargetError('请求目标格式无效');
  }

  let parameterCount = 0;
  const seenSingletons = new Set();
  for (const [name] of url.searchParams) {
    parameterCount++;
    if (parameterCount > MAX_QUERY_PARAMETERS) {
      throw requestTargetError(`查询参数不能超过 ${MAX_QUERY_PARAMETERS} 项`);
    }
    if (SINGLETON_QUERY_PARAMETERS.has(name)) {
      if (seenSingletons.has(name)) throw requestTargetError(`查询参数 ${name} 不能重复`);
      seenSingletons.add(name);
    }
  }
  return url;
}
