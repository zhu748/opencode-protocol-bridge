// OpenCode Go's public model endpoint only returns IDs. Protocols come from the
// official Go endpoint table; model metadata follows the models.dev catalog
// used by OpenCode itself. Keep this table explicit so unknown/future models
// still fall back to the existing name-based routing heuristics.
function capability(protocol, { input = ['text'], temperature = true, context, inputLimit, output }) {
  const inputModalities = Object.freeze([...input]);
  return Object.freeze({
    protocol,
    imageInput: inputModalities.includes('image'),
    inputModalities,
    reasoning: true,
    toolCall: true,
    temperature,
    contextLimit: context,
    ...(inputLimit ? { inputLimit } : {}),
    outputLimit: output
  });
}

export const OPENCODE_GO_MODEL_CAPABILITIES = Object.freeze({
  'deepseek-v4-flash': capability('chat', { context: 1_000_000, output: 384_000 }),
  'deepseek-v4-pro': capability('chat', { context: 1_000_000, output: 384_000 }),
  'glm-5': capability('chat', { context: 202_752, output: 32_768 }),
  'glm-5.1': capability('chat', { context: 202_752, output: 32_768 }),
  'glm-5.2': capability('chat', { context: 1_000_000, output: 131_072 }),
  'gpt-5.6-luna': capability('responses', { input: ['text', 'image', 'pdf'], temperature: false, context: 1_050_000, inputLimit: 922_000, output: 128_000 }),
  'grok-4.5': capability('responses', { input: ['text', 'image'], context: 500_000, output: 500_000 }),
  hy3: capability('chat', { context: 256_000, output: 64_000 }),
  // Still returned by /models but absent from the current catalog; inherit the
  // text-only Chat capability of the released Hy3 model conservatively.
  'hy3-preview': capability('chat', { context: 256_000, output: 64_000 }),
  'kimi-k2.5': capability('chat', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'kimi-k2.6': capability('chat', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'kimi-k2.7-code': capability('chat', { input: ['text', 'image', 'video'], temperature: false, context: 262_144, output: 262_144 }),
  'kimi-k3': capability('chat', { input: ['text', 'image', 'video'], temperature: false, context: 1_048_576, output: 131_072 }),
  'mimo-v2-omni': capability('chat', { input: ['text', 'image', 'audio', 'pdf'], context: 262_144, output: 128_000 }),
  'mimo-v2-pro': capability('chat', { context: 1_048_576, output: 128_000 }),
  'mimo-v2.5': capability('chat', { input: ['text', 'image', 'audio', 'video'], context: 1_000_000, output: 128_000 }),
  'mimo-v2.5-pro': capability('chat', { context: 1_048_576, output: 128_000 }),
  'minimax-m2.5': capability('claude', { context: 204_800, output: 65_536 }),
  'minimax-m2.7': capability('claude', { context: 204_800, output: 131_072 }),
  'minimax-m3': capability('claude', { input: ['text', 'image', 'video'], context: 1_000_000, output: 131_072 }),
  'qwen3.5-plus': capability('claude', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'qwen3.6-plus': capability('claude', { input: ['text', 'image', 'video'], context: 1_000_000, output: 65_536 }),
  'qwen3.7-max': capability('claude', { context: 1_000_000, output: 65_536 }),
  'qwen3.7-plus': capability('claude', { input: ['text', 'image', 'video'], context: 1_000_000, output: 65_536 }),
  'qwen3.8-max': capability('claude', { input: ['text', 'image', 'video'], context: 1_000_000, output: 131_072 })
});

// Zen exposes several native API families. In particular, its Gemini models use
// Google's generateContent endpoint rather than an OpenAI-compatible endpoint.
// The explicit catalog also prevents provider-specific endpoint changes from
// being hidden by name heuristics.
const ZEN_GEMINI = capability('gemini', { input: ['text', 'image', 'video', 'audio', 'pdf'], context: 1_048_576, output: 65_536 });
const ZEN_GPT_400_IMAGE = capability('responses', { input: ['text', 'image'], temperature: false, context: 400_000, inputLimit: 272_000, output: 128_000 });
const ZEN_GPT_400_DOCUMENT = capability('responses', { input: ['text', 'image', 'pdf'], temperature: false, context: 400_000, inputLimit: 272_000, output: 128_000 });
const ZEN_GPT_1050 = capability('responses', { input: ['text', 'image', 'pdf'], temperature: false, context: 1_050_000, inputLimit: 922_000, output: 128_000 });
const ZEN_CLAUDE_1M_128 = capability('claude', { input: ['text', 'image', 'pdf'], temperature: false, context: 1_000_000, output: 128_000 });
const ZEN_CLAUDE_1M_64 = capability('claude', { input: ['text', 'image', 'pdf'], context: 1_000_000, output: 64_000 });

export const OPENCODE_ZEN_MODEL_CAPABILITIES = Object.freeze({
  'big-pickle': capability('chat', { context: 200_000, inputLimit: 160_000, output: 32_000 }),
  'claude-fable-5': ZEN_CLAUDE_1M_128,
  'claude-haiku-4-5': capability('claude', { input: ['text', 'image', 'pdf'], context: 200_000, output: 64_000 }),
  'claude-opus-4-5': capability('claude', { input: ['text', 'image', 'pdf'], context: 200_000, output: 64_000 }),
  'claude-opus-4-6': capability('claude', { input: ['text', 'image', 'pdf'], context: 1_000_000, output: 128_000 }),
  'claude-opus-4-7': ZEN_CLAUDE_1M_128,
  'claude-opus-4-8': ZEN_CLAUDE_1M_128,
  'claude-opus-5': ZEN_CLAUDE_1M_128,
  'claude-sonnet-4': ZEN_CLAUDE_1M_64,
  'claude-sonnet-4-5': ZEN_CLAUDE_1M_64,
  'claude-sonnet-4-6': ZEN_CLAUDE_1M_64,
  'claude-sonnet-5': ZEN_CLAUDE_1M_128,
  'deepseek-v4-flash': capability('chat', { context: 1_000_000, output: 384_000 }),
  'deepseek-v4-flash-free': capability('chat', { context: 200_000, output: 128_000 }),
  'deepseek-v4-pro': capability('chat', { context: 1_000_000, output: 384_000 }),
  'gemini-3-flash': ZEN_GEMINI,
  'gemini-3.1-pro': ZEN_GEMINI,
  'gemini-3.5-flash': ZEN_GEMINI,
  'gemini-3.5-flash-lite': ZEN_GEMINI,
  'gemini-3.6-flash': ZEN_GEMINI,
  'gemini-3.7-flash': ZEN_GEMINI,
  'glm-5': capability('chat', { context: 204_800, output: 131_072 }),
  'glm-5.1': capability('chat', { context: 204_800, output: 131_072 }),
  'glm-5.2': capability('chat', { context: 1_000_000, output: 131_072 }),
  'gpt-5': ZEN_GPT_400_IMAGE,
  'gpt-5-codex': ZEN_GPT_400_IMAGE,
  'gpt-5-nano': ZEN_GPT_400_IMAGE,
  'gpt-5.1': ZEN_GPT_400_IMAGE,
  'gpt-5.1-codex': ZEN_GPT_400_IMAGE,
  'gpt-5.1-codex-max': ZEN_GPT_400_IMAGE,
  'gpt-5.1-codex-mini': ZEN_GPT_400_IMAGE,
  'gpt-5.2': ZEN_GPT_400_IMAGE,
  'gpt-5.2-codex': ZEN_GPT_400_DOCUMENT,
  'gpt-5.3-codex': ZEN_GPT_400_DOCUMENT,
  'gpt-5.3-codex-spark': capability('responses', { temperature: false, context: 128_000, inputLimit: 128_000, output: 128_000 }),
  'gpt-5.4': ZEN_GPT_1050,
  'gpt-5.4-mini': ZEN_GPT_400_DOCUMENT,
  'gpt-5.4-nano': ZEN_GPT_400_DOCUMENT,
  'gpt-5.4-pro': ZEN_GPT_1050,
  'gpt-5.5': ZEN_GPT_1050,
  'gpt-5.5-pro': ZEN_GPT_1050,
  'gpt-5.6-luna': ZEN_GPT_1050,
  'gpt-5.6-sol': ZEN_GPT_1050,
  'gpt-5.6-terra': ZEN_GPT_1050,
  'grok-4.5': capability('responses', { input: ['text', 'image'], context: 500_000, output: 500_000 }),
  'grok-4.6': capability('responses', { input: ['text', 'image'], context: 500_000, output: 500_000 }),
  'grok-build-0.1': capability('responses', { input: ['text', 'image', 'pdf'], context: 256_000, output: 256_000 }),
  'hy3-free': capability('chat', { context: 190_000, output: 64_000 }),
  'kimi-k2.5': capability('chat', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'kimi-k2.6': capability('chat', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'kimi-k2.7-code': capability('chat', { input: ['text', 'image', 'video'], temperature: false, context: 262_144, output: 262_144 }),
  'kimi-k3': capability('chat', { input: ['text', 'image', 'video'], temperature: false, context: 1_048_576, output: 131_072 }),
  'laguna-s-2.1-free': capability('chat', { context: 256_000, output: 32_000 }),
  'ling-3.0-flash-free': capability('chat', { context: 262_144, output: 32_768 }),
  'ling-3.0-tiny-free': capability('chat', { context: 262_144, output: 32_768 }),
  'longcat-2.0-free': capability('chat', { context: 1_000_000, output: 131_072 }),
  'mimo-v2.5-free': capability('chat', { input: ['text', 'image', 'audio', 'video'], context: 200_000, output: 32_000 }),
  'minimax-m2.5': capability('chat', { context: 204_800, output: 131_072 }),
  'minimax-m2.7': capability('chat', { context: 204_800, output: 131_072 }),
  'minimax-m3': capability('chat', { input: ['text', 'image', 'video'], context: 512_000, output: 128_000 }),
  'muse-spark-1.2': capability('responses', { input: ['text', 'image', 'video', 'pdf', 'audio'], context: 1_048_576, output: 131_072 }),
  'nemotron-3.5-lightning-free': capability('chat', { context: 262_144, output: 262_144 }),
  'nemotron-3-ultra-free': capability('chat', { context: 1_000_000, output: 128_000 }),
  'north-mini-code-free': capability('chat', { context: 256_000, output: 64_000 }),
  'qwen3.5-plus': capability('claude', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  'qwen3.6-plus': capability('claude', { input: ['text', 'image', 'video'], context: 262_144, output: 65_536 }),
  // Listed in the current Zen endpoint table but temporarily absent from /models.
  'qwen3.7-max': capability('claude', { context: 1_000_000, output: 65_536 }),
  'qwen3.7-plus': capability('claude', { input: ['text', 'image', 'video'], context: 1_000_000, output: 65_536 })
});

export const OPENCODE_GO_TEXT_ONLY_MODELS = Object.freeze(Object.entries(OPENCODE_GO_MODEL_CAPABILITIES)
  .filter(([, capability]) => !capability.imageInput)
  .map(([model]) => model));

export const OPENCODE_ZEN_TEXT_ONLY_MODELS = Object.freeze(Object.entries(OPENCODE_ZEN_MODEL_CAPABILITIES)
  .filter(([, capability]) => !capability.imageInput)
  .map(([model]) => model));

export function openCodeGoModelCapability(model) {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase().replace(/^opencode-go\//, '');
  return OPENCODE_GO_MODEL_CAPABILITIES[id] || null;
}

export function openCodeZenModelCapability(model) {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase().replace(/^opencode\//, '');
  return OPENCODE_ZEN_MODEL_CAPABILITIES[id] || null;
}

export function openCodeModelCapability(provider, model) {
  if (provider === 'go') return openCodeGoModelCapability(model);
  if (provider === 'zen') return openCodeZenModelCapability(model);
  return null;
}

const OPENCODE_MAX_REASONING_BY_MODEL = Object.freeze(Object.fromEntries([
  ...[
    'deepseek-v4-flash', 'deepseek-v4-flash-free', 'deepseek-v4-pro', 'glm-5.2',
    'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'kimi-k3',
    'claude-fable-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
    'claude-opus-5', 'claude-sonnet-4-6', 'claude-sonnet-5'
  ].map((model) => [model, 'max']),
  ...[
    'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex',
    'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
    'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.5-pro', 'grok-4.6', 'muse-spark-1.2'
  ].map((model) => [model, 'xhigh']),
  ...[
    'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.6-flash', 'gemini-3.7-flash', 'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
    'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'grok-4.5', 'hy3-free',
    'laguna-s-2.1-free', 'ling-3.0-flash-free', 'north-mini-code-free'
  ].map((model) => [model, 'high']),
  ...['minimax-m3'].map((model) => [model, 'adaptive']),
  ...[
    'claude-haiku-4-5', 'claude-sonnet-4', 'claude-sonnet-4-5',
    'qwen3.5-plus', 'qwen3.6-plus'
  ].map((model) => [model, 'budget:31999']),
  ...['claude-opus-4-5'].map((model) => [model, 'legacy-high'])
]));

export function openCodeMaximumReasoningEffort(model, protocol) {
  if (typeof model !== 'string') return null;
  const id = model.trim().toLowerCase().replace(/^(?:opencode-go|opencode)\//, '');
  const capability = [OPENCODE_ZEN_MODEL_CAPABILITIES[id], OPENCODE_GO_MODEL_CAPABILITIES[id]]
    .find((item) => item?.protocol === protocol);
  if (!capability) return null;
  return OPENCODE_MAX_REASONING_BY_MODEL[id] || 'model-default';
}

export function normalizeRequestedModel(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('model 必须是长度 1–256 且不含控制字符的非空字符串');
  }
  const model = value.trim();
  if (!model) throw new TypeError('model 必须是长度 1–256 且不含控制字符的非空字符串');
  return model;
}
