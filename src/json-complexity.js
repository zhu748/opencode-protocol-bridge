export const MAX_JSON_NESTING_DEPTH = 256;
export const MAX_JSON_STRUCTURE_NODES = 250_000;

export function assertJsonComplexity(root, {
  label = 'JSON',
  code,
  depthStatus,
  nodesStatus
} = {}) {
  const values = [root];
  const depths = [0];
  let nodes = 1;

  const fail = (kind) => {
    const depth = kind === 'depth';
    const limit = depth ? MAX_JSON_NESTING_DEPTH : MAX_JSON_STRUCTURE_NODES;
    const message = depth
      ? `${label} 嵌套深度不能超过 ${limit} 层`
      : `${label} 结构不能超过 ${limit} 个值`;
    const error = new Error(message);
    if (code) error.code = code;
    const status = depth ? depthStatus : nodesStatus;
    if (Number.isInteger(status)) error.status = status;
    throw error;
  };

  while (values.length) {
    const value = values.pop();
    const depth = depths.pop();
    if (!value || typeof value !== 'object') continue;
    const childDepth = depth + 1;
    if (childDepth > MAX_JSON_NESTING_DEPTH) fail('depth');

    if (Array.isArray(value)) {
      nodes += value.length;
      if (nodes > MAX_JSON_STRUCTURE_NODES) fail('nodes');
      for (let index = 0; index < value.length; index++) {
        const child = value[index];
        if (!child || typeof child !== 'object') continue;
        values.push(child);
        depths.push(childDepth);
      }
    } else {
      const keys = Object.keys(value);
      nodes += keys.length;
      if (nodes > MAX_JSON_STRUCTURE_NODES) fail('nodes');
      for (const key of keys) {
        const child = value[key];
        if (!child || typeof child !== 'object') continue;
        values.push(child);
        depths.push(childDepth);
      }
    }
  }
}
