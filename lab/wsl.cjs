'use strict';

const path = require('node:path');

const MISSING_SERVER = '此 Lab 构建未包含 WSL 语言服务，请在构建时加上 --wsl-server。';
const LINK_SCRIPT = `lab="$HOME/.agy-lab/gemini"; orig="$HOME/.gemini"
for rel in GEMINI.md skills config/skills; do
  src="$orig/$rel"; dst="$lab/$rel"
  [ -e "$src" ] || continue
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then continue; fi
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then rm "$dst"; elif [ -e "$dst" ]; then mv "$dst" "$dst.lab-local.$$"; fi
  ln -s "$src" "$dst"
done`;

const FORWARDED_AUTH_APP = 'ANTIGRAVITY_AUTH_SUCCESS_APP/u';
let warnedUnreachable = false;
let active = false;

function serverSha256() {
  try {
    return require('./wsl-server.json').sha256;
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') throw new Error(MISSING_SERVER);
    throw error;
  }
}

function installDir(version) {
  return `$HOME/.agy-lab-server/bin/${version}-${serverSha256().slice(0, 12)}`;
}

function bundledServer() {
  return path.join(process.resourcesPath, 'bin', 'language_server-linux-x64');
}

function forwardEnv(env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'wslenv') || 'WSLENV';
  const entries = (env[key] || '').split(':').filter(Boolean);
  if (!entries.includes(FORWARDED_AUTH_APP)) entries.push(FORWARDED_AUTH_APP);
  env[key] = entries.join(':');
}

async function proxyReachable({ distro, proxyUrl, expectProbe, execFile, wslExe }) {
  const probe = expectProbe();
  const port = new URL(proxyUrl).port;
  const command = 'exec 3<>"/dev/tcp/127.0.0.1/$1" && printf "GET %s HTTP/1.0\\r\\n\\r\\n" "$2" >&3 && cat <&3 >/dev/null';
  try {
    await execFile(wslExe, ['-d', distro, '--exec', 'bash', '-c', command, 'bash', port, probe.path], { timeout: 5000 });
  } catch {
    // A failed exec is the normal unreachable result; the probe decides either way.
  }
  const reachable = probe.seen();
  probe.cancel();
  return reachable;
}

function warnUnreachable() {
  if (warnedUnreachable) return;
  if (!require('./connections.cjs').listConnections().length) return;
  warnedUnreachable = true;
  void require('electron').dialog.showMessageBox({
    type: 'warning',
    title: '第三方模型在 WSL 中不可用',
    message: 'WSL 里的语言服务连不到 Windows 上的 Lab 模型代理，本次只能使用 Google 官方模型。',
    detail: '开启 WSL 镜像网络后即可使用：在 %UserProfile%\\.wslconfig 的 [wsl2] 下加入 networkingMode=mirrored，执行 wsl --shutdown，然后重新打开 Lab。',
    buttons: ['知道了'],
  });
}

async function prepareServer(distro, proxyEndpoint, officialEndpoint) {
  active = true;
  const wsl = require('../wsl');
  const home = await wsl.getDistroHome(distro);
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);
  try {
    // Rules and Skills carry no account state, so share the distro's original-app copies.
    await execFileAsync(wsl.WSL_EXE, ['-d', distro, '--exec', 'sh', '-c', LINK_SCRIPT, 'sh'], { timeout: 10000 });
  } catch (error) {
    console.error('[agy-lab] could not share rules and Skills in WSL: ' + error.message);
  }
  const reachable = await proxyReachable({
    distro,
    proxyUrl: proxyEndpoint,
    expectProbe: require('./cloud-proxy.cjs').expectProbe,
    execFile: execFileAsync,
    wslExe: wsl.WSL_EXE,
  });
  if (!reachable) warnUnreachable();
  return {
    geminiDir: `${home}/.agy-lab/gemini`,
    cloudEndpoint: reachable ? proxyEndpoint : officialEndpoint,
  };
}

module.exports = {
  LINK_SCRIPT,
  installDir,
  bundledServer,
  forwardEnv,
  proxyReachable,
  prepareServer,
  isActive: () => active,
  warnUnreachable,
};
