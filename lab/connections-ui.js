'use strict';
const api = window.modelConnections;
const $ = id => document.getElementById(id);

let busy = false;
let sourceId;
let sourceMode = 'custom';
let session = {};
let signingIn = false;
let availableModels = [];
const selectedModels = new Set();

function reportError(error) {
  $('status').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function updateControls() {
  $('baseUrl').disabled = busy || sourceMode !== 'custom';
  $('apiKey').disabled = busy || sourceMode !== 'custom';
  $('fetchModels').disabled = busy || (sourceMode === 'siwc' && !session.sharing);
  $('siwcSignIn').disabled = busy;
  $('siwcCancel').hidden = !signingIn;
  $('siwcModels').disabled = busy || !session.sharing;
  $('siwcSignOut').hidden = !['connected', 'reauth_required'].includes(session.status);
  $('siwcSignOut').disabled = busy;
  $('newSource').hidden = sourceMode === 'custom';
  $('newSource').disabled = busy;
  $('picker').hidden = !availableModels.length;
  $('filter').disabled = busy;
  $('selectAll').disabled = busy || !visibleModels().length;
  $('models').querySelectorAll('input').forEach(control => { control.disabled = busy; });
  $('save').disabled = busy || !selectedModels.size;
  $('list').querySelectorAll('button').forEach(control => { control.disabled = busy; });
}

function visibleModels() {
  const query = $('filter').value.toLocaleLowerCase().trim();
  return availableModels.filter(model => `${model.id} ${model.displayName || ''}`.toLocaleLowerCase().includes(query));
}

function updateSelection() {
  const visible = visibleModels();
  const chosen = visible.filter(model => selectedModels.has(model.id)).length;
  $('selectAll').checked = visible.length > 0 && chosen === visible.length;
  $('selectAll').indeterminate = chosen > 0 && chosen < visible.length;
  $('modelCount').textContent = `已选 ${selectedModels.size} / ${availableModels.length}`;
  updateControls();
}

function renderModels() {
  $('models').replaceChildren(...visibleModels().map(model => {
    const row = document.createElement('label');
    const box = document.createElement('input');
    const name = document.createElement('span');
    row.className = 'check';
    box.type = 'checkbox';
    box.value = model.id;
    box.checked = selectedModels.has(model.id);
    name.textContent = model.displayName || model.id;
    row.append(box, name);
    if (model.displayName && model.displayName !== model.id) {
      const id = document.createElement('span');
      id.className = 'id';
      id.textContent = model.id;
      row.append(id);
    }
    return row;
  }));
  updateSelection();
}

function clearModels() {
  availableModels = [];
  selectedModels.clear();
  $('filter').value = '';
  renderModels();
}

function sourceInput() {
  if (sourceMode === 'siwc') return { authType: 'siwc' };
  return sourceId
    ? { connectionId: sourceId }
    : { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value };
}

async function runBusy(message, operation) {
  if (busy) return;
  busy = true;
  updateControls();
  $('status').textContent = message;
  try {
    await operation();
  } catch (error) {
    reportError(error);
  } finally {
    busy = false;
    updateControls();
  }
}

function button(label, action, className = 'quiet') {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.textContent = label;
  control.onclick = action;
  control.disabled = busy;
  return control;
}

async function fetchModels() {
  if (sourceMode === 'custom' && !$('baseUrl').reportValidity()) return;
  const input = sourceInput();
  clearModels();
  await runBusy('正在获取模型…', async () => {
    availableModels = await api.discover(input).finally(() => { if (input.authType === 'siwc') return refreshSession(); });
    renderModels();
    $('status').textContent = availableModels.length ? '' : '服务未返回可用模型。';
  });
}

function useSavedSource(row) {
  sourceMode = row.authType === 'siwc' ? 'siwc' : 'saved';
  sourceId = row.id;
  $('baseUrl').value = row.baseUrl;
  $('apiKey').value = '';
  $('apiKey').placeholder = sourceMode === 'siwc' ? '使用 ChatGPT 订阅授权' : '使用已保存的密钥';
  clearModels();
  return fetchModels();
}

async function renderConnections() {
  const rows = await api.list();
  $('list').replaceChildren();
  for (const row of rows) {
    const item = document.createElement('li');
    const title = document.createElement('div');
    const name = document.createElement('div');
    const address = document.createElement('div');
    title.className = 'grow';
    name.className = 'name';
    address.className = 'address';
    name.textContent = row.model;
    address.textContent = row.authType === 'siwc' ? `ChatGPT 订阅 · ${row.baseUrl}` : row.baseUrl;
    title.append(name, address);
    const add = button('获取模型', () => useSavedSource(row));
    const test = mode => runBusy('正在测试 ' + row.model + '…', async () => {
      const result = await api.test(row.id, mode).finally(() => { if (row.authType === 'siwc') return refreshSession(); });
      $('status').textContent = row.model + '：' + result;
    });
    const chat = button('测试对话', () => test('chat'));
    const tools = button('测试工具', () => test('tools'));
    const remove = button('移除', () => runBusy('正在移除…', async () => {
      await api.remove(row.id);
      if (sourceId === row.id) {
        sourceId = undefined;
        sourceMode = 'custom';
        $('apiKey').placeholder = '本机模型可留空';
        clearModels();
      }
      $('status').textContent = '已移除 ' + row.model;
      await renderConnections();
    }), 'quiet danger');
    item.append(title, add, chat, tools, remove);
    $('list').append(item);
  }
}

function renderSession(next) {
  session = next;
  const account = next.account?.email || next.account?.name;
  $('siwcStatus').textContent = next.status === 'connected'
    ? `${account ? account + ' · ' : ''}${next.sharing ? '已授权订阅共享' : '已登录，未授权订阅共享'}`
    : next.status === 'reauth_required' ? '登录已失效' : '未登录';
  $('siwcSignIn').textContent = next.status === 'connected' ? '重新授权' : next.status === 'reauth_required' ? '重新登录' : 'Sign in with ChatGPT';
  updateControls();
}
async function refreshSession() {
  try { renderSession(await api.siwcStatus()); } catch { /* Preserve the request result. */ }
}

$('siwcSignIn').onclick = () => runBusy('请在系统浏览器完成 ChatGPT 授权…', async () => {
  signingIn = true;
  updateControls();
  try {
    renderSession(await api.siwcSignIn(session.status === 'connected'));
    if (sourceMode === 'siwc') clearModels();
    $('status').textContent = session.sharing ? '已完成授权，可以获取订阅模型。' : '已登录，但未授权订阅共享。';
  } finally { signingIn = false; await refreshSession(); }
});
$('siwcCancel').onclick = () => api.siwcCancelSignIn().catch(reportError);
$('siwcSignOut').onclick = () => runBusy('正在退出 ChatGPT…', async () => {
  const result = await api.siwcSignOut();
  renderSession(result);
  if (sourceMode === 'siwc') clearModels();
  $('status').textContent = result.warning || '已退出 ChatGPT。';
});
$('siwcModels').onclick = () => {
  sourceMode = 'siwc';
  sourceId = undefined;
  $('baseUrl').value = 'https://api.openai.com/v1';
  $('apiKey').value = '';
  $('apiKey').placeholder = '使用 ChatGPT 订阅授权';
  return fetchModels();
};
$('fetchModels').onclick = fetchModels;
$('newSource').onclick = () => {
  sourceMode = 'custom';
  sourceId = undefined;
  $('baseUrl').value = '';
  $('apiKey').value = '';
  $('apiKey').placeholder = '本机模型可留空';
  $('status').textContent = '';
  clearModels();
  $('baseUrl').focus();
};
$('baseUrl').oninput = clearModels;
$('apiKey').oninput = clearModels;
$('filter').oninput = renderModels;
$('models').onchange = event => {
  if (event.target.checked) selectedModels.add(event.target.value);
  else selectedModels.delete(event.target.value);
  updateSelection();
};
$('selectAll').onchange = () => {
  const select = $('selectAll').checked;
  for (const model of visibleModels()) {
    if (select) selectedModels.add(model.id);
    else selectedModels.delete(model.id);
  }
  renderModels();
};
$('form').onsubmit = event => {
  event.preventDefault();
  const input = { ...sourceInput(), models: availableModels.filter(model => selectedModels.has(model.id)) };
  runBusy('正在添加模型…', async () => {
    const saved = await api.saveDiscovered(input);
    sourceMode = saved[0].authType === 'siwc' ? 'siwc' : 'saved';
    sourceId = saved[0].id;
    $('baseUrl').value = saved[0].baseUrl;
    $('apiKey').value = '';
    $('apiKey').placeholder = sourceMode === 'siwc' ? '使用 ChatGPT 订阅授权' : '使用已保存的密钥';
    selectedModels.clear();
    renderModels();
    await renderConnections();
    $('status').textContent = `已添加 ${saved.length} 个模型。重启 Antigravity Lab 后，可在模型菜单和 Orchestrator Settings 中选择。`;
  });
};
Promise.all([renderConnections(), api.siwcStatus().then(renderSession)]).catch(reportError);
updateControls();
