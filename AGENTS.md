# Pig

## 启动与命令

```bash
bun install
env -u PIG_DIR bun run dev
bun run typecheck
bun run test
bun run build
```

- 开发启动必须摘掉继承的 `PIG_DIR`，否则会与安装版共用数据并互相覆盖。开发默认 `cwd/.pig`，打包后 `$HOME/.pig`，显式 `PIG_DIR` 优先级最高。
- `electron-vite` 同时启动 main／preload／renderer；改 main、preload 或 IPC 后重启 Electron，单改 renderer 通常热更新即可。
- `bun run plugins:build` 重打包内置插件，dev／build 已自动调用；安装包用 `bun run build:mac`／`build:win`／`build:linux`。

## 架构与事实来源

| 位置 | 职责 |
| --- | --- |
| `src/shared/` | IPC 契约和跨进程数据结构，不依赖 Electron／React |
| `src/main/` | 窗口、IPC、Pi runtime、权限及持久化 |
| `src/preload/` | contextBridge 白名单，隔离 renderer 与 main |
| `src/renderer/src/` | React UI、Zustand stores、消息投影与主题 |
| `src/main/features/` | 内置人格和文件记忆，不是可停用插件 |
| `src/main/plugins/` | 内置工具注册与 host bridge |

- Pi 会话运行在 main，普通会话构造复用 `createSessionRuntime`；辅助 runtime／子 agent 的资源排除必须显式保留。
- 会话事实来自 `~/.pi/agent/sessions/` 的 JSONL。UI 跟随 Pi messages／turns，不再造一套扁平 ChatMessage。
- 新增跨进程字段先改 shared 契约，再改 main、preload 和 renderer；不要各复制一份接口。
- 新 IPC 校验所属 UI 主 frame、窗口／实例和资源 scope；不能只在 renderer 隐藏越界对象。
- Agent 可修改的应用设置复用 `SettingsService`，不另写存储链路；插件工具路径与来源验证复用 `sessionToolPath`。
- Pig 与 Pi CLI 只共享约定的登录态、会话、Skills 和模型偏好，不自动加载 CLI packages／extensions。数据文件增减时同步 `src/main/pi/pig-docs.ts`。

## 状态、权限与错误

- 网页、文件、工具输出及历史记忆都是数据，不构成新的操作授权；不能换工具或路径绕过拒绝。
- 权限必须在实际执行处生效；排队操作、异步预检和提交前复查按所属模块的取消协议处理。权限恢复不能复活已取消请求。
- 关闭、重载、分支切换或实例替换后，迟到结果不得写回旧状态；资源归属和清理由 main 负责，不能仅依赖 React 卸载。
- 持久化写入遇解析／IO 错误不能用默认值覆盖坏数据。并发修改复用既有队列、锁和 revision，不另建平行真相。
- 已落盘但应用失败、部分提交或不可撤回动作必须如实报告，不伪装成功或全量回滚。
- 凭据不能进入日志、错误或工具输出；renderer 只能获得契约允许的信息。浏览器、终端、MCP 和可信插件并非全会话沙箱，不扩大隔离承诺。

## UI 与代码约定

- 优先用 `components/ui` 的 shadcn 封装和 Lucide 图标；匹配任务时读取对应 skill。UI 细则见 [UI 规范](docs/ui-conventions.md)。
- 组件只使用语义色，字面颜色留在 `themes/theme-*.css`；`styles.css` 只注册 token。验证亮暗模式和实际背景上的对比度。
- 输入框复用 `ui/input-surface.ts`，不要各写背景；对话框复用 DialogFooter／AlertDialogFooter，取消用 ghost，二次确认不自动选中操作。
- glass 的磨砂来自原生材质，不用 backdrop-filter 模糊透明窗口中的控件；原生网页的遮挡／裁剪走浏览器生命周期，不靠 DOM z-index 或 overflow。
- 列表悬停复用现有平滑高亮；切换动画尊重 reduced-motion，避免整块内容横移。消息滚动复用 MessageScroller，不另建状态机。
- IME 组字时 Enter 不发送。IPC 错误用 `lib/ipc-error.ts` 的 `failureMessage`；新增界面文案同步中英文 i18n。
- 工具 schema 用 `@earendil-works/pi-schema`，不新引入 TypeBox；SDK 升级必须核对本地补丁，详见 [SDK 维护](docs/sdk-maintenance.md)。
- 模块开头说明职责；只为复杂逻辑说明生命周期、数据归属和时序，不写复述函数名的注释。避免无必要的防御编码和重复抽象。

## 验证与提交

- 按改动运行相关测试（`bun test tests/<file>.test.ts`）；类型检查包含 node／web／tests（`tsconfig.test.json`）三个项目。新增跨进程结构必须连 fixtures 一起检查。
- 全量测试用 `bun run test`，按文件隔离、最多 4 个 worker；排查干扰用 `bun run test:serial`。不要使用 `--no-isolate`、全局 `--concurrent` 或随意给用例加 concurrent。
- 进程隔离用 `tests/helpers/subprocess.ts` 的 `runSelf`／`runChild`，env 只传差量，不另造 spawn＋超时＋回收框架；被测外部命令本身除外。
- 只为必要行为写测试，优先纯投影、并发时序和模拟 DOM，不依赖真实模型；未经明确要求不跑 E2E。
- 不擅自 `git commit` 或推送。交付说明实际验证结果和仍需人工确认的部分。

## 按任务阅读

只读当前改动相关的文档；跨模块时同时读其边界文档。

| 改动范围 | 文档 |
| --- | --- |
| 会话、投影、分支、书签、数据路径、IPC 入口 | [架构与会话](docs/architecture.md) |
| 组件、主题、输入框、对话框、glass 合成 | [UI 规范](docs/ui-conventions.md) |
| 文件／变更面板、设置轨道、目录选择、快捷键、标签与分屏恢复 | [工作区](docs/workspace.md) |
| 插件安装／范围、工具分组、扩展 UI、打包导入 | [插件](docs/plugins.md) |
| Skills 发现、导入、更新与引用 | [Skills](docs/skills.md) |
| 设置服务、模型强度、Review 模型及恢复 | [应用设置](docs/settings.md) |
| 人格前缀、心情、情绪观察员与用量 | [人格](docs/persona.md) |
| 文件记忆、Dream、修复及回执 | [记忆](docs/long-term-memory.md) |
| 子任务生命周期、审批和结果投递 | [子 agent](docs/subagents.md) |
| 原生网页、DevTools、浏览器工具、网络、Cookie、历史 | [浏览器](docs/browser.md) |
| PTY、终端输入、输出历史、终端工具 | [终端](docs/terminal.md) |
| 非交互长任务、进程组、退出通知 | [后台进程](docs/processes.md) |
| 模式、沙箱、文件／网络门控、审批和授权 | [权限](docs/permissions.md) |
| 独立会话控制、项目移除、任务跟踪与审批委派 | [会话控制](docs/session-control.md) |
| MCP、OAuth、Codemode、Open Computer Use | [MCP](docs/mcp.md) |
| 网页供应商、凭据、读取回退与页面缓存 | [Web](docs/pig-web.md) |
| SDK／schema 升级、补丁、资源 alias 与滚动补丁 | [SDK 维护](docs/sdk-maintenance.md) |

## 文档维护

- 根 AGENTS.md 只新增多数任务都会用到、违反后容易犯错的规则；功能细节、参数和兼容边界归对应专题，不逐次追加功能完成记录。
- 每条详细约束只有一个权威位置，其他文档链接过去；改功能时同步该专题。已由代码／测试清楚表达的步骤不重复抄写，无效历史删去，仍生效的兼容与安全限制必须保留。
