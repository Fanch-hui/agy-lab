'use strict';

// Registers saved external connections in the language server's model catalogue.
// Each connection becomes one group of models (one per reasoning effort), each bound to a
// placeholder model enum that the official catalogue does not use. Bindings are persisted so
// a model keeps its enum across restarts.
const fs = require('node:fs');
const { reasoningVariants } = require('./reasoning.cjs');

const MODEL_PREFIX = 'agy-ext-';
const SLOT_FIRST = 1200;
const SLOT_LAST = 1650;
const CONTEXT_TOKENS = 200000;
const OUTPUT_TOKENS = 32768;

function groupId(connection) {
  return MODEL_PREFIX + connection.id.replace(/-/g, '').slice(0, 12);
}

function title(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Returns the catalogue variants of one connection. A connection with reasoning efforts is
// shown as a group whose members are `<group>-<effort>`, like the official thinking levels.
function variantsFor(connection) {
  const group = groupId(connection);
  // The picker groups models into families by display name; the host keeps the same model
  // from two providers apart.
  const label = `${connection.model} · ${connection.authType === 'siwc' ? 'ChatGPT 订阅' : new URL(connection.baseUrl).host}`;
  const efforts = reasoningVariants(connection).slice(1).map(option => option.effort);
  if (!efforts.length) return { group, label, efforts, variants: [{ id: group, label, connectionId: connection.id }] };
  return {
    group, label, efforts,
    variants: efforts.map(effort => ({
      id: `${group}-${effort}`, label: `${label} (${title(effort)})`, connectionId: connection.id, effort,
    })),
  };
}

class SlotTable {
  constructor(file) {
    this.file = file;
    this.slots = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }

  // Binds every id to a placeholder number outside `reserved`; rebinding happens only when
  // the official catalogue starts using a number.
  assign(ids, reserved) {
    const taken = new Set(reserved);
    let changed = false;
    for (const id of ids) {
      const slot = this.slots[id];
      if (slot !== undefined && !taken.has(slot)) {
        taken.add(slot);
        continue;
      }
      if (slot !== undefined) console.error(`外部模型 ${id} 的编号 M${slot} 已被官方目录占用，改用新编号。`);
      const free = [];
      for (let number = SLOT_FIRST; number <= SLOT_LAST && !free.length; number++) {
        if (!taken.has(number) && !Object.values(this.slots).includes(number)) free.push(number);
      }
      if (!free.length) throw new Error('外部模型编号已用完。');
      this.slots[id] = free[0];
      taken.add(free[0]);
      changed = true;
    }
    if (changed && this.file) {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.slots), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    }
    return Object.fromEntries(ids.map(id => [id, this.slots[id]]));
  }
}

function placeholderNumber(value) {
  const match = /^MODEL_PLACEHOLDER_M(\d+)$/.exec(value || '');
  return match ? Number(match[1]) : undefined;
}

function catalogueEntry(variant, slot) {
  return {
    displayName: variant.label,
    model: `MODEL_PLACEHOLDER_M${slot}`,
    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
    supportsImages: false,
    supportsThinking: Boolean(variant.effort),
    recommended: true,
    maxTokens: CONTEXT_TOKENS,
    maxOutputTokens: OUTPUT_TOKENS,
    quotaInfo: { remainingFraction: 1 },
  };
}

// Adds the external models to a fetchAvailableModels response. Connections whose ids clash
// with official models are skipped rather than overriding the official entry.
function injectCatalogue(catalogue, connections, slotTable) {
  const official = catalogue.models || {};
  const reserved = Object.values(official).map(entry => placeholderNumber(entry.model)).filter(Number.isInteger);
  const groups = connections.map(variantsFor).filter(group => {
    const clash = group.variants.some(variant => variant.id in official) || group.group in (catalogue.groupedModels || {});
    if (clash) console.error(`外部模型 ${group.label} 与官方模型重名，已跳过。`);
    return !clash;
  });
  const variants = groups.flatMap(group => group.variants);
  if (!variants.length) return { catalogue, variants: new Map() };
  const slots = slotTable.assign(variants.map(variant => variant.id), reserved);
  const models = { ...official };
  for (const variant of variants) models[variant.id] = catalogueEntry(variant, slots[variant.id]);
  const groupedModels = { ...catalogue.groupedModels };
  for (const group of groups.filter(item => item.efforts.length)) {
    groupedModels[group.group] = {
      displayName: group.label,
      supportedThinkingLevels: group.efforts.map(effort => ({ thinkingSuffix: effort, thinkingDisplayName: title(effort) })),
    };
  }
  const ids = variants.map(variant => variant.id);
  // The picker shows only the first group of the Recommended sort, so external models join it.
  const agentModelSorts = (catalogue.agentModelSorts || []).map(sort => {
    const [first, ...rest] = sort.groups || [];
    return { ...sort, groups: [{ ...first, modelIds: [...(first?.modelIds || []), ...ids] }, ...rest] };
  });
  return {
    catalogue: { ...catalogue, models, groupedModels, agentModelSorts },
    variants: new Map(variants.map(variant => [variant.id, variant])),
  };
}

function resolveVariant(modelId, connections) {
  if (!modelId?.startsWith(MODEL_PREFIX)) return undefined;
  for (const connection of connections) {
    const variant = variantsFor(connection).variants.find(item => item.id === modelId);
    if (variant) return variant;
  }
  return undefined;
}

module.exports = { MODEL_PREFIX, SlotTable, injectCatalogue, resolveVariant, variantsFor };
