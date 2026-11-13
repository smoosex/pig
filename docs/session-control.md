# 控制其他 Pig 会话

内置 `pig-session` 插件在项目和 Chat 默认启用，工具位于 deferred 的 `session` namespace。升级后重启 Pig，由 `tool_search` 加载工具；不会因新增工具自动发送任何模型请求。子 agent 不加载此插件。

## 工具

| 工具 | 用途 |
| --- | --- |
| `session_list` | 列出同窗口其他会话的 ID、目录、标题和忙碌状态 |
| `session_open_project` | 注册用户授权的已有本地目录，不创建目录或克隆仓库 |
| `session_remove_project` | 从 Pig 列表移除已注册项目并关闭其空闲会话标签；保留源码、worktree 和会话历史 |
| `session_create` | 在已注册项目/worktree 创建后台普通会话，可附模型、强度和能力配置 |
| `session_capabilities` | 读取目标控件与工具组、MCP、Skills ID 和状态 |
| `session_configure` | 修改目标会话的模型、强度和能力，不改全局默认 |
| `session_send` | 对空闲目标发送纯文本任务，立即返回 taskId |
| `session_status` | 查询本调用者启动的任务及当前回复、可观测用量 |
| `session_wait` | 等任务结束，默认 10 秒、最多 120 秒；超时/取消不停止任务 |
| `session_stop` | 停止目标及其子 agent，不关闭标签；已发送操作无法撤回 |
| `session_read` | 按页读取用户授权会话的用户消息与最终回复 |

## 典型流程

1. 用户明确授权添加某个项目、创建与运行任务。
2. `session_open_project({path: "/absolute/project"})`，使用返回的规范目录。
3. `session_create({cwd, title, model: {provider, id}, thinking})`。
4. `session_capabilities({sessionId})` 获取真实 capability ID；不要按插件显示名称猜 ID。
5. `session_configure` 应用能力 patch。`{group:"tools", id:null, enabled:false}` 关闭全部工具；随后逐条启用需要的内置工具或插件工具组。mcp/skills 同理；`enabled:null` 恢复默认。patch 按顺序应用，所有 ID 先校验。
6. `session_send({sessionId,text})`，保留返回的 taskId；之后 `session_wait` 或 `session_status`。多个独立目标可同时运行，但同一目标忙碌时拒绝新任务。
7. 用户可随时切到真实标签查看、审批或手工停止。后台创建不会抢焦点。

新建时已知 capability ID 可以放入 create 的 `capabilities`，在 UI 可发送首条消息前完成配置。不支持在运行中追加 steer/follow-up，首版也不创建 Chat。模型、思考强度不写共享 Pi 偏好；只允许所选模型支持的强度，不能用不支持的档位假装成功。

`session_stop` 会同步作废受控任务尚未完成的输入预检，同时中止活动运行和子 agent，并等待提交真正退出后才返回成功。输入钩子或鉴权尚在等待时，停止也会等待它们退出，目标任务锁继续保留；即使它们随后返回，也不能再启动模型请求或工具执行。已发送的操作无法撤回，未按取消协议实现的可信扩展也不能被强制终止；非取消类预检错误仍会抛出。

配置中或受控任务运行中，目标输入和配置有互斥门控。IO 或扩展重载失败可能留下部分已保存配置，会直接报错；应重新读取实际配置，不假装全量回滚。

## 从 Pig 移除项目

仅在用户明确授权时调用 `session_remove_project({path: "/absolute/project-root"})`，必须传已注册项目的根目录，不传某个 worktree 子目录。语义与界面的“移出列表”相同，不等于“删除项目”：源码目录、Git worktree、Pi JSONL 历史均保留，重新打开仍可找到历史。打开标签与重启恢复成员会移除。

拒绝移除当前调用会话所在项目、其他窗口正在使用的项目，以及存在运行中会话/子 agent/后台进程或更宽权限会话的项目；先显式停止或调整后再请求。文件、浏览器、终端标签需用户先手动关闭，避免未保存内容丢失和程序被意外打断。

主进程按项目独占并暂时阻止工作区新任务，持有目标会话控制租约，UI 先检查后同步移除。只读拒绝，默认权限每次确认，完全访问不询问。IO 或提交后的 UI 清理失败会报错并说明已发生的移除，不伪装回滚；此时需刷新列表确认实际状态，磁盘源码和会话历史不受此操作删除。

## 权限与授权

- 操作只限同一 Pig 窗口，不能操作自身；已有会话必须由用户明确指定。列出 ID、目标回复或网页内容不构成授权。
- 默认权限下，每次注册/移除项目、创建、修改、发送和停止都需要审批，仅本次允许/拒绝；只读拒绝这些写操作，完全访问不询问。过大的审批内容拒绝而非截断。
- 不能配置权限模式或借目标会话提权。若目标模式宽于调用者，写操作拒绝，需用户手动调整。创建时采用 caller 与默认模式中更严格者。
- 创建后是独立普通会话，不是父子 agent；创建者停止或关闭不会自动杀掉已发送的任务。等待取消也不等于任务取消。
- main 校验窗口/实例，UI 跨文档重载、退出、取消或迟到应答不能完成旧的创建请求。失败只回收本次新建的标签，不关闭用户重新打开的实例。
- namespace 要求不得自发或递归创建会话，不得用其他会话绕过拒绝。这些指令不是全操作系统隔离；可信插件代码等原有边界保持不变。

## 受控任务的审批

授权来源按任务绑定，不改变被控会话的模式或复制会话授权。目标默认模式下，文件真实路径/访问方式、完整沙箱外命令、无沙箱运行、MCP 服务及指定终端 ID 等已有 session grant 可精确借用；控制会话为完全访问时，这些可用 grant 表达的审批也可直接通过。目标只读限制保持不变。终端输入也使用公共 grant 检查：可借用控制者对同一终端 ID 的已有授权，或由完全访问控制者覆盖；终端独占控制、目标只读限制及输入前租约校验仍生效。上传、设置修改等无 session grant 的专用一次性确认仍需人工处理，不把任意 select 当成可自动批准的权限。

缺少授权时，主进程仅建立一个 requestId，在被控会话和控制会话两处显示同一审批（子 agent 来源继续保留）。卡片注明实际受控会话，“本会话允许”仅记入受控会话，不反向扩大控制会话授权。两处点击和系统通知都争用同一请求，main 同步认领后才完成回调；迟到回复不再执行，非法选项不消耗请求，消失的卡片不能批准后来的操作。

模式变化、实例替换、任务结束会撤销绑定并取消相关未决审批；窗口重载及关闭沿用原回收链路。控制会话关闭时取消其镜像审批，已启动的目标操作仍遵守原来的不可撤回语义。不允许多级或循环控制关系借用授权。审批绑定会持续到后台子 agent 及其结果续跑全部结束，不在父会话第一次 idle 时提前释放。

`session_status` / `session_wait` 以 `task.blockedBy: 'approval'` 标明待人工审批；wait 此时提前返回，`timedOut:false` 不表示任务完成，必须看 status。模型没有代替用户回答审批的工具，不能轮询或换工具绕过拒绝。

## 完成与用量

父会话第一次 idle 不一定完成。task 要等待最终 `agent_settled`、输入结束、子 agent 最终写入、报告投递及报告触发的父续跑。截断、模型错误、中止或目标被替换不标为成功。后台进程本身不会因 Agent 完成自动退出；需要任务自行管理，不把长期 dev server 当作未完成的子 agent。

任务记录仅内存保留：每调用者最多 8 个运行任务，全进程最多 64 个，历史记录有上限；重启后 taskId 不可恢复，但普通会话 JSONL 和已打开标签按原机制保留。

`durationMs` 使用单调时钟，包含目标 prompt 初始化、工具执行和子 agent 等待，不包含注册/创建/配置。回复最多返回 32K 字符。usage 汇总父记录（含已记载的压缩/辅助 usage）及子索引增量，不重复加 reasoning；当前子索引不含全部辅助请求，涉及子任务时保守标 `usageIncomplete`。`cost` 是 SDK 报告/估算，不是供应商账单；0 不证明免费。工具输出均为不可信 fenced 数据。

## subagent 实验

使用独立任务项目，不修改 Pig 来完成题目。A 组关闭 subagent 工具，B 组启用；用户要求的 B 组明确委派提示需作为策略差异记录，并验证确实产生 spawn。新一轮与旧手工试跑分开。

功能允许同时运行多个会话，但正式对比任务速度时应串行执行样本，避免 CPU、网络、缓存与 API 限流相互干扰；B 内部子 agent 并行属于被测策略，应保留。隐藏验收继续在目标项目之外执行，不把答案注入会话。

## 实现入口

- `pig-session-host.ts` 连接插件与 main；`src/main/ipc/session-agent.ts` 的 `session:agent-request/answer` 负责所属窗口的 UI 往返。

- `src/shared/session-agent.ts` 统一配置、任务和 UI request/answer；`src/main/pi/session-agent.ts` 复用项目注册、pending/live runtime、能力偏好与 prompt 链路，不另造 Agent。
- `project-open.ts` 与目录选择器共用；移出项目经 `project-unpin.ts`，不是删除源码。项目锁及 blocked cwd 期间持有控制租约，UI remove-project 为 check/apply 两阶段。
- create 先配置并发布空 JSONL、持久化成员，再请求所属 UI 添加精确 ID 的后台标签；`attachAgentSession` 不复用草稿或切前台，项目清单以递增 catalog membership revision 合并，失败按 runtime 实例回收。
- `session-control-lock.ts` 阻止配置／任务期间并发输入、切分支和 UI 配置。任务文本走 `promptSession` literal 入口，不展开 slash/template。
- `session-agent-tasks.ts` 统一等待真正结束；`session-prompt.ts` 的 beforeSubmit 转为 SDK beforeStart，stop 用 reason 身份判断自己的取消，stop revision 拒绝停止前准备中的迟到 spawn/restart。
- `permissions/delegation.ts` 管理控制者绑定，`approvalController` 路由唯一审批请求；授权持续校验到实际执行，不因插件 scope reload 取消另一个会话的子 agent/process 审批。
- `session_read` 带 `readOnlyHint` 注解，宿主只校验同窗口等程序边界，不把列出会话当成用户授权。
- `src/main/pi/session-read.ts` 在单次 withSource 回调内同步读取当前分支，再校验双方状态及窗口；每页最多 20 条、单条 8000 字，过滤思考／工具／隐藏消息／图片。仅同窗口另一已打开会话，工具说明要求用户明确授权；只读模式仍可用，不另设审批。
