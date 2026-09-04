# Pig

Electron 桌面端，给 pi coding agent 做 GUI。包管理用 `bun`。

## 启动

```bash
bun install
bun run dev
```

`electron-vite` 同时拉起 main / preload / renderer。改 main、preload 或 IPC 后要重启 Electron 才生效；只改 renderer 一般热更新即可。

```bash
bun run typecheck
bun run build:mac    # 或 build:win / build:linux
```

## 架构

三进程，pi SDK 只跑在 main：

```
renderer (React，沙箱)
   ↕  preload contextBridge（window.api）
main (Node，拥有 pi session)
```

```
src/
├── main/           窗口、IPC、pi session
│   ├── pi/         session 工厂、事件桥、JSONL 读取
│   └── ipc/        invoke / push
├── preload/        白名单 API
└── renderer/src/
    ├── stores/     zustand（sessions、settings）
    ├── hooks/      pi 事件 → store
    ├── ipc/        window.api 封装
    ├── chat/       turn 聚合
    ├── themes/     色板（只定义 --bg0、--fg 等）
    └── components/ UI（shadcn 在 ui/）
```

会话真相在 `~/.pi/agent/sessions/` 的 JSONL。UI 状态跟 Pi messages/turns，不要另做一套扁平 ChatMessage。

Pig 自己的数据：开发时 `cwd/.pig`，打包后 `$HOME/.pig`，可用 `PIG_DIR` 覆盖。pi 登录态读 `~/.pi/agent/auth.json`。

## 注意事项

- 能用 `components/ui` 里的 shadcn 组件就不要写原生标签：按钮、输入、选择、对话框等都走现成封装。图标用 `lucide-react`，不要手画 SVG。
- 主题：`src/renderer/src/themes/` 里只放同名色板；`:root` 用 `var(--bg0)` 映射语义 token。切换靠 `html[data-palette]` + `.dark`，不要在 `.dark` 里写死 hex。
- Composer：IME 组字时 Enter 不能发送。工作耗时那一行不要 hover / `aria-expanded` 高亮。
- Tailwind 写在组件 `className` 里。能用间距刻度就不要任意值：`--spacing` 是 `0.25rem`，`Npx / 4` 即类名（`px-[18px]` → `px-4.5`）。百分比用分数（`max-w-1/2`）。只有刻度表达不了、或 keyframes / `::after` 才用 `*.module.css` 或 `[…]`。
- 中文引号字体是 LXGW WenKai Lite，其余 Geist Variable。
- 不要擅自 `git commit`。
