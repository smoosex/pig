# 内置终端

修改 PTY worker、终端输入／历史、控制租约或 Agent 终端工具前阅读。

## 进程、环境、显示与快捷键

- 内置终端是与会话／浏览器同级的 `terminal:<uuid>` 标签，顶部 `+` 选「终端」创建，可分屏；项目内在当前 worktree 目录启动，Chat 侧（标签 cwd 为空）在 `$HOME` 启动，目录不存在直接报错。
- 不绑定 Pi session，标签跨重启恢复（见 [工作区恢复](workspace.md)），shell 进程不恢复。
- shell 跑在 main 懒启动的 `utilityProcess`（`src/main/terminal/pty-host-worker.ts`，构建为独立入口 `out/main/pty-host-worker.js`）里，node-pty 崩溃不影响 main；进程退出时各终端收到 `failed`，下一个终端重新拉起。
- main 的 `TerminalHost` 只持有终端→窗口归属，IPC 仅接受所属 UI 主 frame，宿主页面跨文档导航、renderer 退出或窗口关闭时统一 kill；关闭幂等，仍在启动中的 shell 也会被 kill（kill 消息排在 spawn 之后）。
- kill 先 SIGHUP，1 秒后对 shell 自身的进程组 SIGKILL；交互 shell 开启 job control 后每个任务另有进程组，忽略 SIGHUP 的任务会存活（与其他终端关闭窗口时的 nohup 语义一致）。
- shell 取 `shellCandidates()` 首个并加 `-l`（Windows 为 powershell）；环境以已导入登录 shell 环境的 `process.env` 为底，去掉启动终端的 `TERM*`/`COLORTERM`/各终端标识、`NO_COLOR`/`FORCE_COLOR`、`ELECTRON_RUN_AS_NODE` 和 **`PIG_DIR`**（否则在该终端里起的开发实例会共用安装版数据目录），固定 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Pig`，无任何 locale 时补 `LANG=en_US.UTF-8`。
- 输出在 worker 内按 16ms／128K 合批，renderer 在 xterm 解析完成后按 UTF-16 长度 ack；未确认超过 100K 暂停 PTY，降到 5K 恢复，10 秒无 ack 强制恢复。
- renderer 的 xterm 实例随标签存活（`src/renderer/src/terminal/runtime.ts`），切换标签只把元素挪进屏外 parking 容器，标签从 store 消失时释放并关闭 shell；`TerminalPanel` 懒加载。
- 字体只给终端用 Nerd Fonts v3.5.1 的 Lilex Nerd Font Mono（四个字重 woff2，OFL，`src/renderer/src/assets/fonts/lilex-nerd-font-mono/`），等字体加载后才 open/测量并启动 shell；聊天与代码块仍用 `@fontsource-variable/lilex`。
- WebGL 渲染失败或丢失上下文时退回 DOM 渲染。
- 背景透明，前景、光标、选区与 16 色来自各主题的 `--terminal-*`，随 `<html>` 属性变化同步。
- 按键先匹配终端自己的绑定（清屏、全选），再把窗口级快捷键交给应用，但单独 Control（不带 Command/Shift/Alt）的组合始终是 shell 输入，App 的 capture 监听同样跳过 xterm 内的这类按键；macOS 上其余 Command 组合除 C/V（复制粘贴）外都不进 shell；按住 Cmd/Ctrl 点击链接才用系统浏览器打开。
- 打包：node-pty 在 `dependencies` 并 `asarUnpack`；1.1.0 的 macOS `spawn-helper` 发布时缺执行位，`postinstall` 的 `scripts/prepare-node-pty.ts` 补 0755；macOS/Windows 用其 N-API 预编译，Linux 需 `trustedDependencies` 放行现场编译。

## 输出的重启保留

- 终端输出的重启保留：PTY worker 为每个终端维护 `$PIG_DIR/terminals/<uuid>.json`（`{version: 1, cwd, history}`，0600，目录 0700；文件读写在 `src/main/terminal/history-file.ts`，命名与清理在 `history.ts`）。
- `history` 由 headless 解析器经 `@xterm/addon-serialize` 编码（不含备用屏幕与终端模式，超过 1M 字符时逐级减少 scrollback），在解析链上取值以保持与输出同序；有输出、clear、resize 后最多每五秒写一次，正常关闭仍写最终记录。
- 同一终端的文件读写按队列串行，最终目录查询也在队列内；同 ID 的新 spawn 等待队列完成再读取，等待期间的请求按序重放，shutdown 也等待这些启动。
- 已 close 的旧 shell 不再转发 output／exit，避免晚到消息影响同 ID 的新终端。
- 迟到的写入不会重建已删除的记录。
- 关闭消息是 `close`（替代原 `kill`），带 `history: 'keep' | 'discard'`：标签被关（含 shell 退出自动关、`terminal_close`）为 discard，已退出的 shell 也会收到以删除记录；窗口关闭、renderer 重载与退出应用为 keep，先查 shell 当前目录（macOS `lsof`、Linux `/proc/<pid>/cwd`，Windows 不查）并写最终记录，再挂断 shell，`shutdown` 等这些写入完成才应答。
- 启动 shell 时同步读取记录：保存的目录仍存在就在该目录启动（`spawned` 回传实际目录，`terminal_tabs` 的 initialDirectory 随之变化；标签所属的 worktree 仍以 `tools` 的 cwd 为准），历史（不加任何分隔提示，新 shell 从下一行开始）作为第一段输出同时进入 renderer 与 headless 解析器（`terminal_read` 可读到旧输出）；记录无法读取时在面板显示错误，shell 照常启动，下次写入覆盖。
- main 启动时在建窗口前删除不在 `tools` 终端列表里的记录（例如从未显示就被关闭的标签）。
- 输出可能含敏感内容，只靠文件权限保护。

## Agent 工具与输入审批

- Agent 终端能力由内置 `pig-terminal` 插件提供（默认仅项目启用，子 agent 排除），沿用浏览器的 deferred 工具与 globalThis host bridge，提供 `terminal_tabs/open/read/type/press/release/wait/switch/close` 九个工具。
- main 的 `TerminalAgentController` 校验会话所属窗口并维护独占控制，一个会话同时控制一个终端；接管另一个释放旧控制，不结束 shell。
- 新建经 `terminal:agent-open-request/answer` 让所属 renderer 在会话 worktree（Chat 为 Home）后台创建，`ensureTerminal` 初始化并停放同一 xterm，等待 shell 就绪才应答，不切标签、不抢焦点；拒绝迟到应答后清理孤立标签。
- worker 用 `@xterm/headless` 和同版本 Unicode11 解析 PTY 输出，串行处理输出、resize、快照，滚动历史最多 5000 行、读取最多 500 行／32768 字符，返回光标、备用屏幕、输入模式及输出版本，不把 headless 自动响应再写回 PTY。
- Cmd+K 经 worker 发有序 clear 标记，前后输出与两端 parser 同序，不能只清 renderer 历史。
- 工具读取按不可信文本 fence 返回。
- `terminal_wait` 每 100ms 轮询快照，支持单行字面文本、版本推进或静默间隔（文本与静默互斥），默认 10 秒、最多 120 秒；静默按单调时钟从最近观测到的版本变化起算，不推断命令完成。
- `afterVersion` 只要求快照版本更新，不能证明文字是新出现的；未指定时文本可立即匹配、静默从调用开始，无其他条件时等待本次初始版本之后的新输出。
- wait 不占输入队列，以便 switch/close 立即使旧控制等待失效。
- `terminal_switch` 默认不切 UI，`activate=true` 才经同一请求/应答通道激活，main 核对窗口、会话和确切 ID。
- `terminal_close` 仅允许本会话通过 open 新建的终端（内存创建登记跨 release 保留，tabs 返回 canClose），接管用户或其他会话创建的只能释放；先取消控制并移除主进程 PTY，再请求 renderer 移除标签，已开始 kill 后不因工具取消放弃 UI 清理，已关闭父会话不阻止授权后的清理应答。
- 输入按会话串行，按 bracketed-paste/application-cursor 模式编码，成功仅表示输入已发送，不推断命令完成。
- `terminal_type` / `terminal_press` 在实际持有的终端内审批：默认模式显示完整输入并提供「本次允许 / 允许此终端（本会话） / 拒绝」，授权只适用于当前会话与终端 ID 的组合，会话关闭后失效；只读拒绝，完全访问不询问。
- 审批绑定控制租约，释放、关闭、shell/PTY host 退出或权限模式变化取消等待，权限监听持续到输入真正写入，写入前再次检查控制与模式。
- 终端进程未沙箱化，创建、读取和用户手工输入不受该审批限制。
- 释放／关窗／会话关闭使旧控制读取失效，插件重载不释放；用户停止 Agent 不发送 Ctrl+C、不杀 shell，已发送输入不可撤回。
- 用户可同时人工输入；面板右上 Bot 按钮复用浏览器的运行中直接释放／停止后释放及空闲确认，main 按 expectedSessionId 拒绝迟到确认。
- `pig-terminal` 目录和 `pig-terminal-host.ts` 都必须进入 extraResources。

## 相关入口

- 标签、cwd、分屏的重启恢复见 [工作区](workspace.md)。
- 非交互长任务使用 [后台进程](processes.md)，不要复用 PTY 来推断退出码。
- 终端进程不在命令沙箱内，具体审批范围见 [权限](permissions.md)。
