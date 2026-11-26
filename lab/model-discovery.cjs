'use strict';

const { normalizeBaseUrl } = require('./provider.cjs');

const { SIWC_RESOURCE_URL, formatSiwcError } = require('./siwc.cjs');

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => REASONING_EFFORTS.has(item)))];
}

// Services name the context size differently: ChatGPT and OpenAI use `context_window`,
// OpenRouter `context_length`, LM Studio `max_context_length`.
function reportedContext(model) {
  const value = model.context_window ?? model.context_length ?? model.max_context_length;
  return Number.isInteger(value) && value > 0 ? { contextTokens: value } : {};
}

async function discoverModels({ baseUrl, apiKey, authType }, signal) {
  const url = (authType === 'siwc' ? SIWC_RESOURCE_URL : normalizeBaseUrl(baseUrl.trim())) + '/models';
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  if (authType === 'siwc') {
    const body = await response.json().catch(() => null);
    if (!response.ok) throw formatSiwcError(body, response.status);
    if (!Array.isArray(body?.models)) throw new Error('ChatGPT 订阅返回的模型列表格式不受支持。');
    const entries = new Map();
    for (const model of body.models) {
      if (model?.visibility !== 'list' || typeof model.slug !== 'string' || !model.slug.trim() || model.slug.length > 200 || entries.has(model.slug)) continue;
      const displayName = typeof model.display_name === 'string' && model.display_name.length <= 200 ? model.display_name.trim() : '';
      const reasoningEfforts = normalizeReasoningEfforts(model.supported_reasoning_efforts ?? model.reasoning_efforts);
      entries.set(model.slug, {
        id: model.slug, ...(displayName ? { displayName } : {}),
        ...(reasoningEfforts.length ? { reasoningEfforts } : {}), ...reportedContext(model),
      });
    }
    return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }
  if (!response.ok) throw new Error(`获取模型失败：服务返回 HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('服务返回的模型列表格式不受支持。');
  const models = new Map();
  for (const model of result.data) {
    if (typeof model?.id !== 'string' || !model.id.trim() || models.has(model.id)) continue;
    const reasoningEfforts = normalizeReasoningEfforts(
      model.supported_reasoning_efforts ?? model.reasoning_efforts,
    );
    models.set(model.id, { id: model.id, ...(reasoningEfforts.length ? { reasoningEfforts } : {}), ...reportedContext(model) });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

module.exports = { discoverModels, normalizeReasoningEfforts };
