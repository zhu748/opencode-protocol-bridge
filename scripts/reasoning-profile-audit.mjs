const EFFORT_RANK = new Map([
  ['none', 0], ['minimal', 1], ['low', 2], ['medium', 3], ['high', 4], ['xhigh', 5], ['max', 6]
]);

export function expectedReasoningProfile(model, metadata, protocol) {
  const options = metadata?.reasoning_options;
  if (options === undefined) return undefined;
  if (!Array.isArray(options)) throw new TypeError('reasoning_options 必须是数组');
  const knownTypes = new Set(['effort', 'toggle', 'budget_tokens']);
  const optionTypes = options.map((option) => {
    if (!option || Array.isArray(option) || typeof option !== 'object' || !knownTypes.has(option.type)) {
      throw new TypeError('reasoning_options 包含未知类型');
    }
    return option.type;
  });
  if (new Set(optionTypes).size !== optionTypes.length) throw new TypeError('reasoning_options 包含重复类型');

  const effort = options.find((option) => option?.type === 'effort');
  if (effort) {
    if (!Array.isArray(effort.values) || !effort.values.length) throw new TypeError('effort.values 必须是非空数组');
    const values = effort.values.map((value) => value === null ? 'none' : value);
    if (values.some((value) => typeof value !== 'string' || !EFFORT_RANK.has(value))) throw new TypeError('effort.values 包含未知档位');
    const maximum = values.reduce((left, right) => EFFORT_RANK.get(left) >= EFFORT_RANK.get(right) ? left : right);
    if (model === 'claude-opus-4-5' && protocol === 'claude' && maximum === 'high') return 'legacy-high';
    return maximum === 'none' ? 'model-default' : maximum;
  }

  const budget = options.find((option) => option?.type === 'budget_tokens');
  if (budget && protocol === 'claude') {
    const outputLimit = metadata?.limit?.output;
    if (!Number.isSafeInteger(outputLimit) || outputLimit <= 1024) throw new TypeError('budget_tokens 缺少可用的输出上限');
    const declaredMaximum = budget.max === undefined ? 31_999 : budget.max;
    if (!Number.isSafeInteger(declaredMaximum) || declaredMaximum < 1024) throw new TypeError('budget_tokens.max 无效');
    if (budget.min !== undefined && (!Number.isSafeInteger(budget.min) || budget.min < 0 || budget.min > declaredMaximum)) {
      throw new TypeError('budget_tokens.min 无效');
    }
    return `budget:${Math.min(31_999, declaredMaximum, outputLimit - 1)}`;
  }

  if (model === 'minimax-m3') return 'adaptive';
  return 'model-default';
}

export function reasoningProfileAuditError({ model, metadata, protocol, actual }) {
  let expected;
  try {
    expected = expectedReasoningProfile(model, metadata, protocol);
  } catch (error) {
    return `${model} models.dev ${error.message}`;
  }
  if (expected === undefined) return undefined;
  if (actual !== expected) return `${model} 最高思考策略不一致：本地=${String(actual)}, models.dev=${expected}`;
  return undefined;
}
