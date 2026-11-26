# 代理工作说明

## 平台范围

- 仓库支持 macOS Apple Silicon 与 Windows x64。修改共享构建逻辑时必须保持两个平台行为，尤其是 macOS 原有构建入口、默认参数、打包结构和代码签名流程。
- Windows ARM64、WSL 远程模式第三方模型以及 NSIS/MSI 安装包不在当前范围内。

## 禁止提交的内容

- 不提交 `build/`、`dist/`、`node_modules/`、Antigravity 安装包、Electron zip、`app.asar`、任何可执行二进制、日志、凭据或临时逆向脚本。
- 不修改原版 Antigravity 安装目录、原版用户数据目录、原版协议注册或原版系统凭据。

## Windows 信任链

- 当前官方 Antigravity 2.35.1/2.35.2 的 NSIS 安装包具有有效 Google LLC Authenticode 签名，但安装后的 `Antigravity.exe`、`resources\bin\language_server.exe` 以及官方 Electron `electron.exe` 在 Windows 上均为 `NotSigned`。
- 因此 Windows 构建以 `scripts/platform_windows.py` 中按版本登记的官方输入 SHA-256 为信任锚点。构建必须严格核验 `resources\app.asar`、`resources\bin\language_server.exe`、`resources\elevate.exe`、`resources\app-update.yml` 和 `resources\app.asar.unpacked` 树哈希，以及应用版本与所有补丁锚点；任何不匹配都必须停止，不能跳过或静默降级。`resources\bin\` 中出现未登记的关键脚本或可执行文件也必须拒绝。
- `--installer` 只能作为显式传入的额外证明：传入时校验 NSIS 安装包为 Google LLC 有效签名且版本一致；不要添加默认目录扫描或自动猜测安装包位置的逻辑。
- `strip_pe_signature` 对无 Certificate Table 的当前官方二进制应直接跳过；若未来官方补签，只剥离补丁后失效的尾部证书块并清零校验和。

## 补丁与测试

- 不猜测二进制偏移或文本锚点。所有偏移、指令模板、目标 RVA、长度字段和文本锚点必须精确唯一校验。
- Windows 凭据隔离目前是 11 处 RIP-relative LEA 目标重写加 2 处长度修改，和 macOS 的 8 处加载点不同；不要用 macOS 数量校验 Windows。
- 变更后至少运行 `npm test`、`python -m unittest test.test_bundle_login_windows -v` 和 `python -m py_compile` 检查相关脚本。
