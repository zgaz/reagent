<p align="center">
<pre>
██████╗  ███████╗  █████╗   ██████╗ ███████╗ ███╗   ██╗ ████████╗
██╔══██╗ ██╔════╝ ██╔══██╗ ██╔════╝ ██╔════╝ ████╗  ██║ ╚══██╔══╝
██████╔╝ █████╗   ███████║ ██║  ███╗ █████╗   ██╔██╗ ██║    ██║
██╔══██╗ ██╔══╝   ██╔══██║ ██║   ██║ ██╔══╝   ██║╚██╗██║    ██║
██║  ██║ ███████╗ ██║  ██║ ╚██████╔╝ ███████╗ ██║ ╚████║    ██║
╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝  ╚═════╝ ╚══════╝ ╚═╝  ╚═══╝    ╚═╝
</pre>
</p>

<p align="center">
  <strong>面向安全应急响应的终端 AI Agent</strong><br/>
  单二进制 · 无运行时依赖 · 模型无关
</p>

<p align="center">
  <a href="#quick-start">快速开始</a> ·
  <a href="#usage">使用方式</a> ·
  <a href="#safety">安全机制</a> ·
  <a href="#audit">审计取证</a> ·
  <a href="#configuration">配置</a> ·
  <a href="#installation">安装</a>
</p>

---

## 为什么用 reagent？

应急响应最怕工具锁死编辑器、绑定特定模型、或者依赖一堆运行时。**reagent** 不一样：

- **终端原生** — 就在终端里干活，支持管道、脚本、定时任务
- **模型无关** — 切换 OpenAI / Anthropic / 小米 MiMo 等兼容端点，只需改配置
- **单二进制** — 编译成独立可执行文件，零运行时依赖，拷到哪用到哪
- **安全默认** — 写文件和破坏性命令必须确认
- **取证优先** — 内置应急响应工程师人设，审计日志带哈希链防篡改

```bash
# 直接对话
reagent

# 单条指令
reagent "查看当前目录文件"

# 管道输入
cat server.log | reagent "找出 502 错误的根本原因"

# 命令别名
reagent /create-pr
```

---

## 目录

- [快速开始](#quick-start)
- [使用方式](#usage)
  - [自然语言](#自然语言)
  - [管道输入](#管道输入)
  - [命令别名](#命令别名)
  - [Agent 配置](#agent-配置)
  - [输出模式](#输出模式)
- [安全机制](#safety)
- [审计取证](#audit)
- [配置](#configuration)
- [安装](#installation)

---

## 快速开始

```bash
# 1. 下载对应平台的二进制文件
chmod +x reagent-<平台>

# 2. 初始化配置
./reagent config init

# 3. 填入 API Key（编辑 .cook/config.json）
#    provider_api_keys: { "OPENAI_API_KEY": "sk-...", "OPENAI_BASE_URL": "..." }

# 4. 直接进入交互对话
./reagent
```

reagent 会根据 `.cook/config.json` 里的配置自动选择模型。配置文件跟随二进制所在目录，拷到哪、配置带到哪。

---

## 使用方式

### 自然语言

直接用自然语言描述任务，引号在指令含特殊字符时使用：

```bash
# 无参数直接进入交互对话
reagent

# 单条指令
reagent 查看当前目录文件

# 复杂指令建议加引号
reagent "找出所有修改时间早于 2 个月的 python 文件"
```

reagent 内置四个工具来完成工作：

| 工具 | 作用 |
|------|------|
| **Read** | 读取磁盘文件 |
| **Write** | 创建或覆盖文件（需确认） |
| **Edit** | 原子化的查找替换编辑 |
| **Bash** | 运行带超时和输出上限的 shell 命令 |

### 管道输入

有数据管道进来时，reagent 会自动读取 stdin。小输入直接内联到 prompt，大输入自动写入临时文件。

```bash
cat filelist.txt | reagent "把这些改名为 kebab-case"
git diff HEAD~3 | reagent "为这些改动写一条变更日志"
ps aux | reagent "哪个进程占用了最多内存？为什么？"
```

### 命令别名

把常用指令存成 `.md` 文件，用 `/name` 调用：

```bash
reagent /create-pr
reagent /review-code
reagent /fix-lint
```

按以下目录顺序解析（先命中先用）：

| 优先级 | 本地 | 全局 |
|--------|------|------|
| 1 | `.cook/commands/` | `~/.cook/commands/` |
| 2 | `.cursor/commands/` | `~/.cursor/commands/` |
| 3 | `.claude/commands/` | `~/.claude/commands/` |
| 4 | `.codex/commands/` | `~/.codex/commands/` |

### Agent 配置

可以在配置文件里定义多个 agent，用不同 provider 和模型，按需切换：

```bash
# 用默认 agent
reagent "总结这个仓库"

# 用快速 agent 处理简单任务
reagent --agent fast "main.ts 导出了什么？"
```

### 输出模式

```bash
# 默认：状态输出到 stderr，最终答案输出到 stdout
reagent "总结这个仓库"

# quiet：抑制状态，保留最终输出
reagent --quiet "总结这个仓库"

# debug：在 stderr 输出详细日志
reagent --debug "总结这个仓库"

# 配合管道 — 只有最终答案进入 stdout
reagent "列出所有导出的函数" > functions.txt
```

### Raw 终端模式

想直接拿到命令原始输出而不是 AI 总结：

```bash
reagent --raw "查一下我的公网 IP"
# → 直接打印命令输出，不做总结
```

---

## 安全机制

reagent 默认安全设计，你始终掌握控制权。

- **变更确认** — Write、Edit 和破坏性 Bash 命令执行前必须确认
- **智能分类** — 模型判断每条命令是否为变更操作（不做脆弱的正则匹配）
- **路径作用域** — 文件访问默认限制在当前目录
- **Dry-run 模式** — 预览 reagent 会做什么，不实际执行

确认提示时你可以输入：

| 输入 | 效果 |
|------|------|
| `y` / `yes` | 同意本次操作 |
| `n` / `no` / Enter | 拒绝本次操作 |
| `a` / `all` | 同意本次及之后所有变更 |
| *任意文字* | 拒绝并给 agent 提供指引 |

```bash
# 跳过所有确认（慎用）
reagent --yes "更新 src/ 下所有 import"

# 预览变更而不执行
reagent --dry-run "重构 auth 模块"

# 允许当前目录之外的文件操作
reagent --allow-outside-cwd "更新 ~/.bashrc"
```

---

## 审计取证

开启 `session_logs: true` 后，reagent 记录完整的运行历史，每条事件带 **SHA-256 哈希链**，可用于应急响应的证据保全与篡改检测。

```
.cook/sessions/<uuid>/
├── session.json       # 元数据（时间、agent、provider、model、args）
└── events.jsonl       # 追加式事件流
```

事件覆盖完整生命周期：会话开始/结束、agent 运行、工具调用、确认决策、完整 prompt 载荷。

### 校验证据完整性

仓库附带独立的 Python 校验脚本 [`verify_session.py`](verify_session.py)，无需任何依赖（纯标准库），适合取证环境独立校验哈希链：

```bash
# 校验当前目录下最近一次的会话
python3 verify_session.py

# 校验指定会话（用 session id）
python3 verify_session.py <session-id>

# 校验指定会话目录
python3 verify_session.py <目录路径>
```

**退出码：** `0` = 哈希链完整；`1` = 会话不存在或被篡改。

```bash
$ python3 verify_session.py
Session: /path/to/.cook/sessions/00e08432-...
Events:  12
Integrity: OK — hash chain of 12 events intact
```

校验原理：每条事件哈希 = `sha256(上一条哈希 + 该事件内容)`，从 `genesis` 起始逐条重算，任何一条被修改都会导致链路断裂。

> 诊断阶段默认只读。任何写操作前先记录原文 hash、必要时备份——这是应急响应人设的第一准则。

---

## 配置

### 配置优先级

Flags → 本地配置 → 全局配置 → 默认值

```bash
# 创建本地配置（.cook/config.json）
reagent config init

# 创建全局配置（~/.cook/config.json）
reagent config init --global

# 两个都创建，覆盖已有文件
reagent config init --global --local --force
```

### 示例配置

```json
{
  "max_steps": 12,
  "bash_timeout_ms": 30000,
  "bash_output_limit_bytes": 1048576,
  "require_confirm_mutations": true,
  "allow_outside_cwd": false,
  "quiet": false,
  "debug": false,
  "session_logs": true,
  "provider_api_keys": {
    "OPENAI_API_KEY": "sk-...",
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
  },
  "default_agent": "default",
  "agents": {
    "default": {
      "provider": "openai",
      "model": "mimo-v2.5-pro"
    },
    "fast": {
      "provider": "openai",
      "model": "mimo-v2.5"
    }
  }
}
```

### 系统 Prompt 组成

reagent 按以下顺序组装系统 prompt：

1. 内置基础指令（主机上下文、工具、安全规则）
2. **System 主体**：agent 的 `prompt_files.system` → `.cook/prompts/SYSTEM.md` → `.cook/SYSTEM.md`
3. **追加文件**：`prompt_files.system_append` 中的每个文件，按顺序
4. **上下文文件**：`AGENTS.md`、`CLAUDE.md`、`cook.md`（在 cwd 自动发现）

设置 `ignore_agents_md: true` 可跳过 `AGENTS.md` 和 `CLAUDE.md`（仍包含 `cook.md`）。

---

## 安装

### 下载二进制

从 [Releases](https://github.com/zgaz/reagent/releases) 页面下载对应平台的二进制文件：

| 平台 | 架构 | 文件 |
|------|------|------|
| macOS | Apple Silicon | `reagent-darwin-arm64` |
| macOS | Intel | `reagent-darwin-x64` |
| Linux | x64 | `reagent-linux-x64` |
| Linux | x64 (旧 CPU) | `reagent-linux-x64-baseline` |
| Linux | x64 (musl) | `reagent-linux-x64-musl` |
| Linux | ARM64 | `reagent-linux-arm64` |
| Windows | x64 | `reagent-windows-x64.exe` |

```bash
# 移动到 PATH
chmod +x reagent-darwin-arm64
mv reagent-darwin-arm64 /usr/local/bin/reagent

# 使用
reagent
```

---

## 致谢 / Acknowledgement

本项目基于开源项目 [cook](https://github.com/devadutta/cook) 修改而来，在原版基础上进行了大幅定制：

- 重命名并适配安全应急响应场景（人设、审计日志、会话哈希链）
- 新增交互式对话 UI、上下文管理、命令历史、Tab 补全等
- 强化安全默认：变更确认、路径作用域、dry-run

感谢 [devadutta](https://github.com/devadutta) 的 cook 项目。

---

<p align="center">
  <sub>面向安全应急响应的终端 AI Agent · 单二进制部署</sub>
</p>
