'use strict';

let googleAccounts = [];
function renderGoogleAccounts(result) {
  $('googleSection').hidden = !result.supported;
  if (!result.supported) return;
  googleAccounts = result.accounts;
  $('googleAccounts').replaceChildren(...googleAccounts.map(account => {
    const row = document.createElement('li');
    const title = document.createElement('div');
    const name = document.createElement('div');
    title.className = 'grow';
    name.className = 'name';
    if (account.current) {
      const current = document.createElement('span');
      current.className = 'current';
      current.textContent = '当前';
      name.append(current);
    }
    name.append(document.createTextNode(account.email));
    title.append(name);
    row.append(title);
    if (!account.current) row.append(button('切换', () => runBusy('正在切换…', async () => {
      renderGoogleAccounts(await api.googleSwitch(account.email));
      $('status').textContent = `已切换到 ${account.email}，主窗口会重新加载。`;
    })));
    row.append(button('移除', () => runBusy('正在移除…', async () => {
      renderGoogleAccounts(await api.googleRemove(account.email));
      $('status').textContent = account.current
        ? `已移除 ${account.email}，主窗口已退出登录。` : `已移除 ${account.email}。`;
    }), 'quiet danger'));
    return row;
  }));
  $('googleEmpty').hidden = googleAccounts.length > 0;
  updateControls();
}
async function refreshGoogleAccounts() {
  try { renderGoogleAccounts(await api.googleAccounts()); } catch (error) { reportError(error); }
}
$('googleAdd').onclick = () => runBusy('正在准备登录…', async () => {
  const hadCurrent = googleAccounts.some(account => account.current);
  renderGoogleAccounts(await api.googleAdd());
  $('status').textContent = hadCurrent
    ? '已保留当前账号。请在主窗口登录另一个 Google 账号，回到这里就能看到它。'
    : '请在主窗口登录 Google 账号。';
});
window.addEventListener('focus', () => { if (!busy) void refreshGoogleAccounts(); });
void refreshGoogleAccounts();
