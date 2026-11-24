# Bot 编排与单入口工作流实施计划

> 权威专题文档。本文沉淀单 Bot 入口、后台 Session 委派、Worktree 隔离与手动停止回传的架构与边界约束；Bot 页面的视觉布局、顶栏/侧栏重构、动态灵珠头像与转场交互见 [Bot 页面与交互设计](bot-ui-design.md)。

## 1. 目标与核心边界

用户只与一个 Bot 对话；后台执行继续复用 Pig 现有的普通项目 Session、权限委派和 Worktree 能力，不另起一套平行 Agent 引擎，也不引入多 Bot 人格或群聊。

| 维度 | 约定 |
| --- | --- |
| **唯一对外身份** | 只有 Bot 在 Bot 页面向用户发言，且始终维持**单一主体认知**——对用户而言从头到尾只有 Bot 自己在动手（通过 `bot_start_task` 异步启动自身在项目工作区/worktree 中的执行），**严禁出现“让后台去…”、“派了后台任务”、“根据回执显示”等包工头/传声筒黑话**；同时不允许为了口吻自然而虚报「已改好」「已测过」——开始时说“我去查/我去改，弄完跟你说”，落定后按真实产出汇报。 |
| **消息机制（参考 Grok Bot `SendMessage`）** | Bot 会话中，`send_message` 是**唯一用户可见出口**；模型普通文本输出视为内部思考，不在 Bot 页渲染成气泡。宿主通过「`send_message` 工具规则 + `context_with_system` 单一动态 `persona-mood` 风格/出口提醒 + 零发言 1 次运行时补调 + 最终系统提示/系统交付卡兜底」三层机制保障绝不静默丢回复。现有普通 Chat 与项目 Session 不受影响。审批卡继续由宿主 `approvalController` 生成，模型不能伪造。 |
| **路由机制（参考 `dsh-superagent-prototype`）** | 宿主负责任务账本、Session 绑定、事件路由与回执投递。`bot_start_task` 异步秒返（`<50ms` Fast Ack），Bot 派活后即结束当前轮，不靠 `session_wait` 挂起轮询；普通进度只更新宿主状态，不频繁唤醒 Bot；仅在完成、失败、手动停止、接管、等待审批等关键节点把结构化 Notice 送回 Bot。 |
| **无吊起对话体验** | Bot 页采取「落流即收 + 异步派活 + 未落地思考抢占合并 + 副作用后 `steer` 衔接」，彻底消除普通会话的排队条与同步卡顿；坚持单模型单人格，不引入双模型快慢嘴。 |
| **页面与生命周期** | Bot 维护**单条常驻对话时间线**（不设多会话列表，顶栏藏应急「新起一段」归档口），重启记住上次所在视图（工作区 / Bot 页，首次升级默认工作区）。离开 Bot 页面后后台任务继续执行、回执照收；仅在用户显式停止、项目被移除或应用退出时按对应规则中断。 |
| **权限与安全** | Bot 主会话默认 `full-access`（可随时临时切回 `default` / `read-only`），后台写任务继承派活时 Bot 权限上限、只读任务锁死 `read-only`、绝不提权。已打开 Git 项目派活免弹派活审批卡；`bot_cleanup_worktree` 在存在未提交改动或未合并提交时即使 `full-access` 仍强制弹确认卡。`bot_open_project` 仅注册已有目录，不隐式建目录或克隆仓库。网页、工具输出、历史回执均为不可信数据，不能转化为新授权。 |

---

## 2. 领域模型与持久化

现有 `SessionAgentTasks`（`src/main/pi/session-agent-tasks.ts`）仅存内存，重启后 `taskId` 丢失，无法支撑 Bot 长期记账与投递重试。新增 Bot 领域层，将「用户交待的事」「某次 Session 运行」「面向用户的交付」拆开记账：

```text
$PIG_DIR/bot/
├── state.json            # 0600，Bot 主会话引用、独立模型/思考偏好、归档记录与上次所在视图 lastSurface（原子写入）
├── sessions/             # Bot 主会话持久化 JSONL（与 state.sessionId 严格绑定，重启续接上下文与权限）
├── tasks.json            # 0600，BotTask 与 BotRun 账本（原子写入，含 schema version）
├── timeline.jsonl        # 0600，Bot 页面用户可见单时间线记录
└── notices.jsonl         # 0600，待投递 / 已投递给 Bot 主会话的宿主 Notice 队列
```

> 落地实现时需同步更新 `src/main/pi/pig-docs.ts` 中的 `$PIG_DIR` 数据清单。所有 JSON 持久化沿用 `writeFileAtomic`，遇解析或 I/O 错误直接报错，不用默认值覆盖坏数据。

### 核心实体

1. **`BotTask`（稳定任务）**
   - `taskId`（UUID）、`title`、`summary`、`intent`
   - `projectCwd`（规范项目根目录）、`mode: 'read' | 'write'`
   - `workspace`: `{ kind: 'worktree' | 'project'; cwd: string; branch?: string; baseHead?: string; cleanedUpAt?: number }`
   - `status`: `'starting' | 'running' | 'blocked_approval' | 'completed' | 'failed' | 'stopped' | 'taken_over' | 'interrupted'`
   - `activeRunId?`、`runs: BotRun[]`
   - `latestReceipt?`（受控截断摘要、变更文件列表/统计、产物路径、错误码/原因，不存原始敏感凭据）
   - `delivery`: `{ state: 'pending' | 'delivered' | 'fallback' | 'failed'; lastNoticeId?: string; deliveredAt?: number; error?: string }`
   - `createdAt`、`updatedAt`

2. **`BotRun`（单次执行）**
   - `runId`（UUID）、`taskId`、`sessionId`、`cwd`、`sessionTaskId?`
   - `status`: `'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'`
   - `stopOrigin?`: `'user' | 'bot' | 'takeover' | 'project_removed' | 'session_closed' | 'app_shutdown'`
   - `startedAt`、`endedAt?`、`durationMs?`
   - **代际保护**：重试或续派创建新的 `BotRun`，旧 Run 的迟到回调不得覆盖新 Run 或 `BotTask` 状态。

3. **执行完成与回复送达解耦**
   - 后台 Run 结束时先原子落盘 `BotTask.latestReceipt`，再入队一条终结 Notice 并唤醒 Bot 生成 `send_message`。例外：由 `bot_stop_task` 发起且该工具本次直接返回终结回执时，由当前轮报告，不再另入队唤醒；只返回状态、沿用已有停止或终结失败时不吞普通 Notice。
   - 若 Bot 本轮模型调用失败，任务结果不丢失，仅 `delivery.state` 留为 `pending/failed`，允许补发回复而**绝不重跑后台任务**。
   - 应用异常重启后，仅处于活跃态（`starting/running/blocked_approval`）的未终结任务与 Run 标为 `interrupted`，不伪装成 `completed`，也不改写已终结任务的历史状态；只读任务回执不采集共享仓库既有未提交变更。
   - 停止回执保留最先接受的停止原因：用户显式停止发 `task_stopped_by_user`（附禁止自动续跑协议），接管发 `task_taken_over`，其他停止发 `task_stopped` 并携带真实 `stopOrigin`。

---

## 3. Git Worktree 隔离与统一命名规则

### 3.1 隔离策略

| 场景 | 默认策略 |
| --- | --- |
| **Git 项目 + 写任务（默认）** | 宿主自动创建 Bot 专属 worktree（默认基于当前 `HEAD`），在其中创建并运行后台 Session。用户原工作目录完全不动，完成后**不自动合并**回用户分支。 |
| **Git 项目 + 只读任务** | 默认直接在项目目录（或指定 worktree）只读分析，不无谓创建 worktree。 |
| **用户原目录存在未提交改动** | 不会静默复制未提交改动到 Bot worktree；若任务明确依赖本地未提交改动，Bot 需先向用户说明并确认处理方式，禁止在旧 `HEAD` 上验证却声称覆盖了用户正在改的版本。 |
| **非 Git 目录** | 只读任务可直接执行；写任务需用户显式确认共用目录，并对同一 `cwd` 的 Bot 写任务串行互斥（同时明确告知宿主锁无法约束外部编辑器/终端写入）。 |

### 3.2 统一命名规则（目录 + 分支 + 元数据）

改造 `WorktreeService`（`src/main/worktrees.ts`），为 Bot 委派增加显式创建选项（`owner: { kind: 'bot'; taskId: string }`、`slug`），绕过手动 worktree 的 `naming: 'pending'` 与 `nameOnFirstPrompt` 异步重命名，创建时即一步定名，避免 UUID 临时分支或被首次 prompt 重命名覆盖。

| 对象 | 命名规则 | 示例 | 约束 |
| --- | --- | --- | --- |
| **Git 分支** | `bot/<slug>-<shortId>` | `bot/fix-export-speed-a1b2c3` | `<slug>` 为 ASCII 小写字母/数字/连字符（最长 32 字符，非法字符折叠为 `-`，空值回退 `task`）；`<shortId>` 取 `taskId` 前 6 位小写十六进制；总长度 `<= 80`；冲突时追加递增后缀 `-2`…；扩展校验函数而非破坏现有手动分支 `validateBranchName`。 |
| **Worktree 目录** | `$PIG_DIR/worktrees/<projectStorageDir>/bot-<shortId>` | `.../worktrees/pig/bot-a1b2c3` | 复用 `WorktreeService.storageParent()` 解决同名项目冲突；目录名短且带统一 `bot-` 前缀，规避 Windows 路径长度与特殊字符问题。 |
| **`.state.json` 元数据** | `WorktreeRecord` 增加可选 `owner?: { kind: 'bot'; taskId: string }` | `{"owner":{"kind":"bot","taskId":"..."}}` | `naming` 留空，不触发 `nameOnFirstPrompt`；UI 与 `discover()` 可稳定识别 Bot worktree。 |
| **Session 标题** | `[Bot] <taskTitle>`（或由 Bot 页面元数据标注归属） | `[Bot] 修复导出性能` | 普通项目侧边栏可见、可点入查看 diff 与日志。 |

### 3.3 清理策略

- 任务完成、失败或手动停止后，**不自动删除 Bot worktree 或回滚文件**，保留现场供用户检查、cherry-pick、merge 或继续修改。
- 用户可通过现有 Worktree 删除链路（`WorktreeService.remove`）清理，或在确认后由 Bot 触发删除。若用户在 Bot 运行期间删除该 worktree，须先经停止链路终结 Run 并通知 Bot。

---

## 4. 冲突处理与手动停止通知链路

用户随时可以打开 Bot 启动的 worktree Session，但「查看」「停止」「接管」语义严格分离：

1. **只看不接管**：切入 Session 看输出、看 diff、回答审批，都不改变任务归属，结束后照常回传 Bot。
2. **手动停止（必须通知 Bot）**：
   - **现状缺口**：当前 `src/main/ipc/session.ts` 的 `session:abort` 仅调用 `ls.agentSession.abort()`，未经过 `SessionAgentTasks.markStopping()`，未区分停止来源，也未推送通知给控制者。
   - **改造方案**：
     1. 新增统一的宿主停止入口（供 UI `session:abort`、Bot `bot_stop_task`、会话关闭、Worktree 删除共用），记录显式 `stopOrigin`（`'user' | 'bot' | ...`）。
     2. 当被停止的 `sessionId` 绑定了活动 `BotRun` 时：
        - 同步置 `run.status = 'stopping'`、`run.stopOrigin = 'user'`，调用 `tasks.markStopping(sessionId)` 作废所有预检中提交，并中止 `agentSession` 及全部子 agent（`subagents.abortAllAndWait`）。
        - UI 显示「正在停止」，直到提交与运行真正 settle 后再落盘 `status = 'stopped'`。
        - 保留 worktree 中已产生的文件修改与会话历史，绝不自动回滚；迟到事件不得将任务翻回 `completed`。
     3. 终结瞬间由宿主生成一条 **`task_stopped_by_user`** Notice 推入 Bot 主会话队列，内容包含：`taskId`、`runId`、`sessionId`、`worktreePath`、`branch`、`stopOrigin: 'user'`、停止时采集的轻量工作区快照（如已改动文件数与路径列表，来自 `git status` / `pig-file-change-v1`）。
     4. Notice 附带明确协议约束：**用户已手动停止本次执行，不得擅自换 Session 重跑或继续写入**；Bot 用自己的口吻通过 `send_message` 告知用户已停下、当前保留了哪些半成品，并等待下一步指示。
3. **显式接管（在 Bot Session 中继续手动对话）**：
   - 运行期间沿用 `session-control-lock.ts` 阻止并发输入。
   - 若用户要在该 worktree Session 中直接输入对话：
     - 运行中：UI 提供「停止并接管」，沿统一停止入口传入 `takeover`。停止协调完成后，宿主清理后台进程、采集回执、恢复普通 Session 能力、释放非 Git 写互斥，再发布 `taken_over` 和一条带回执的终结 Notice。若已由别的原因发起停止，接管只变更归属，不改写已有回执或另发终结 Notice。
     - 空闲时（任务已停或已完成）：用户在该 Session 发起新对话时自动将该 Session 标为已接管（或解除继续回传），之后用户在这个 Session 里的对话**不再向 Bot 产生任务回执**；如需再交回 Bot，由用户在 Bot 页显式发起新指令。

---

## 5. `send_message`、工具权限矩阵与无吊起路由设计

### 5.1 Bot 主会话专属工具集

Bot 主会话复用 `createSessionRuntime`（不另造 Agent 循环），运行在独立隔离工作目录（`$PIG_DIR/bot/workspace`，通过 `isolatedWorkspace: true` 屏蔽祖先代码仓库的 `AGENTS.md` 与项目级 `.agents/skills`，仅加载个人/全局级资源），通过显式配置挂载两类专属能力：

1. **`send_message`（唯一用户可见出口）**
   - 仅在 Bot 主会话开启，工具描述与 system prompt 共享同一开关：
     - 普通 assistant 文本仅作内部推理，不展示在 Bot 聊天气泡里。
     - 支持强类型消息体（第一版保持克制）：
       - `type: 'text'`：`content`（Markdown 正文，Bot 第一人称口吻）
       - `type: 'delivery'`：`content` + `taskIds`（绑定真实宿主任务/worktree/diff 跳转卡片，由宿主校验 `taskId` 存在且归属当前 Bot，防止幻觉引用）
       - `type: 'attachment'`：本地文件路径列表（宿主校验路径合法与可读，独立文件卡片渲染，不混入正文）
   - 每次 `send_message` 调用经校验后持久化为 Bot 聊天时间线的结构化消息记录（可独立于内部推理日志投影，确保刷新/重启后 Bot 页只呈现真实发出的气泡、真实审批卡与必要的系统兜底卡）。
   - **三层防漏与兜底（参考 Grok Bot）**：
     1. **事前防漏**：`send_message` 工具通过 `promptSnippet` / `promptGuidelines` 在 `<tools>` 与 `<rules>` 中声明“仅有 `send_message` 发送的内容对用户可见”，同时 Bot 扩展在 `context_with_system` 中将最后一条用户输入后的 `persona-mood` 动态收口为唯一一条融合了实时心情（若有 `SOUL.md`）与 `send_message` / `bot_start_task` 约束的 `[Style reminder: ...]`（不污染持久化的用户消息 JSONL）。
     2. **事中纠偏**：若一整轮彻底结束（不再调用任何工具）时 `send_message` 调用次数为 `0`（模型忘了调工具或只在内部写了文本），宿主立刻注入一次内部纠偏提醒（*"make a real `send_message` tool call, not plain text"*），**最多补调 1 次**，严防死循环。
     3. **最终保底**：补调 1 次后仍零 `send_message` 或模型接口报错时——用户发起的对话在消息流中插入一条明确标示的系统兜底提示/错误卡（绝不把内部思考草稿伪装成普通气泡）；后台任务终结 Notice（含停止、接管）由宿主直接插入一条轻量**系统交付卡**并将 `delivery.state` 标记为 `'fallback'`，既不无限重试，也保证任务结果绝不被悄悄吞掉，且**绝不重跑后台任务**。
   - 审批仍走现有 `approvalController` 镜像机制，在 Bot 页渲染真审批卡片；绝不通过 `send_message` 模拟审批。

2. **Bot 编排工具（宿主记账封装，替代裸调 `pig-session`）**
   - `bot_list_projects`：列出当前窗口已注册的项目（`cwd`、`name`、`isGit`、当前分支、工作树是否脏、活跃任务数），让 Bot 在不盲猜路径的前提下决策。
   - `bot_open_project`：注册一个本地已有目录到 Pig 项目列表（遵循当前权限模式：`full-access` 直接放行、`default` 复用 `session_open_project` 审批链路、`read-only` 拒绝；不隐式建目录或 clone）。
   - `bot_start_task`：**异步秒返（`<50ms` Fast Ack）**——仅做轻量参数与项目归属校验、分配 `taskId`/`runId` 并原子落盘 `BotTask` + `BotRun` 为 `starting`，立即返回 `{ taskId, runId, projectCwd, mode, status: 'starting' }`；**绝不在工具调用内同步等待 `git worktree add`、`createSessionRuntime` 或后台首轮启动**。耗时的 worktree 创建、会话初始化、权限/审批委派与首轮投递全部交由 `BotTaskManager` 在后台异步推进，启动失败或遇审批阻塞时通过 `BotNoticeQueue` 回传 Notice。支持可选 `slug`、按需能力声明（如 `capabilities: { browser?: boolean }`）以及**可选按任务覆写模型 / 思考强度**（缺省继承 Pig 全局默认模型与思考强度）。往已打开的 Git 项目派活在 `full-access` / `default` 下免弹派活审批卡。
   - `bot_list_tasks` / `bot_get_task`：从宿主账本读取真实状态、worktree 路径、分支、阻塞审批状态与 `latestReceipt`，不靠模型翻聊天记录猜。
   - `bot_inspect_task`：只读查看 Bot 自己名下指定 `taskId` 的最近进展、工具轨迹或受控截断的 diff 摘要；只读取当前仍受托管的活跃 Run 的实时记录；已完成或已接管的 Run 只使用账本中的既有回执，不读取后续会话消息。
   - `bot_stop_task`：按精确 `taskId` 停止对应 Run；若由本次工具调用发起并完成停止，返回 `runId` 和 `receipt`，当前轮通过 `send_message` 报告，不另发模型唤醒或系统交付卡。加入已在途的停止或调用时任务已终结，不重发旧回执。
   - `bot_followup_task`：基于已有 `BotTask` 启动新 `BotRun`（覆盖失败重试、停后继续、以及完成后在原 worktree 上追加修改，可选择复用原 worktree 或新开 worktree，同样支持可选覆写模型 / 思考强度），保留完整历史 Run 记录。
   - `bot_cleanup_worktree`：删除指定已结束任务的 Bot worktree；宿主强制校验 `owner.kind === 'bot'` 且非运行中后调用 `WorktreeService.remove`。**只要目标 worktree 存在未提交改动或未合并提交，即使处于 `full-access` 模式也强制弹出确认卡**；已合并且干净的 worktree 在 `full-access` 下可直接清理（`default` 下仍走审批确认）。
   - 后台执行 Session 本身**永不暴露** Bot 编排工具和 `send_message`，防止递归委派或越权直接向 Bot 页发言。

### 5.2 工具与内置能力权限矩阵（Bot 主会话 vs 后台执行 Session）

#### Bot 主会话

| 工具 / 插件 / 特性 | 策略 | 说明与约束 |
| --- | --- | --- |
| **`send_message` + `bot_*`（9 个）** | **专属启用** | 唯一对外表达口与任务编排入口。 |
| **`read`（开放单文件读取）+ `edit` / `write`（硬路径白名单）** | **受限保留** | `read` 保留用于读取 `SKILL.md`、`SOUL.md`、用户提供的本地文件/日志，以及秒答单个项目文件的事实确认；**`edit` 与 `write` 在 `tool_call` 钩子中通过 `realTarget` 硬性锁死在 `$PIG_DIR/bot/workspace/**` 与 `$PIG_DIR/persona/SOUL.md`**，直写任何项目目录一律拦截，物理杜绝绕过 worktree 偷改项目代码。 |
| **`bash`、`powershell`、`grep`、`find`、`ls`** | **主会话禁用** | 主会话通过 `applySessionTools` 隐藏并在 `tool_call` 双重拦截命令执行与仓库级检索工具；任何命令执行、构建/测试、跨文件代码排查均必须经 `bot_start_task` 委派至后台 Session。 |
| **`pig-persona`、`memory_*`、`recall`（OM）** | **保留** | 常驻伙伴的人格、心情、全局长期记忆与观测记忆由 Bot 主会话持有。 |
| **`pig-web`（`web_search`/`fetch`/`read`）** | **保留** | 日常检索资料与网页阅读无需起项目 Session。 |
| **`pig-settings`（延迟加载）** | **保留** | 支持用户自然语言调整主题、通知、默认模型等允许项。 |
| **`tool_search`、`codemode`** | **保留（受禁用列表过滤）** | 复用 `sessionToolFactory` 过滤，无法越权调用已禁用工具。 |
| **`pig-session`（11 个全套）** | **禁用** | 彻底由 `bot_*` 替代，杜绝绕过任务账本、裸调 `session_wait` 挂起或误删项目。 |
| **`pig-subagent`（`spawn` 等）** | **禁用** | 与 `bot_start_task` 职责重叠且脱离项目上下文。 |
| **`pig-terminal`、`pig-process`、`pig-browser`、`pig-review`** | **禁用** | Bot 页无工作区上下文，不抢占用户终端、长进程、浏览器标签或 `/review` 交互。 |
| **第三方已装插件** | **V1 默认禁用** | 避免未知插件破坏 `send_message` 出口；后续按需扩展 `'bot'` scope。 |

#### 后台执行 Session（托管期能力约束 Managed Overlay）

后台执行仍使用普通项目 Session，但其工具裁剪采用**托管期覆盖层（Managed Overlay）**：构造和重载均只加载项目范围已启用且由下表允许的内置插件，不执行第三方插件。用户接管时等待普通资源重载完成，只移除覆盖层，保留已保存的权限模式和会话偏好（`send_message` 与 `bot_*` 仅属于 Bot 主会话）。

1. **托管期一律禁用（读写任务通用）**：
   - `send_message` 与全部 `bot_*`（防越权发言与套娃委派）；
   - `pig-session`（11 个全套，不窥探用户其他会话、不裸建/停会话或移除项目）；
   - `pig-settings`（同 subagent 规则，干活的 Agent 不改全局偏好）；
   - `pig-persona`（后台回执保持客观事实，不带戏腔口癖，也不触发情绪观察员污染全局 `mood-state.json`）；
   - OM 观测记忆与文件记忆写工具（`memory_add` / `memory_edit` / `memory_delete`），防止并发后台任务往记忆库写入噪音或竞争冲突（短期任务走 Pi 原生压缩；项目级踩坑笔记仅按需允许 `project` scope 只读 `memory_read` 或由 Bot 派活时注入指令）；
   - `pig-review`（依赖人工前端弹窗交互，无人值守无意义）；
   - `pig-terminal`（直接操作用户可见终端 Tab，后台干活只用 `bash` 与 `pig-process`，绝不抢占用户屏幕焦点）。
2. **按任务模式裁剪**：
   - **`mode: 'read'`（只读排查 / 调研）**：权限层锁死 `read-only` 兜底，工具层同时隐藏 `edit`、`write`、`pig-process`、`pig-browser`；保留 `read`、受只读门控的 `bash`、`pig-web`、`pig-subagent`（继承只读上限）、`tool_search`、`codemode`。
   - **`mode: 'write'`（开发 / 修复 / 测试）**：保留 `read`、`edit`、`write`、`bash`、`pig-process`、`pig-subagent`、`pig-web`、`tool_search`、`codemode` 及项目允许的 MCP；**`pig-browser` 默认禁用**，仅在 `bot_start_task` 显式声明 `capabilities.browser: true` 且项目本身已启用 browser 插件时按需开启，并默认使用后台标签（`activate: false`）。
   - **`pig-process` 善后**：后台 Run 结束或被停止时，宿主统一清理该 Run 仍挂起的后台进程组（或在回执中显式标注残留服务），防止跑完留下占端口的孤儿进程。

### 5.3 无吊起对话调度与防阻塞机制

为彻底消除普通会话中「一发消息就挂起排队条 / 派活卡死几秒 / 追问被吊起」的顿挫感，采用 4 层协同设计：

1. **交互层：落流即收，彻底取消排队条**
   - Bot 页采用即时聊天心智：用户每次发送，消息立即作为正式气泡落入对话流底部并清空输入框，随时可继续连发，**不出现**普通会话的 `QueuedMessageRow` 排队吊条与「按 Tab 插话」提示（UI 细节见 [Bot 页面与交互设计](bot-ui-design.md)）。
2. **派活层：`<50ms` 异步秒返 + 主会话禁用 `bash` 防卡顿**
   - `bot_start_task` 在落盘 `starting` 后立即返回，将 `git worktree add` 与 `createSessionRuntime` 移出 Bot 工具同步等待路径；
   - Bot 主会话禁用 `bash` / `powershell` 等命令工具并将 `edit` / `write` 锁死在自留地，确保主会话轮次始终保持在轻快区间。
3. **调度层：未落地思考「抢占合并」+ 副作用后「强制 `steer`」**
   - Bot 主会话运行控制器为当前活跃轮维护 `hasSideEffect` 标志（一旦调用过 `send_message` 或任何有副作用工具如 `bot_start_task` / `bot_stop_task` / `bot_followup_task` / `bot_cleanup_worktree` / 允许范围内的 `edit` / `write` 即置为 `true`）。
   - **情况 A（`hasSideEffect === false`：纯思考或仅只读查看，尚未发出气泡也无副作用）**：用户此时补发新消息，宿主立刻 abort 当前未落地的思考流（零副作用、几十毫秒切断），把连续发来的用户消息合并在上下文中立即重起一轮。用户体感如同真人聊天连发两句后对方一并看完一起回复，完全零排队、零割裂。
   - **情况 B（`hasSideEffect === true`：已派活、已调 `send_message` 或已执行有副作用工具）**：不可 abort（避免半截副作用），宿主自动以 `streamingBehavior: 'steer'` 注入新消息（不用 `followUp` 干等整轮彻底结束）；配合 `<50ms` 异步派活，当前工具落地后下一拍即刻处理用户新消息。
4. **明确不采用「双模型快慢嘴」**
   - 拒绝在主 Bot 前再套一层独立小模型抢答：两张嘴极易脱离宿主账本乱打包票，且会造成人格口吻割裂。单模型配合上述 3 层机制即可做到低延迟且事实与人格完全一致。

### 5.4 Notice 路由与串行投递（参考 Superagent `Effects` / `Notices`）

```text
后台 Session / 异步启动失败 / UI 停止 / 审批状态变化
        │
        ▼
  BotTaskManager（更新 tasks.json，幂等防迟到覆盖）
        │
        ▼
  BotNoticeQueue（持久化 notices.jsonl + 合并策略）
        │  - 仅关键事件入队：completed / failed / start_failed / stopped_by_user / taken_over / blocked_approval / interrupted
        │  - 普通中间进度仅更新任务面板，不入队
        │  - 用户优先：若 Bot 正在处理用户消息或发生连发抢占，Notice 在队头静默等待本轮用户流 settle 后再按序投递，绝不抢占打断用户对话
        │  - 同时完成的关联回执可在队头合并为一批，避免刷屏
        ▼
  Bot 主会话（promptSession literal 入口，标记为 host-notice）
        │
        ▼
  Bot 消化回执 → 调用 send_message 以自身口吻向用户汇报 → 标记 delivery = delivered
```

- **防死循环与防重复**：Notice 投递带唯一 `noticeId`；若 Bot 本轮未调用 `send_message`，按 §5.1 的三层防漏机制最多补调 1 次；终结事件（含停止、接管）补调仍无果或模型调用报错时，由宿主直接落一条轻量系统交付卡并标记 `delivery.state = 'fallback'`，不无限重试，且任务面板始终显示真实最新结果。

### 5.5 权限边界、模型分工与单时间线契约

1. **权限模式与审批边界**
   - **Bot 主会话默认 `full-access`**：权限模式独立持久化于 `session-permissions/<botSessionId>.json`，首次初始化默认为 `full-access`；`BotComposer` 底部保留低调的权限模式切换器，允许用户随时临时切回 `default` 或 `read-only`。切至 `default` 时，Bot 主会话沙箱仅放行其专用工作目录，绝不敞开整个 `$PIG_DIR`。
   - **后台任务权限继承（不另设独立配置项）**：`mode: 'read'` 一律锁死 `read-only`；`mode: 'write'` 以派活时刻 Bot 当前权限模式为上限（对齐 `session-control` 契约——`full-access` 下后台免审批畅跑；`default` 下后台运行在 worktree 沙箱内、越界读写或无沙箱命令自动把审批卡镜像到 Bot 页；`read-only` 下禁止派写任务）。
   - **编排工具审批矩阵**：

| 动作 | `full-access` | `default` | `read-only` |
| --- | --- | --- | --- |
| `bot_start_task`（已打开 Git 项目，写任务） | 直接派活（免弹派活审批） | 直接派活（免弹派活审批；后台执行受沙箱与越界审批约束） | 拒绝 |
| `bot_start_task`（非 Git 目录，写任务） | 确认共用目录并串行互斥 | 显式审批确认共用目录并串行互斥 | 拒绝 |
| `bot_open_project`（注册已有本地目录） | 直接放行 | 弹审批确认 | 拒绝 |
| `bot_cleanup_worktree`（存在未提交改动或未合并提交） | **强制弹确认卡** | **强制弹确认卡** | 拒绝 |
| `bot_cleanup_worktree`（已合并且工作树干净） | 直接清理 | 弹审批确认 | 拒绝 |

2. **模型与思考强度分工**
   - **Bot 主会话**：拥有独立的模型与思考强度选择（在 `BotComposer` 底部切换），可自由选用低延迟模型聊天，不影响 Pig 全局默认。
   - **后台执行 Session**：在设置页「Bot → 默认执行模型」中可配置 Bot 委派与继续/重试任务时的默认模型及思考强度（持久化于 `$PIG_DIR/bot/state.json` 的 `delegateModel` 与 `delegateThinkingLevel`），未设置时继承 Pig 全局默认模型与思考强度（`~/.pi/agent/settings.json`）；生效范围为之后的新委派与重试/继续产生的新 Run，不影响 Bot 主会话模型、Pig 全局默认或正在运行的任务。优先级固定为：**单次显式 `modelOverride` / `thinkingOverride` > Bot 默认执行模型与思考强度设置 > Pig 全局默认**（单次仅覆盖模型时，不套用旧默认模型的 `delegateThinkingLevel`）；用户在对话中明确指定模型或思考强度时，Bot 通过 `bot_start_task` / `bot_followup_task` 的对应参数单次覆盖。

3. **单条常驻时间线与启动落点**
   - **单时间线**：Bot 始终沿一条常驻时间线对话，不设多 Bot 会话列表，长历史交由 OM 与自动压缩延续；顶栏菜单提供低调的应急「新起一段 / 重置当前上下文」入口（二次确认后归档旧 JSONL 并开启新会话文件，保留全部 `BotTask` 账本与长期记忆，不中断正在运行的后台任务）。
   - **重启记忆**：`$PIG_DIR/bot/state.json` 持久化 `lastSurface: 'workspace' | 'bot'`（首次升级默认 `'workspace'`）；后续重启直接恢复上次关闭前所在视图（工作区回工作区，Bot 页回 Bot 页）。

---

## 6. 分阶段实施路线

按「先通核心宿主闭环，再接 Worktree 与停止通知，最后做 Bot 页入口」分五阶段推进，每阶段均可独立写单测与类型检查。

### 阶段 1：Worktree 统一命名与所有权元数据
- **改动范围**：`src/shared/api.ts`、`src/main/worktrees.ts`、`src/main/project-worktrees.ts`
- **工作内容**：
  - 为 `WorktreeRecord` 和 `GitWorktree` 增加可选 `owner?: { kind: 'bot'; taskId: string }`。
  - 为 `WorktreeService.create()` 增加显式选项：支持 `bot/<slug>-<shortId>` 分支命名与 `bot-<shortId>` 目录命名，创建时跳过 `naming: 'pending'`，确保 `nameOnFirstPrompt` 不改名。
  - 保证 `.state.json` 兼容旧记录、冲突分支自动消歧、失败回滚干净。
- **验证**：`tests/worktrees.test.ts`（或新增 `tests/bot-worktree-naming.test.ts`）覆盖命名规范、特殊字符/超长 slug 截断、分支冲突消歧、不触发 `nameOnFirstPrompt`、删除与恢复兼容性。

### 阶段 2：统一停止协调与 `stopOrigin` 传播
- **改动范围**：`src/main/ipc/session.ts`、`src/main/pi/session-agent-tasks.ts`、`src/main/pi/session-agent.ts`、`src/shared/session-agent.ts`
- **工作内容**：
  - 抽取统一停止协调函数：UI `session:abort`、Agent `stop`、Worktree 删除与会话关闭均经此入口，携带明确 `stopOrigin`。
  - 修复 `session:abort` 未中止受控任务 `submissionAbort` 与未等待子 agent settle 的缺口。
  - 为 `SessionAgentTasks` 增加任务终结事件订阅钩子（含 `stopOrigin` 与最终快照），供 Bot 层监听，不破坏现有 `session_send`/`session_wait` 契约。
- **验证**：新增 `tests/session-stop-origin.test.ts`，覆盖运行中手动停止、预检中手动停止、子 agent 运行中手动停止、迟到事件不得覆写 `stopped`。

### 阶段 3：Bot 任务账本、异步派活管线与 Notice 队列（纯 main + shared）
- **改动范围**：`src/shared/bot.ts`（新）、`src/main/bot/`（`store.ts`、`task-manager.ts`、`notice-queue.ts`、`worktree-policy.ts`、`index.ts`）、`src/main/pi/pig-docs.ts`
- **工作内容**：
  - 实现 `BotTask` / `BotRun` 持久化存储、崩溃恢复（遗留 `starting`/`running`/`stopping` 转 `interrupted`）、同非 Git 目录写互斥。
  - 实现 `BotTaskManager` 异步启动与托管管线：秒返落盘 `starting` → 后台异步建 Git worktree + 复用 `SessionAgentController` 建会话与派活（挂载托管期能力覆盖层 Managed Overlay，接管时自动解除）→ 监听完成/失败/启动失败/审批阻塞/手动停止/接管 → 结束或停止时回收该 Run 挂起的 `pig-process` 进程组 → 采集轻量工作区变更摘要 → 写入 `BotNoticeQueue`。
  - 实现 `BotNoticeQueue`：仅关键事件入队、用户对话优先（Bot 忙或连发抢占时静默排队不打断）、关联事件合并、投递与回执解耦。
- **验证**：单元测试覆盖状态机流转（含 `starting` 异步启动与启动失败回传）、代际防覆盖、手动停止触发 `task_stopped_by_user` 通知且不自动重试、托管期工具覆盖与接管恢复、重启恢复、坏 JSON 不静默覆盖。

### 阶段 4：Bot 主会话、`send_message`、编排工具与无吊起调度接入
- **改动范围**：`src/main/bot/runtime.ts`、`src/main/bot/tools.ts`、`src/main/bot/dispatcher.ts`、`src/main/ipc/bot.ts`、`src/preload/index.ts`、`src/shared/api.ts`
- **工作内容**：
  - 创建 Bot 主会话引导逻辑（复用 `createSessionRuntime`，加载人格 SOUL + Bot 专属 system prompt 分工约束，按 §5.2 矩阵启用/禁用工具与插件，保留无硬路径拦截的 `read`/`edit`/`write`/`bash` 并配置短超时兜底；首次初始化权限默认 `full-access` 且在 `default` 模式下仅放行 Bot 专用目录；后台任务模型默认读 Pig 全局设置并支持按任务覆写；支持单时间线「新起一段」归档与 `lastSurface` 持久化；严格隔离普通会话）。
  - 注册 `send_message` 与全套 `bot_*` 工具（`bot_list_projects`、`bot_open_project`、`bot_start_task`(Fast Ack)、`bot_list_tasks`、`bot_get_task`、`bot_inspect_task`、`bot_stop_task`、`bot_followup_task`、`bot_cleanup_worktree`，schema 统一使用 `@earendil-works/pi-schema`；落地 §5.5 审批矩阵，含脏/未合并 worktree 即使 `full-access` 也强确认）。
  - 实现无吊起对话调度器（`dispatcher.ts`）：追踪当前轮 `hasSideEffect`，零副作用思考期遇用户连发则立即 abort 抢占并合并上下文重跑，已有副作用后自动走 `streamingBehavior: 'steer'` 无缝衔接；每轮用户消息与 Notice 末尾注入隐藏 `<system_reminder>`，整轮零 `send_message` 时触发最多 1 次内部补调，失败或仍零发言时落系统兜底提示 / 系统交付卡。
  - 实现 Bot 气泡投影：只向 renderer 暴露 `send_message` 产出的消息、用户输入、真实审批卡与系统兜底卡，过滤内部推理文本与隐藏 `<system_reminder>`；校验新 IPC 的主 frame、窗口归属与 scope。
  - 接入审批镜像：后台 Session 缺少授权时，审批卡同时出现在受控 Session 和 Bot 页，沿用单 `requestId` 竞争认领语义。
- **验证**：工具 schema/权限矩阵测试、`full-access` 下脏/未合并 worktree 清理强确认测试、已打开 Git 项目派活免弹审批与只读禁派写测试、后台模型默认读全局设置+按任务覆写测试、`bot_start_task` 异步秒返测试、未落地思考抢占合并与副作用后 `steer` 调度测试、`send_message` 三层防漏（`<system_reminder>` 过滤、零发言 1 次补调、最终系统兜底/系统交付卡不重跑后台任务）测试、单时间线「新起一段」归档与 `lastSurface` 持久化测试、`tests/preload-api.test.ts` 与全项目 `bun run typecheck`。

### 阶段 5：Bot 独立页面、顶栏灵珠入口与任务/接管交互
- **改动范围**：`src/renderer/src/lib/radial-reveal.ts`、`src/renderer/src/components/bot/`、`src/renderer/src/components/sidebar/SidebarModeSwitch.tsx`、`src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/stores/bot.ts`、`src/renderer/src/App.tsx`、主题 token（`theme-pig.css` / `theme-everforest.css` / `styles.css`）、中英文 i18n（`src/shared/i18n/zh.ts`、`en.ts`）
- **交互与布局依据**：完整设计见 [Bot 页面与交互设计](bot-ui-design.md)，落地要点包括：
  - **顶栏与侧栏重构**：原顶栏「项目 / 对话」切换器迁至左侧栏顶部固定分段轨；原位置替换为带立体/发光质感与动态头像的圆形 `BotOrbButton`。
  - **非 Bot 页弹出气泡**：不在 Bot 页时，Bot 新消息与审批提醒从圆珠下方以 2 行截断气泡弹出（防堆叠、按相交走原生浏览器截帧交接），点击直接扩散进 Bot 页。
  - **圆心扩散转场与保活**：复用 `ViewTransition` 圆形 `clip-path` 从 `BotOrbButton` 中心扩散进入 / 收缩退出；底层工作区隐藏不卸载，编辑器与分屏状态无损保留。
  - **无侧栏 Bot 对话剧场 + 落流即收 + 活态任务**：居中单轴对话区（仅渲染用户消息、`send_message` 气泡/交付卡与真审批卡；用户发送立刻落流、无 `QueuedMessageRow` 排队条）+ 顶部仅在有活时浮现的 `BotLiveTaskBar`（含 `starting` 秒现胶囊）+ 右侧按需 `BotTaskDrawer`（支持跳转 worktree 会话、查看 diff、精确停止、停止并接管与继续/重试）。
  - **工作区回连**：`WorktreeRow` 标识 `bot/` 分支与微标；托管 Session 顶部显示 `BotManagedBanner`，手动停止立即显「正在停止」并经气泡回传 Bot 汇报。
- **验证**：renderer store、落流即收无排队条、气泡截断、活态任务排序与投影单元测试，`bun run typecheck`、`bun run test`、`bun run build`；最终在真实 Electron 环境中人工核验 Glass/Solid 质感、圆心扩散与原生 `WebContentsView` 截帧交接、连发无吊起体感、手动停止通知、审批镜像与重启恢复。

---

## 7. 明确延后项（不在 V1 范围）

- 定时调度 / 主动巡检（Heartbeat / Cron）
- 多 Bot 角色、群聊协作
- 自动合并 Bot worktree 回主分支或自动解决冲突
- 运行中向后台 Session 动态改指令（V1 先做实查看、停止、接管、重试）
