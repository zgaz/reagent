# cook 项目背景

- cook 是一个**便携式终端 AI agent**：单二进制、无运行时依赖、模型无关。
- 定位：用于**网络安全应急响应与取证**——默认人设是应急响应工程师，见 `prompts/SYSTEM.md`。
- 技术栈：**Bun** + Vercel AI SDK 6（`ToolLoopAgent`）。
- 四个内置工具：**Read / Write / Edit / Bash**。
- 安全机制：写文件与破坏性命令需确认（y/n/a/文字纠正），目录作用域默认限制在当前目录。
- **审计取证**：`session_logs` 记录完整会话（对话、读文件、执行命令、确认决策），日志带 SHA-256 哈希链防篡改，可用 `bun run verify:session` 校验证据完整性。
- 本发行版已定制：
  - 模型与 provider 通过 `dist/.cook/config.json` 配置，切换模型不需要改代码或人设。
  - **配置跟随二进制**：cook 用可执行文件所在目录的 `.cook/`，拷到哪、配置带到哪。
  - 交互模式：`cook chat` 提供持续对话，跨轮次保留上下文。
