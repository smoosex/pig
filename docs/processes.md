# Agent 后台进程

修改 `src/main/processes/`、pig-process、退出通知或进程状态面板前阅读。

## 工具、进程组、输出与清理

- Agent 后台进程由内置 `pig-process` 插件提供（默认仅项目启用，子 agent 排除），与浏览器、终端一样以 deferred 工具归入 `process` namespace 并列入 `pig_servers`，提供 `process_start/list/read/wait/stop`。
- 结构同 pig-terminal：插件只转发，经 `pig-process-host.ts` 的 globalThis 注册表调用 main 的 `BackgroundProcessController`（`src/main/processes/`），两者都要进 `extraResources`。
- 用于 dev server、watch、长构建等非交互长任务，交互程序仍用终端。
- 启动方式区分沙箱与无沙箱路径：沙箱路径由可信 `/bin/sh -c` 启动包装命令，环境经 `sandboxEnvironment` 工具链白名单过滤；无沙箱路径在 Unix 使用选定 shell 的 `-c`，Windows 使用非交互 PowerShell。基础环境来自已导入登录环境的 `process.env`，去掉 `PIG_DIR`、`ELECTRON_*`、`FORCE_COLOR`，设置 `NO_COLOR=1`、`TERM=dumb`，沙箱路径再进一步过滤。完全访问使用无沙箱路径；其他模式的沙箱与降级审批规则见 [权限](permissions.md)。
- stdin 关闭、stdout/stderr 走管道而非 PTY；工具不支持回答交互提示，以实际退出码和输出判断结果。
- 默认目录为会话 worktree（Chat 为 Home），可传相对或绝对 cwd，目录不存在直接报错。
- 每个进程独占进程组，停止时先 SIGTERM，1 秒后对进程组 SIGKILL（shell 退出后仍执行，子进程可能忽略 SIGTERM）；Windows 没有进程组，改用 `taskkill /T /F` 杀整棵树（未验证）。
- 进程以 shell 退出且管道关闭为结束；脱离进程组的子进程（setsid、守护进程）会一直占着管道，所以 shell 退出 1 秒后强制断开管道，停止、等待退出与关会话都不会无限挂起。
- 行的输出版本取首次出现时的版本，未完成的行补上换行后不变。
- 输出去掉 ANSI，`\r` 进度只保留最后一段，每进程最多 5000 行／1M 字符，读取最多 500 行／32K 字符并以不可信 fence 返回；两个管道之间没有共同顺序。
- `process_wait` 带 text 时按字面子串匹配最近 500 行（afterVersion 限定更新的输出），进程先退出则报错；不带 text 时等退出并返回退出码，默认 10 秒、最多 120 秒，超时报错，取消不停止进程。
- 每会话最多同时运行 8 个、保留 32 条记录。
- 进程归会话而非插件所有：`disposeLiveSession` 调 `closeSessionProcesses` 杀掉并忘记该会话的进程（插件被关掉也照样清理），退出应用时 `shutdownProcesses` 与终端一样是强制清理项，等所有进程组 SIGKILL 完成才退出；不跨重启恢复。
- Agent 没有观察到的结束（不是 `process_stop`，也没被 `process_wait` 返回或报错）——自行退出（含退出码 0）或用户在 UI 停止——由插件 `session_start` 时 attach 的投递函数以隐藏 `process-exit` custom message 发给 Agent，`triggerTurn: false`：运行中排到本批工具结果之后，空闲时直接写入会话等下一轮，不开新一轮；Pig 自己清理（关会话、退出）不投递。
- 输入框右侧的 `ProcessStatus` 是所有进程共用的一个按钮（位于子 agent 与 Review 状态左侧，没有记录时隐藏），运行中外环转动，有 `failed` 时右上红点；弹层每行显示名称或命令、状态、时长与退出码，可展开最近 20 行输出，运行中可停止、已结束可移除。
- 数据经 `src/shared/processes.ts` 契约：main 每会话 250ms 合并一次推送整份快照（`processes:changed`），stop/remove 只接受 UI 主 frame。
- UI 状态：用户或 Agent 要求停止为 `stopped`，自行退出码 0 为 `exited`，其余为 `failed`。

## 相关入口

- 命令权限和域名询问见 [权限](permissions.md)。
- 交互程序用 [终端](terminal.md)；后台进程记录不跨重启恢复。
