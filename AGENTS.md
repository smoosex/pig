# Pig

Electron 桌面端，给 pi coding agent 做 GUI。包管理用 `bun`。

## 启动

```bash
bun install
env -u PIG_DIR bun run dev
```

`env -u PIG_DIR` 不是可选的。`PIG_DIR` 是 `pigDir()` 的最高优先级覆盖，而它的值会被父进程继承：从安装版 Pig（或它启动的 agent）里拉起的终端，环境里带着 `PIG_DIR=<安装版的目录>`，开发实例于是和日常用的那份共用 `settings.json`、`opened-projects.json`、`chats/` 等，两个实例互相覆盖。摘掉它，开发实例才会落到上一条分支，用本仓库的 `.pig/`；打包后仍然是 `$HOME/.pig`。

`electron-vite` 同时拉起 main / preload / renderer。改 main、preload 或 IPC 后要重启 Electron 才生效；只改 renderer 一般热更新即可。

```bash
bun run typecheck
bun run plugins:build   # 重新打包内置 pi-web-access 插件（dev / build 已自动调用）
bun run build:mac       # 或 build:win / build:linux
```

## 架构

main / preload / renderer 三层边界；preload 在 renderer 进程的隔离上下文中暴露白名单 API。
会话 pi SDK 跑在 main；分支命名例外，使用无工具、不保存会话的短生命周期 utility process：

```
renderer (React，沙箱)
   ↕  preload contextBridge（window.api）
main (Node，拥有 pi session)
```

```
src/
├── shared/         IPC 契约、跨进程数据结构
├── main/           窗口、IPC、pi session
│   ├── pi/         session 生命周期、模型设置、投影、事件桥、JSONL 读取
│   └── ipc/        invoke / push
├── preload/        白名单 API
└── renderer/src/
    ├── stores/     zustand（sessions 按 catalog / tabs / conversation 分 slice）
    ├── hooks/      React 生命周期绑定
    ├── ipc/        window.api 封装
    ├── chat/       事件路由、思考计时、turn 聚合
    ├── themes/     完整语义色板
    └── components/ 按 composer / turn / sidebar / settings 分组；shadcn 在 ui/
```

会话真相在 `~/.pi/agent/sessions/` 的 JSONL。UI 状态跟 Pi messages/turns，不要另做一套扁平 ChatMessage。

内置系统插件默认范围：观测记忆全部关闭，pi-review 仅项目启用，pi-web-access 项目和 Chat 都启用；已保存的选择不受默认值变化影响。插件范围为 `project` / `chat`，可多选，空数组表示停用；旧版布尔配置迁移为仅项目。`enabledPluginPaths(scope)` 按会话类型过滤，并跳过缺失的内置文件，在设置页标出不可用。pi-web-access 是从上游 **v0.40.0** fork 到 `src/main/plugins/pi-web-access/` 的源码，删掉了 slash 命令、快捷键、curator 摘要流程、activity widget、pi-tui 渲染、`toolActivation`/`web_enable`、summary-review 与 MCP server；工具执行逻辑留在上游的 `web-tool-core.ts`，`index.ts` 只是注册工具和接会话状态的 Pi host。它依赖较多 npm 包，必须经 `plugins:build` 打成单文件后再加载，`@earendil-works/*` 与 `typebox` 交给 SDK 的 jiti alias。插件配置由 Pig 独占写入 `$PIG_DIR/web-search.json`（开发时 `cwd/.pig/web-search.json`），PIG_DIR 在 main 启动时发布给同进程的扩展。

**re-fork 时要重新打上的 Pig 补丁**（上游没有，覆盖文件后会丢）：

1. `utils.ts` — `getWebSearchConfigDir()` 优先读 `PIG_DIR`；proxy 作用域用 `Symbol.for("pi-web-access.proxy-storage")` 挂到 globalThis，跨模块实例共享（扩展 reload 后已安装的 fetch wrapper 才能看到新实例的 proxy）。
2. `ssrf-protection.ts` — 连接期 DNS 校验（`createValidatingLookup` + undici `Agent` dispatcher，绕开 preflight 的 TOCTOU），地址策略复用 `src/main/network-address.ts` 的 `isBlockedAddress`，删掉上游自己的 `isBlockedIPv4`/`isBlockedIPv6`。预检与传输使用相同的 proxy 决策；实际直连始终检查 DNS，不因 `trustEnvProxy` 跳过，也不能在 undici 加载失败时降级到无保护 fetch。配置端点的 localhost 豁免只允许 loopback 地址及同源跳转。
3. 配置路径延迟解析 — `web-tool-core.ts`、`ssrf-protection.ts`、`index.ts` 里的配置路径必须是函数（`webSearchConfigPath()`），不能是模块级常量：Bun 的测试跨文件共享模块注册表，且宿主可能在 import 之后才设 `PIG_DIR`。
4. `gemini-web.ts` / `utils.ts` — `typeof fetch` 与 undici 类型的 cast（`as unknown as typeof fetch`），Pig 的 tsconfig 比上游严格。
5. v0.40.0 缺陷修复 — `utils.ts` 的 proxy wrapper 用 `Request` 序列化 URL + FormData；`pdf-extract.ts` 显式选择 endpoint 时不吞错误，只有 auto 可降级；`endpoint-pdf-extract.ts` 的字符串任务结果必须是 JSON 对象并通过非空 Markdown 校验；OpenAI SSE 错误保留 `code`/`type`，路由不匹配描述文本，畸形 JSON 直接报错。对应回归在 `tests/pi-web-access-network.test.ts`（真实 Node 本地 socket）与 `tests/pi-web-access-search-errors.test.ts`。

会话隔离用上游 0.38 的引用计数模型（`holdResults`/`releaseResults`/`loadSessionResults` + `touchClones`/`releaseClonesUnusedSince` + `liveInstances`），不要再做 per-instance storage：Pig 每个 tab 一个扩展实例共用一个进程，最后一个存活 session 结束前不能清 clone 目录。

Pig 自己的数据：开发时 `cwd/.pig`，打包后 `$HOME/.pig`，`PIG_DIR` 作为最高优先级覆盖（见「启动」：开发时不要带上它）。Worktree 在该目录下 `worktrees/<项目名>/<uuid>`，同名项目撞目录时才加路径哈希；重命名只改 Git 分支，不改目录。pi 登录态读 `~/.pi/agent/auth.json`。

## 进程与接口

| 位置                                 | 职责                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `src/shared/api.ts`                  | 跨进程 DTO 与 `SessionApi`，不依赖 Electron 或 React                    |
| `src/shared/session-images.ts`       | `pig-image` URL 的形状与解析；renderer 只把 url 当不透明字符串          |
| `src/preload/index.ts`               | IPC 白名单，用共享契约检查暴露的接口                                    |
| `src/main/ipc/`                      | 接收请求、解析窗口、调用业务模块、返回 DTO                              |
| `src/main/session-image-protocol.ts` | 注册 `pig-image` scheme 并按需返回图片字节                              |
| `src/main/app-url.ts`                | 窗口只允许停在自己的 UI 上（含重定向）                                  |
| `src/main/shell-env.ts`              | 启动时从用户登录 shell 导入 PATH 与缺失的环境变量（GUI 启动不继承终端环境） |
| `src/main/open-project-sessions.ts`  | 持久化已打开会话、活动标签与标签顺序（Worktree 和 chats 两半）；与 session 生命周期分离 |
| `src/main/pi/session-jsonl.ts`       | 按行索引 JSONL，只解析要用的行；担保不了就报错让 SDK 接手               |
| `src/main/pi/session-source.ts`      | pending / live 会话统一的只读条目视图                                   |
| `src/main/pi/plugins.ts`             | 内置 / 第三方插件注册表、启用状态与打包路径                             |
| `src/main/pi/web-search-settings.ts` | 内置 pi-web-access 的配置读写（`$PIG_DIR/web-search.json`，权限 0600）  |
| `scripts/build-system-plugins.ts`    | 用 esbuild 把 vendored 插件打成单文件到 `out/system-plugins/`           |
| `src/renderer/src/ipc/api.ts`        | renderer 的接口入口，复用共享类型                                       |
| `src/renderer/src/lib/highlight.ts`  | Shiki 高亮（WASM 引擎、按可见性触发、LRU 缓存）                         |

新增跨进程字段时先改共享契约，再改 main 的生产端和 renderer 的消费端。
不要在 preload 声明、renderer 或 main 各复制一份接口。

`patches/@shadcn%2Freact@0.3.1.patch` 为固定版本的组件补充显式暂停、偏移恢复、
状态读取及显式消息锚定。修改它时同步更新 `tests/message-scroller.test.ts`，
不要在业务组件外另建一套自动滚动状态机。

## 注释与验证

参考 [Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
和 [Agent](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)
的做法，模块开头交代职责，复杂逻辑说明生命周期、数据归属或时序约束。
能由函数名表达的动作不重复写成注释。

tsconfig 开了 `allowImportingTsExtensions`，因为 vendored 插件保留上游的 `.ts` 后缀 import。

```bash
bun run typecheck   # node、web、tests 三个 tsconfig 项目
bun test
bun run build
```

单元测试覆盖纯投影、并发时序及模拟 DOM 下的组件行为；不需要调用真实模型。
tests/ 由 `tsconfig.test.json` 单独检查（依赖从 `src/` 的真实类型推导），改跨进程
数据结构时 typecheck 会连同 fixtures 一起报错。

## 注意事项

- 能用 `components/ui` 里的 shadcn 组件就不要写原生标签：按钮、输入、选择、对话框等都走现成封装。图标用 `lucide-react`，不要手画 SVG。
- 主题：`src/renderer/src/themes/` 定义完整语义颜色；`styles.css` 只注册 Tailwind token，不绑定基础色板。切换靠 `html[data-palette]` + `.dark`，组件不要引用色板编号或写死颜色。
- Composer：IME 组字时 Enter 不能发送。工作耗时那一行不要 hover / `aria-expanded` 高亮。
- Tailwind 写在组件 `className` 里。能用间距刻度就不要任意值：`--spacing` 是 `0.25rem`，`Npx / 4` 即类名（`px-[18px]` → `px-4.5`）。百分比用分数（`max-w-1/2`）。只有刻度表达不了、或 keyframes / `::after` 才用 `*.module.css` 或 `[…]`。
- 中文引号字体是 LXGW WenKai Lite，其余 Geist Variable。
- 依赖分区按「谁能 external 加载」而不是「谁被 import」：只有 main / preload 运行时 `import` 的包（今天就是 `@earendil-works/pi-coding-agent` 和 `@electron-toolkit/utils`）留在 `dependencies`，renderer 用的全进 `devDependencies`。renderer 由 Vite 完整打包，不区分两者；`electron-builder` 只打 production deps，放错的代价是安装包暴涨。
- 不要擅自 `git commit`。

## Theme Palette Rules

### Structure

- Store palettes in `src/renderer/src/themes/theme-<name>.css` using the shared variable names. Use `html[data-palette='<name>']` for light colors and `html.dark[data-palette='<name>']` for dark colors.
- Each light/dark palette selector defines the same complete semantic color contract. `styles.css` registers these variables as Tailwind colors; it must not impose palette-to-role mappings.
- Components consume semantic tokens, never raw palette names such as `bg2`, `grey0`, or `green`. A theme may keep private base colors internally, but these are not a component API.
- Literal theme colors belong in palette selectors, not in components or generic `.dark` overrides.

### Backgrounds and Grays

- Use shadcn roles: `background`/`foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, their foreground pairs, `border`, `input`, `ring`, and `sidebar-*`.
- Pig-specific surfaces are `chat-background`, `composer-background`, and `user-message-background`/`user-message-foreground`. Keep them independently configurable rather than coupling messages to primary buttons.
- `input` follows shadcn usage: control borders and translucent fills. It is not the chat composer's background.
- There is no mandatory lightness ordering between page, sidebar, card, and chat surfaces. Each theme chooses its own hierarchy; distinguish adjacent surfaces without sacrificing readability.
- Menu hover and keyboard selection use `accent`, not `muted`, which shares the popover background color.

### Accents and Readability

- Keep `link`, `selection-background`/`selection-foreground`, `success`, `warning`, `info`, `destructive-background`, status background pairs, and `chart-1` through `chart-7` independent of primary actions.
- Code container colors are `code-background`, `code-foreground`, and `code-border`; syntax highlighting remains the responsibility of Shiki. `dot-base` controls decorative activity dots.
- Status and selection backgrounds should be subtle but distinguishable. Check normal text, including button labels, against its actual background for at least 4.5:1 contrast. Large text and necessary non-text UI indicators require at least 3:1.
- Decorative colors need not all meet text contrast requirements, but any color used for text must be checked against its actual background.
- Validate both light and dark modes with body text, descriptions, buttons, inputs, popovers, and selection highlights. A visually pleasing swatch alone is not sufficient.
