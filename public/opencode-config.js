const SDK_BY_PROTOCOL = Object.freeze({
  responses: '@ai-sdk/openai',
  claude: '@ai-sdk/anthropic',
  chat: '@ai-sdk/openai-compatible',
  gemini: '@ai-sdk/google'
});

const FALLBACK_ZEN_CAPABILITIES = Object.freeze({
  'gpt-5.6-terra': Object.freeze({
    protocol: 'responses', imageInput: true, inputModalities: ['text', 'image', 'pdf'],
    reasoning: true, toolCall: true, temperature: false,
    contextLimit: 1_050_000, inputLimit: 922_000, outputLimit: 128_000
  })
});

function normalizedRoot(root) {
  return String(root || '').replace(/\/+$/, '');
}

function imageHandoffSet(items, provider) {
  return new Set((Array.isArray(items) ? items : [])
    .filter((item) => item?.provider === provider && typeof item.model === 'string')
    .map((item) => item.model.trim().toLowerCase()));
}

function modelConfig(provider, model, capability, handoffModels, handoffAvailable) {
  const attachment = Boolean(capability.imageInput || (handoffAvailable && handoffModels.has(model)));
  const inputModalities = Array.isArray(capability.inputModalities) ? [...capability.inputModalities] : ['text'];
  if (attachment && !inputModalities.includes('image')) inputModalities.push('image');
  const limit = {
    context: capability.contextLimit,
    ...(capability.inputLimit ? { input: capability.inputLimit } : {}),
    output: capability.outputLimit
  };
  return {
    name: `${model} (${provider === 'go' ? 'Go' : 'Zen'})`,
    attachment,
    reasoning: Boolean(capability.reasoning),
    temperature: Boolean(capability.temperature),
    tool_call: Boolean(capability.toolCall),
    limit,
    modalities: { input: inputModalities, output: ['text'] },
    provider: { npm: SDK_BY_PROTOCOL[capability.protocol] }
  };
}

function providerModels(provider, capabilities, imageHandoffModels, handoffAvailable) {
  const handoffModels = imageHandoffSet(imageHandoffModels, provider);
  return Object.fromEntries(Object.entries(capabilities || {})
    .filter(([, capability]) => SDK_BY_PROTOCOL[capability?.protocol]
      && Number.isSafeInteger(capability.contextLimit)
      && Number.isSafeInteger(capability.outputLimit))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, capability]) => [model, modelConfig(provider, model, capability, handoffModels, handoffAvailable)]));
}

function defaultModelReference(defaultProvider, zenModels, goModels, availableProviders) {
  const preferredProvider = defaultProvider === 'zen' ? 'zen' : 'go';
  const catalogs = { zen: zenModels, go: goModels };
  const available = new Set((Array.isArray(availableProviders) ? availableProviders : [])
    .filter((provider) => provider === 'zen' || provider === 'go'));
  const providerOrder = available.size
    ? [preferredProvider, preferredProvider === 'zen' ? 'go' : 'zen'].filter((provider) => available.has(provider))
    : [preferredProvider, preferredProvider === 'zen' ? 'go' : 'zen'];
  const preferredModels = {
    zen: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna'],
    go: ['gpt-5.6-luna', 'deepseek-v4-flash']
  };
  for (const provider of providerOrder) {
    const models = catalogs[provider];
    const model = preferredModels[provider].find((id) => Object.hasOwn(models, id))
      || Object.keys(models)[0];
    if (model) return `bridge-${provider}/${model}`;
  }
  return undefined;
}

export function createOpenCodeConfig(root, goCapabilities, imageHandoffModels = [], {
  availableProviders, defaultProvider = 'go', imageHandoffTransport = 'disabled', zenCapabilities = FALLBACK_ZEN_CAPABILITIES
} = {}) {
  const base = normalizedRoot(root);
  const handoffAvailable = imageHandoffTransport === 'local' || imageHandoffTransport === 'remote';
  const zenModels = providerModels('zen', zenCapabilities, imageHandoffModels, handoffAvailable);
  const goModels = providerModels('go', goCapabilities, imageHandoffModels, handoffAvailable);

  const defaultModel = defaultModelReference(defaultProvider, zenModels, goModels, availableProviders);
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(defaultModel ? { model: defaultModel } : {}),
    provider: {
      'bridge-zen': {
        npm: '@ai-sdk/openai',
        name: 'OpenCode Bridge Zen · Native per model',
        options: { baseURL: `${base}/zen/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' },
        models: zenModels
      },
      'bridge-go': {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenCode Bridge Go · Native per model',
        options: { baseURL: `${base}/go/v1`, apiKey: '{env:OPENCODE_BRIDGE_TOKEN}' },
        models: goModels
      }
    }
  };
}

export { SDK_BY_PROTOCOL };
