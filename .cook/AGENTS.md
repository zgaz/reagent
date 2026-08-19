# AGENTS 说明

本项目使用 **Bun** 工具链，所有脚本、测试、依赖管理都以 Bun 为准。

## 关键命令

- 依赖安装：`bun install`
- 运行测试：`bun test`
- 类型检查：`bun run typecheck`
- 编译产物：`bun run build`（bundle）/ `bun run build:compile`（单二进制 `dist/cook`）
- 交互对话：`./dist/cook chat`

## 注意

- 不要使用 npm/yarn/pnpm/vite/webpack/jest。
- 模型与 provider 配置在 `dist/.cook/config.json`，需要换模型时改那里，不要改人设文件。
