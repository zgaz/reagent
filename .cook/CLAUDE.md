# 项目约定

默认使用 **Bun** 而非 Node.js。

- 使用 `bun <file>` 而不是 `node <file>` 或 `ts-node <file>`
- 使用 `bun test` 而不是 jest 或 vitest
- 使用 `bun install` 而不是 npm / yarn / pnpm
- 使用 `bun run <script>` 而不是 `npm run <script>`
- 用 `bunx tsc --noEmit` 做类型检查

## 常用命令

- 安装依赖：`bun install`
- 运行测试：`bun test`
- 类型检查：`bun run typecheck`
- 编译单二进制：`bun run build:compile` → `dist/cook`
