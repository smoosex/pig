# 权限、审批与沙箱

修改 permissions、sandbox、工具门控、会话授权或审批 UI 前阅读。这里描述受保护操作的边界，不代表全应用或可信插件已被隔离。

## 模式、来源与权限上限

- 权限由 `src/main/permissions/` 和 `src/main/sandbox/` 提供，不是可停用插件。
- `createSessionRuntime` 加载内置门控并用 SDK 工具定义替换 bash/powershell/read/write/edit/grep/find/ls；替换后的工具保留原来的默认启停（powershell/grep/find/ls 不因包装而自动启用），同名插件抢占时在非完全访问模式拒绝执行。
- 模式是 `read-only` / `default` / `full-access`，每次工具执行读取当前模式；子 agent 以实际启动时的父模式为上限，之后取上限与父会话当前模式中较严格者，父模式收紧对后续工具生效，放宽不超过上限。
- 仅权限审批转发到父会话；父会话不可用时拒绝。
- 全局默认和额外域名存 `$PIG_DIR/permissions.json`（v1，0600），会话模式存 `session-permissions/<id>.json`，严格解析且原子写入；分叉权限复制与模式保存共用队列，复制完成后才登记分叉；删除清理，变更发 `permissions:changed`。
- 审批、沙箱准备和文件写入队列中的操作监听有效模式，变更或严格读取失败即取消，切回不能复活旧审批；命令与沙箱文件 worker 在实际 spawn 前再次检查并解除模式监听，已启动的进程不随模式切换改变权限。
- 完全访问／无沙箱文件写入在 Pi 的同文件队列内检查，真正写入前解除模式监听。
- Agent settings 工具不开放这些配置。

## 沙箱启动、文件和 Git 边界

- 沙箱固定使用 `@anthropic-ai/sandbox-runtime@0.0.81`（srt）。
- macOS Seatbelt，Linux 需 bwrap/socat/rg；Windows 无沙箱。
- 初始化失败明确显示原因，默认模式下逐次确认无沙箱运行，只读模式拒绝；坏配置不能当成依赖缺失而降级。
- 普通 bash 和 pig-process 都由可信 `/bin/sh` 启动包装命令，项目自定义 shell 只能在沙箱内运行；沙箱子进程只继承工具链环境白名单，不继承任意服务凭据或隐式 loader。
- 默认可写当前目录、仓库 Git common dir、独立临时目录和包管理缓存；`TMPDIR`/`TMP`/`TEMP` 指向沙箱自己的 scratch，退出清理，不开放整个系统临时目录。
- 缓存的逻辑或真实路径若是 Pig 数据目录的祖先，不授予该缓存写权限；srt 隐式写目录若覆盖 Pig，则额外禁止写入（宁可拒绝该特殊布局的工作区写入）。
- 凭据目录与 Pig 数据禁读，只重新开放本会话的 worktree/Chat scratch，不开放所有 worktrees；逻辑和真实保护路径一起覆盖，传给 srt 的路径一律标为 literal。
- Pi 凭据使用 SDK `getAgentDir()` 的实际目录，另保护 npm/pip、Docker/Kubernetes、云 CLI 的常用凭据路径与支持的环境变量指定路径；这不是对任意应用凭据的完整扫描。
- Git 工作区发现只读文件系统，不在宿主执行 PATH 中的 git；只接受标准 `.git` 仓库和双向指针匹配的 linked worktree，submodule、separate-git-dir、路径含符号链接等其他布局不授予 Git 写权限（`gitCommonDir: null`），该 `.git` 条目及其指向目录的 hooks/config 禁写，工作区照常可用；只有布局不认识（含 ENOENT/ENOTDIR）才这样降级，权限等其他 IO 错误仍然抛出。
- 各会话 Git common dir 的 hooks/config 和 worktree 的 `.git` 指针显式禁写，不能依赖 srt 按宿主 cwd 生成的规则。
- 只读额外禁止工作区、Git metadata 及 srt 自带的 npm/Claude 日志写目录。

## 网络代理与文件 worker

- srt 是进程单例：普通模式共用代理、每次命令用随机 128-bit commandId 注册会话/项目域名，结束即注销；这些网络列表是调用归属标记，不是相互敌对命令间的强隔离，且默认允许本地服务绑定和 loopback。
- 只读必须使用独立 `readonly-worker` 的 srt 实例（域名全拒绝、无 loopback/Unix socket 放行），不能误以为每次 wrap 的 network 字段会替换全局代理规则；逐命令结束/取消均清理，退出时等待 worker reset。
- 文件工具的路径询问只决定授权，不作为安全边界：实际 SDK 文件操作在 `file-worker` 沙箱子进程里执行，不加载用户扩展，参数走 stdin JSON，结果严格解码；宿主保留 Pi 的文件修改队列以串行化同文件编辑。
- rg/fd 的探测与执行全部在 file-worker 内；SDK agentDir 由宿主通过 stdin 的独立 runtime 字段传入并在 SDK import 前恢复，worker 禁止自动下载；缺少工具明确要求先安装，不在宿主执行 PATH 探测。
- 两个 worker 都是独立 main 构建入口，资源脚本通过 Electron Run-as-Node 启动；srt vendor 需 asarUnpack，Java agent/seccomp 显式使用 `.asar.unpacked` 路径。

## 域名询问与无沙箱命令

- 未知域名由代理拒绝后按 commandId 归属到会话，bash 或后台进程结束后提供「本会话 / 本项目 / 不放行」，不自动重跑；项目按 Git common dir 共享域名。
- 后台进程的询问不阻塞退出、wait 或停止，删除记录/关闭会话会取消询问；审批结果另以 `triggerTurn: false` 消息告知 Agent，不自动重跑。
- UI 审批按 extension/process/subagent 作用域取消，资源重载不取消后台进程或子 agent 审批，宿主跨文档重载或 renderer 退出取消所有请求、dom-ready 前拒绝新请求；取消与明确拒绝分别返回。
- 项目域名放行在存储队列实际执行时再次检查取消信号。
- 无沙箱 bash 要求 `unsandboxed: true` 和理由，不保存永久命令规则。
- 权限章节告诉模型：用户的请求需要更多权限时通过工具申请——写工作区外文件用 write/edit（只放开该路径），命令必须在沙箱外运行才用 `unsandboxed`，不能换位置或换工具绕开。
- srt 在 macOS 上只以 shell 的 `Operation not permitted` 报告文件拒绝，沙箱 bash 按输出文本（跨分块）识别后在结果末尾追加申请方式的提示；只读模式的提示说明不可提权。
- 命令自身的 EPERM 也会触发，提示措辞为「可能」。

## 审批 UI 与拒绝理由

- 权限请求不用弹窗：权限层调用 `ctx.ui.select` 时在 options 里附带 `approval: { message }`（Pi 原样转发），`extension-ui` 据此给事件标上 `approval`，renderer 的 `ExtensionUI` 只把普通请求做成 Dialog，审批由所属会话的 `ApprovalPrompt`（`@shadcn/react/questionnaire`）替换输入框显示（输入框只隐藏不卸载，草稿保留），详情超出视口时显示滚动提示并支持键盘查看完整内容，活动面板中自动聚焦第一个选项，获得焦点后 600ms 内忽略按键（防止正在输入草稿的数字或 Enter 误作答），作答后焦点回到编辑器；数字键或鼠标点击直接作答，方向键/空格只移动选择、Enter 确认，Esc 选最后一项（总是拒绝）。
- 审批在原选项后追加同样带数字快捷键的「拒绝并说明原因」选项（通常为第四项），选中后保留全部选项，并在该行下展开可选多行理由输入框（最多 2000 字符，初始高度 24px、随内容增高至最多 48px，超出可滚动但隐藏滚动条，仅保留固定颜色底线，无聚焦高亮或光晕），确认后把理由附在工具拒绝错误或域名拒绝反馈中返回 Agent，不单独发送新任务、不授予权限；直接拒绝及原快捷键仍保留。
- 编辑理由时数字／IME 只作输入，Shift+Enter 换行，Enter 发送理由，不显示确认按钮，Esc 返回选项并聚焦原拒绝项。
- 理由经 `extensions:reply` 的独立可选参数传递，main 只接受该请求最后一个拒绝选项的理由，继续校验主 frame、窗口、委派控制与有效请求；取消、撤销或已作答后的迟到理由无效，不消费非法选项／超长理由。
- 权限层通过 `approval.onDeny` 接收理由，SDK select 仍返回原选项字符串，不拼接／改写选项。

## 会话级授权

- 文件越界、沙箱外命令和无沙箱运行的选项是「本次允许 / 本会话允许 / 拒绝」：会话授权只在内存（`permissions/grants.ts`），关闭会话即清除，按授权内容精确匹配——文件按真实路径与访问方式（写覆盖读，搜索覆盖普通读），沙箱外命令按完整命令文本，无沙箱运行按整个会话；子 agent 用父会话 id，共享这些授权。
- 取消（无作答）与明确拒绝分别报告。
- 域名询问仍是「本会话 / 本项目 / 不放行」。
- 权限系统章节说明当前模式，模式变化用 Pi 的章节补丁，不返回强制 systemPrompt。

## MCP 执行时审批与覆盖

- MCP 工具在实际执行时审批：`sessionToolFactory` 只包装 SDK MCP 扩展注册的 `mcp__` namespace 工具，服务名取 `namespace.aliases[0]`，插件同名工具不按 MCP 规则判断；SDK 的资源工具没有 namespace 且自带只读注解，不经过这里。
- Pi 并行批次会先预检所有工具再执行，不能只在 `tool_call` 预检：包装在执行时读取模式并把取消信号传入 MCP 客户端，连接期间切换模式或关闭子 agent 会中止待发送的请求；已发给服务端的请求不保证撤回。
- 规则照搬 Codex auto（`permissions/mcp.ts`）：destructive 询问、readOnly 放行、其余未声明为非破坏且封闭世界的询问，没有注解即询问；只读模式只放行 readOnly 工具且不弹卡片，完全访问不问。
- 「本会话允许」按服务记（`mcp:<server>`），放行该服务全部工具到会话结束。
- 每服务覆盖（按注解 / 全部询问 / 从不询问）只能在 MCP 设置页改，存 `permissions.json` 的 `mcp`（只存非 auto 值，删除服务或替换为不同命令/URL 时一并清掉；缺少服务名 alias 的 MCP 工具直接拒绝），Agent 的 settings 工具无法修改；只读模式下覆盖不放宽。
- 注解是服务自述，只防 Agent 误用；MCP 服务进程本身不在沙箱里。
- 应用设置修改、浏览器上传及终端输入也按上述三模式审批，但浏览器的其他操作、终端创建／读取、可信插件自身代码以及用户手工 `!` 命令未纳入；浏览器和终端进程本身不在此沙箱里。
- 设置页和模式菜单必须明确说明，不能宣称全会话隔离。
- 应用退出在会话和后台进程清理后 reset 代理与只读 worker；同名工具替换、文件路径换链、真实 Git hooks/config、域名拒绝、只读联网、环境与 GUI 同步均有回归。

## 相关入口

- 普通会话的审批委派、镜像卡片与控制者授权见 [会话控制](session-control.md)。
- 浏览器上传、终端输入、应用设置各有专用校验：见 [浏览器](browser.md)、[终端](terminal.md)、[应用设置](settings.md)。
- 子 agent 权限和生命周期见 [子 agent](subagents.md)。
