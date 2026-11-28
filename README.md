# AGY Lab

面向 macOS Apple Silicon 与 Windows x64 的 Antigravity 本机实验副本，支持在原生模型选择器与 Orchestrator 中使用第三方模型；Windows 构建可选支持 WSL 工作区（实验性）。Lab 使用独立的应用标识（`com.local.agy-lab`）、数据目录、系统凭据存储和 `agy-lab://` 登录回调，不覆盖原版配置或会话。

> **非官方项目。** AGY Lab 与 Google、Antigravity 或 OpenAI 无官方关联。仓库仅发布项目源码和本地构建脚本，不分发 Antigravity 二进制、`app.asar`、图标、Electron 压缩包或构建好的应用。请使用自己合法取得的 Antigravity 安装包在本机生成副本。修改客户端或使用实验性订阅登录前，请自行确认适用的许可、服务条款和账号资格。

## 连接第三方模型

1. 打开 AGY Lab，照常使用 Google 账号登录主窗口，再打开 **AGY Lab → 第三方模型连接…**。在 Windows 上，这些入口位于系统托盘菜单。
2. 选择连接方式：
   - **API Key**：输入 OpenAI 兼容服务的接口根地址和 Key，点 **获取模型**。已有连接可从列表复用凭据。同一服务的目录可能包括不支持聊天的模型，可用 **测试工具** 检查工具调用兼容性。
   - **ChatGPT 订阅（实验性）**：点 **Sign in with ChatGPT**，在浏览器完成授权并允许订阅共享，再点 **获取订阅模型**。可用性取决于账号资格、授权和服务端支持；该连接使用订阅共享额度，达到上限后不会自动切到 API 计费。
3. 选中模型并点 **添加所选模型**，然后重启 Lab。新增或删除连接都要重启才会更新模型列表。模型与推理档位会出现在原生模型选择器及 **Settings → Models → Orchestrator Settings** 的角色列表中。

第三方模型可以与官方模型在同一会话中交替使用，也可以担任 Orchestrator 的规划者或执行者。读写文件、运行命令和工具审批仍由 Antigravity 处理。

### 请求去向与诊断

- 只有选中第三方模型的生成请求会转给对应服务。Lab 重建请求，不复制 Google 的请求头或项目元数据，但**会将生成所需的对话、代码片段及工具结果发给选定服务商**。Google 登录、额度和官方模型请求仍发往 Google；Lab 只在返回的模型目录中追加本地连接。
- 第三方工具调用以占位签名写入会话，服务商的推理状态由 Lab 在本机保留，供同一服务后续请求使用。针对官方 OpenAI 的 API Key Responses 请求，Lab 会在适用时保持工具列表和系统提示的可缓存前缀稳定，并用增量消息表达提示的变化。缓存命中不作保证。
- 如果外部请求在收到 HTTP 响应前因网络错误失败（如连接被重置、DNS 解析失败），最多重试 3 次（间隔 1、2、4 秒）；拒绝重定向等确定性错误不重试；收到错误状态、响应开始后失败或用户取消时不重试。最终错误会显示模型、服务商及可用的失败原因（如网络错误码），不会自动换用其他模型。
- **显示云端请求清单**查看路径、状态码及请求结构统计；清单不记录请求头、令牌、对话正文或文件内容。**导出模型诊断**可查看语言服务给界面的模型列表。分享诊断文件前请先检查其中的模型名、工具名和其他环境信息。

API Key 和 ChatGPT OAuth 凭据由 Electron `safeStorage` 加密后保存在 Lab 用户数据目录；macOS 使用系统钥匙串，Windows 使用 DPAPI。更多边界说明和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 本地构建

需要 Python 3.11+、Node.js 22.12+ 和 `@electron/asar`。macOS 构建还需要 Xcode Command Line Tools。

1. 在仓库根目录运行 `npm install` 安装构建工具；也可使用已全局安装并在 `PATH` 中的 `asar`。
2. 从 [Electron 44.9.1 官方发行页](https://github.com/electron/electron/releases/tag/v44.9.1)获取对应平台的 Electron zip 和 `SHASUMS256.txt`，放进 `build/source/`，将校验清单改名为 `electron-44.9.1-SHASUMS256.txt`。
3. 按平台运行下方命令。已有成品不会被覆盖；需要并排构建时，可用 `--output` 指定 `dist/` 下的其他输出路径。

### macOS Apple Silicon

需要 `/Applications/Antigravity.app` 中带有效 Google 签名的 Antigravity **2.35.1、2.35.2 或 2.36.0**：

```sh
python3 scripts/build_app.py --source /Applications/Antigravity.app
```

输出为 `dist/Antigravity Lab.app`。构建脚本校验原版应用签名和 Electron 压缩包，再对副本中的启动器及语言服务进行本地签名。

### Windows x64

需要 Windows x64 原版 Antigravity **2.35.1、2.35.2 或 2.36.0** 的安装目录。输出为免安装目录 `dist\Antigravity Lab\`。2.36.0 的补丁已在官方文件上逐字节核对，但尚未在 Windows 上完成实机验收：

```powershell
python scripts\build_app.py --source "$env:LOCALAPPDATA\Programs\antigravity"
```

Windows 不依赖已安装可执行文件的 Authenticode 状态：受支持版本的 `Antigravity.exe` 和 `language_server.exe` 在安装后是 `NotSigned`，但官方 NSIS 安装包本身具有有效 Google LLC 签名。构建会用版本对应的已登记哈希核验 `--source` 下的 `resources\app.asar`、`resources\bin\language_server.exe`，以及 `resources\app.asar.unpacked` 下文件相对路径和内容的确定性树哈希；并核验 ASAR 内的版本和补丁锚点。`resources\bin\` 下若出现未登记的 `.exe`、`.cmd`、`.bat`、`.ps1` 或 `.js`，构建也会停止。Electron ZIP 则使用随附的官方 SHA-256 清单核验，并检查归档内的 Electron 版本。

`--installer` 是可选的额外来源校验。只有显式传入时，脚本才会要求该 NSIS 安装包具有有效 Google LLC Authenticode 签名，且产品版本与已核验的安装目录一致。脚本不会自动寻找安装包：

```powershell
python scripts\build_app.py --source C:\path\to\antigravity --installer C:\path\to\Antigravity-x64.exe
```

如果语言服务副本没有 PE 证书表，构建会跳过证书清理；如果存在补丁后失效的尾部证书块，构建会从副本移除它并清零 PE 校验和。Windows 副本使用独立数据目录、Windows 凭据隔离、`agy-lab://` 回调、系统托盘入口及 `com.local.agy-lab` AppUserModelID。

#### WSL 工作区（实验性）

目前只支持 2.36.0。补丁后的 Linux 语言服务已在 Ubuntu 容器中确认可以启动并使用独立的存储位置，但安装到发行版、登录和第三方模型交接尚未在真实的 Windows + WSL 上验收。

WSL 工作区需要在构建时加入同版本官方 Linux x64 语言服务；2.36.0 文件发布于 <https://storage.googleapis.com/antigravity-public/antigravity-hub/2.36.0-5596661662220288/unsigned/language_server-linux-x64>，构建会按登记的 SHA-256 核验并补丁后随 Lab 携带：

```powershell
python scripts\build_app.py --source "$env:LOCALAPPDATA\Programs\antigravity" --wsl-server C:\path\to\language_server-linux-x64
```

WSL 里的语言服务还需要能访问 Windows 上的 Lab 模型代理：在 `%UserProfile%\.wslconfig` 的 `[wsl2]` 下加入 `networkingMode=mirrored`（Windows 11 22H2+），执行 `wsl --shutdown` 后重新打开 Lab。Lab 启动 WSL 会话时会从发行版内探测代理（需要发行版里有 `bash`）；探测不通时 WSL 会话仍可使用，但只走 Google 官方模型，Lab 会提示第三方模型不可用。未带 `--wsl-server` 的构建不能连接 WSL。Lab 在发行版内使用独立的 `~/.agy-lab-server` 和 `~/.agy-lab`；与 Windows 一样，全局规则和 Skills 会链接到发行版内原版应用的 `~/.gemini` 副本。SSH 远程工作区仍不支持。

### 可选：中文界面

中文界面来自同一作者的 [antigravity-zh](https://github.com/Fanch-hui/antigravity-zh) 项目（MIT 许可证）。本仓库只包含集成代码，不附带它的源码或词库，构建时指向一份它的检出目录即可。构建会执行该目录中的代码，如果使用其他来源的副本，请先确认来源可信：

```sh
git clone https://github.com/Fanch-hui/antigravity-zh.git /path/to/antigravity-zh
python3 scripts/build_app.py --source /Applications/Antigravity.app --zh /path/to/antigravity-zh
```

构建先运行汉化项目的界面兼容性检查，不通过即停止；Antigravity 出新版本后，需要等 antigravity-zh 适配该版本才能带中文界面构建。翻译脚本只在应用主界面文档准备就绪后运行，不开启调试端口，也不作用于内置浏览器标签页。

### 可选：上下文与用量面板

[agy-context-speed](https://github.com/Fanch-hui/agy-context-speed) 是同一作者的 Antigravity 侧边面板插件，显示上下文占用、生成速度、缓存命中和用量。它的安装脚本面向原版应用；Lab 的数据目录是独立的，所以本仓库提供一份补丁 `plugins/agy-context-speed.lab.patch`，让插件只读取 Lab 自己的会话，并增加第三方模型的统计（本会话、本周、本月的用量和等价 API 费用估算，不是订阅账单）。补丁对应上游提交 `58ea9dd`：

```sh
git clone https://github.com/Fanch-hui/agy-context-speed.git
cd agy-context-speed
git apply -p1 /path/to/agy-lab/plugins/agy-context-speed.lab.patch
```

然后在 Lab 完全退出的状态下手动安装到 Lab 的数据目录（macOS 为 `~/Library/Application Support/AGY Lab/gemini/config`，Windows 为 `%APPDATA%\AGY Lab\gemini\config`）：

1. 把 `plugin.json`、`sidecars/` 和 `README.md` 复制到该目录下的 `plugins/agy-context-speed/`。
2. 在该目录的 `config.json` 里加入 `"sidecars": { "agy-context-speed/monitor": { "enabled": true } }`（已有 `sidecars` 时只添加这一项）。

不要对打过补丁的副本运行插件自带的安装脚本，它会装到原版应用的 `~/.gemini`。重新打开 Lab 后，在对话右上角的 **⋮ → Extensions → Context & Speed** 打开面板。WSL 会话的数据在发行版里，面板读不到。

### 验证与常见问题

- `npm test` 运行自动化测试，不需要 Antigravity 安装包或真实账号。测试中的本地 HTTP 服务需要能访问 `127.0.0.1`。真实登录、界面和 Orchestrator 交接需手动验收。
- `python -m unittest discover -s test -v` 运行 Python 单元测试，包括 Windows PE 补丁和构建输入验证，不需要真实安装包或 PowerShell。
- **升级原版后构建失败**：本项目按受支持的版本、输入哈希及补丁锚点检查，不保证新版兼容。请使用支持的版本或等待对应适配，不要跳过校验。
- **macOS 提示应用无法验证**：Lab 是在本机构建、临时签名的副本，不是 Google 签名或 Apple 公证的发行版。先确认源文件和构建过程可信，再按 macOS 提示处理；不要关闭全局安全检查。

## 社区

欢迎到 [LINUX DO](https://linux.do) 社区交流使用体验、反馈问题和分享配置。

## 许可证

本项目自有源码采用 [MIT 许可证](LICENSE)。Antigravity、Electron、antigravity-zh 和 agy-context-speed 不因本仓库的许可而改变各自的授权条款。
