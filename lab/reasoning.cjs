'use strict';

const STANDARD = ['low', 'medium', 'high'];
const EXTENDED = [...STANDARD, 'xhigh'];
const MAXIMUM = [...EXTENDED, 'max'];

// The standard OpenAI model list does not include reasoning capabilities.
// Use documented families only; provider-reported levels override these defaults.
function knownEfforts(model) {
  const family = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  switch (family) {
    case 'gpt-6.2-astra':
    case 'gpt-6.2-sol':
    case 'gpt-6.1-sol':
    case 'gpt-6-astra': return MAXIMUM;
    case 'gpt-6.1-terra':
    case 'gpt-6-sol':
    case 'gpt-6-luna':
    case 'gpt-5.6':
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna': return ['none', ...MAXIMUM];
    case 'gpt-5.5':
    case 'gpt-5.4':
    case 'gpt-5.2': return ['none', ...EXTENDED];
    case 'gpt-5':
    case 'gpt-5-mini':
    case 'gpt-5-nano': return ['minimal', ...STANDARD];
    case 'o3':
    case 'o3-mini':
    case 'o4-mini': return STANDARD;
    default: return [];
  }
}

function reasoningVariants(connection) {
  const model = connection.model;
  const id = model.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'external-model';
  const efforts = connection.reasoningEfforts ?? knownEfforts(model);
  return [
    { id, label: model },
    ...efforts.map(effort => ({ id: id + '-' + effort, label: model + ' · ' + effort, effort })),
  ];
}

function usesOpenAIResponses(connection, request, effort) {
  if (connection?.authType === 'siwc') return true;
  const official = new URL(connection.baseUrl).origin === 'https://api.openai.com';
  return official && knownEfforts(connection.model).length > 0 &&
    (effort !== undefined || request.tools?.length > 0);
}

module.exports = { reasoningVariants, usesOpenAIResponses };
