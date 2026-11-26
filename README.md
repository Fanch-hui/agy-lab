# AGY Lab

面向 macOS Apple Silicon 的 Antigravity 本机实验副本，支持在原生模型选择器与 Orchestrator 中使用第三方模型。Lab 使用独立的应用标识（`com.local.agy-lab`）、数据目录、钥匙串条目和 `agy-lab://` 登录回调，不覆盖原版配置或会话。

> **非官方项目。** AGY Lab 与 Google、Antigravity 或 OpenAI 无官方关联。仓库仅发布项目源码和本地构建脚本，不分发 Antigravity 二进制、`app.asar`、图标、Electron 压缩包或构建好的应用。请使用自己合法取得、具有有效官方签名的 Antigravity 安装包在本机生成副本。修改客户端或使用实验性订阅登录前，请自行确认适用的许可、服务条款和账号资格。

## 连接第三方模型

1. 打开 AGY Lab，照常使用 Google 账号登录主窗口，再打开菜单栏 **AGY Lab → 第三方模型连接…**。
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

API Key 和 ChatGPT OAuth 凭据由 Electron `safeStorage` 加密后保存在 Lab 用户数据目录。更多边界说明和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 本地构建

需要 macOS Apple Silicon、带有效 Google 签名的 Antigravity **2.35.1 或 2.35.2**、Python 3.11+、Node.js 22.12+、Xcode Command Line Tools 和 `@electron/asar`。

1. 在仓库根目录运行 `npm install` 安装构建工具；也可使用已全局安装并在 `PATH` 中的 `asar`。
2. 从 [Electron 44.9.1 官方发行页](https://github.com/electron/electron/releases/tag/v44.9.1)获取 `electron-v44.9.1-darwin-arm64.zip` 和 `SHASUMS256.txt`，放进 `build/source/`，将校验清单改名为 `electron-44.9.1-SHASUMS256.txt`。
3. 运行：

   ```sh
   python3 scripts/build_app.py --source /Applications/Antigravity.app
   ```

输出为 `dist/Antigravity Lab.app`。构建脚本校验原版应用签名和 Electron 压缩包，再对副本中的启动器及语言服务进行本地签名。已有成品不会被覆盖；需要并排构建时，可用 `--output` 指定 `dist/` 下的其他输出路径。

### 可选：中文界面

准备一份可信的 `antigravity-zh` 检出目录。仓库只提供集成代码，不附带上游源码或词库。构建会执行该目录中的代码，因此请先确认来源和适用许可：

```sh
python3 scripts/build_app.py --source /Applications/Antigravity.app --zh /path/to/antigravity-zh
```

构建先运行汉化项目的界面兼容性检查，不通过即停止。翻译脚本只在应用主界面文档准备就绪后运行，不开启调试端口，也不作用于内置浏览器标签页。

### 验证与常见问题

- `npm test` 运行自动化测试，不需要 Antigravity 安装包或真实账号。测试中的本地 HTTP 服务需要能访问 `127.0.0.1`。真实登录、界面和 Orchestrator 交接需手动验收。
- **升级原版后构建失败**：本项目按受支持的版本及补丁锚点检查，不保证新版兼容。请使用支持的版本或等待对应适配，不要跳过校验。
- **macOS 提示应用无法验证**：Lab 是在本机构建、临时签名的副本，不是 Google 签名或 Apple 公证的发行版。先确认源文件和构建过程可信，再按 macOS 提示处理；不要关闭全局安全检查。

## 许可证

本项目自有源码采用 [MIT 许可证](LICENSE)。Antigravity、Electron 和外部汉化项目不因本仓库的许可而改变各自的授权条款。
