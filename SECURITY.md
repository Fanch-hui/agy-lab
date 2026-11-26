# 安全与漏洞报告

- API Key 和 ChatGPT OAuth 凭据使用 Electron `safeStorage` 加密后写入 Lab 的用户数据目录。在 macOS 上，`safeStorage` 依赖系统钥匙串。
- 本地代理和 ChatGPT OAuth 回调仅监听 `127.0.0.1`。登录等走 Google 的请求不会改投第三方；Lab 会在官方模型目录中加入本地连接。外部模型请求重新构造，不复制 Google 的请求头或项目元数据，但会将生成所需的对话和工具数据发给选定服务商。

发现漏洞请优先通过 GitHub 仓库 **Security → Report a vulnerability** 私下报告，不要先发公开 Issue。请提供受影响版本、影响范围及使用测试数据的复现说明，不要附真实 API Key、令牌、Cookie、账号资料或会话文件。
