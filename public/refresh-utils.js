export async function optionalLoad(loader, fallback) {
  try { return { value: await loader(), fresh: true, error: null }; }
  catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return { value: fallback, fresh: false, error };
  }
}

export function summarizeSourceFailures(failures) {
  const entries = [...(failures instanceof Map ? failures : new Map())];
  if (!entries.length) return { message: '', detail: '' };
  return {
    message: `部分数据未更新：${entries.map(([name]) => name).join('、')}`,
    detail: entries.map(([name, message]) => `${name}：${String(message || '请求失败').slice(0, 300)}`).join('\n')
  };
}
