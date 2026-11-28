'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

const prelude = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgyLabCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public uint LastWrittenLow; public uint LastWrittenHigh;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  public static int Read(string target, out byte[] blob) {
    blob = null;
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return Marshal.GetLastWin32Error();
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      blob = new byte[c.CredentialBlobSize];
      if (blob.Length > 0) Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
      return 0;
    } finally { CredFree(p); }
  }
  public static int Write(string target, string user, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = (uint)blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static int Delete(string target) {
    return CredDeleteW(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@`;
const readTail = '$b = $null; $r = [AgyLabCredential]::Read($target, [ref]$b); if ($r -eq 1168) { exit 44 }; if ($r -ne 0) { exit 1 }; [Console]::Out.Write([Convert]::ToBase64String($b))';
const writeTail = '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); if ([AgyLabCredential]::Write($target, $user, $b) -ne 0) { exit 1 }';
const removeTail = '$r = [AgyLabCredential]::Delete($target); if ($r -eq 1168) { exit 44 }; if ($r -ne 0) { exit 1 }';

const CREDENTIAL_TIMEOUT_MS = 15000;

function runPowerShell(script, stdin) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = Buffer.from(script, 'utf16le').toString('base64');
    const proc = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error('Windows credential helper timed out'));
    }, CREDENTIAL_TIMEOUT_MS);
    proc.stdout.on('data', chunk => chunks.push(chunk));
    proc.stderr.resume();
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    proc.stdin.end(stdin);
  });
}
function createWindowsCredentialSlot({ target, user, run = runPowerShell }) {
  if (typeof target !== 'string' || typeof user !== 'string' || !/^[\w:.-]+$/.test(target) || !/^[\w:.-]+$/.test(user)) {
    throw new Error('无效的凭据管理器目标或用户名。');
  }
  const script = `${prelude}\n$target = '${target}'\n$user = '${user}'\n`;
  function payloadOf(value) {
    if (typeof value !== 'string' || !value) throw new Error('无法识别 Lab 的 Google 登录格式。');
    return value;
  }
  async function execute(tail, stdin, message) {
    try { return await run(script + tail, stdin); } catch { throw new Error(message); }
  }
  async function read() {
    const message = '无法读取凭据管理器中的 Google 登录。';
    const { code, stdout } = await execute(readTail, '', message);
    if (code === 44) return undefined;
    if (code !== 0) throw new Error(message);
    return Buffer.from(stdout.trim(), 'base64').toString('utf8');
  }
  async function write(value) {
    payloadOf(value);
    const message = '无法写入凭据管理器中的 Google 登录。';
    const { code } = await execute(writeTail, Buffer.from(value, 'utf8').toString('base64'), message);
    if (code !== 0) throw new Error(message);
    const written = await read().catch(() => { throw new Error(message); });
    if (written !== value) throw new Error(message);
  }
  async function remove() {
    const message = '无法移除凭据管理器中的 Google 登录。';
    const { code } = await execute(removeTail, '', message);
    if (code !== 0 && code !== 44) throw new Error(message);
  }
  return { read, write, remove, payloadOf };
}
module.exports = { createWindowsCredentialSlot };
