# Pi 会话事件与 Pig 处理状态

## 核对范围

本清单基于当前安装的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` **0.87.1**，记录 Pig GUI 接收的全部公开会话事件及底层模型流事件。

事件传递路径：

```text
AgentSession.subscribe(event)
  → src/main/pi/event-bridge.ts
  → IPC pi:event { sessionId, event }
  → src/preload/index.ts / api.onEvent
  → src/renderer/src/chat/session-events.ts
  → 会话 store 与消息投影
```

不包含插件专用 hooks（例如 `session_start`、`context`、`tool_call`）、插件 UI 请求、登录事件或其他 Pig IPC 通知。内置及第三方插件通过 `pi.on()` 处理事件的情况不计入本清单。

处理状态的含义：

- **已处理**：有对应的 GUI 状态或消息更新逻辑。
- **部分处理**：有处理分支，但只消费部分字段或特定情况。
- **间接展示**：没有对应事件分支，相关内容由消息事件展示。
- **未处理**：事件已转发，但没有对应的 GUI 消费逻辑。

主进程会转发全部 **23 类顶层事件**，但转发不等于业务处理。前端有 **12 类**直接处理分支（含部分处理）；其余 **11 类**没有专门的 GUI 处理分支，其中工具开始和结束由消息间接展示。

## 顶层会话事件：23 类

以下字段均省略公共的 `type`。`?` 表示可选字段。

### 生命周期与消息：8 类

| 事件 | 含义 / 字段 | 主进程处理 | 前端处理 |
| --- | --- | --- | --- |
| `agent_start` | 一次底层 Agent 运行开始；无其他字段 | 转发，并重置本次活动的完成通知状态 | **已处理**：提交待更新消息、取消延迟历史刷新、设为运行中 |
| `agent_end` | 一次底层运行结束；`messages`、`willRetry` | 转发 | **已处理**：提交待更新消息并结束本轮思考计时；保持整体运行状态和耗时计时，不刷新历史。`messages` 已由消息事件投影，不重复追加 |
| `agent_settled` | 包含重试、自动压缩和排队续跑的完整 Agent 活动结束；无其他字段 | 转发；活动已运行且最后回答成功时发送完成通知，并清理通知状态 | **已处理**：提交待更新消息、结束剩余思考计时、设为停止并记录总耗时，刷新控制信息，320ms 后尝试刷新历史 |
| `turn_start` | 一次模型响应及其工具执行开始；无其他字段 | 转发 | **未处理** |
| `turn_end` | 本次响应及工具执行结束；`message`、`toolResults` | 转发 | **部分处理**：重新读取会话控制信息，不直接消费载荷 |
| `message_start` | 一条消息开始；`message` | 转发；用户消息匹配待发送队列、触发开始回调、附加粘贴文本展示元数据并剥离图片提示 | **已处理**：提交之前的待更新消息并追加实时消息 |
| `message_update` | Assistant 消息流式更新；`message`、`assistantMessageEvent` | 转发 | **已处理**：完整消息快照按动画帧批量更新，并记录思考计时 |
| `message_end` | 消息完成、失败或取消；`message` | 转发；用户消息完成队列匹配与展示元数据处理；Assistant 消息记录回答是否成功 | **已处理**：用最终消息替换实时消息，并结束该 Assistant 消息的思考计时 |

注意：`agent_end` 不保证整个用户请求已经结束。`willRetry` 表示 SDK 是否预计自动重试模型请求；即使为 `false`，后续仍可能自动压缩或被插件、队列继续运行。因此前端不以该字段决定停止，而是统一等待 `agent_settled` 收尾；重试及自动压缩等待期间保持运行状态和总耗时计时。下一次 `agent_start` 会取消尚未执行的历史刷新。当前主进程只将 Assistant 的 `stopReason` 为 `stop` 或 `length` 视为完成通知所需的成功回答。

### 工具执行：3 类

| 事件 | 含义 / 字段 | 主进程处理 | 前端处理 |
| --- | --- | --- | --- |
| `tool_execution_start` | 工具开始；`toolCallId`、`toolName`、`args` | 转发 | **间接展示**：无事件分支，调用信息来自 Assistant 消息中的 `toolCall` 内容块 |
| `tool_execution_update` | 工具中间输出；`toolCallId`、`toolName`、`args`、`partialResult` | 转发 | **未处理**：中间输出没有进入 GUI 消息或工具状态 |
| `tool_execution_end` | 工具结束；`toolCallId`、`toolName`、`result`、`isError` | 转发 | **间接展示**：无事件分支，最终结果及错误状态来自后续 `toolResult` 消息 |

工具调用和最终结果能显示，不代表工具执行事件已被消费。当前工具 UI 由消息投影构建，不能据此判断工具真正开始的时刻，也没有消费 `partialResult` 的实时输出。

### 自动重试与摘要重试：5 类

| 事件 | 含义 / 字段 | 主进程处理 | 前端处理 |
| --- | --- | --- | --- |
| `auto_retry_start` | 模型请求准备重试，进入退避等待；`attempt`、`maxAttempts`、`delayMs`、`errorMessage` | 转发 | **未处理**：不显示重试次数、等待时间或错误原因 |
| `auto_retry_end` | 自动重试成功、失败或取消；`success`、`attempt`、`finalError?` | 转发 | **未处理**：不消费重试结果或最终错误字段 |
| `summarization_retry_scheduled` | 压缩或分支摘要准备重试；`attempt`、`maxAttempts`、`delayMs`、`errorMessage` | 转发 | **未处理** |
| `summarization_retry_attempt_start` | 摘要重试实际开始；`source` 为 `branchSummary` 或 `compaction`，后者还包含 `reason` | 转发 | **未处理** |
| `summarization_retry_finished` | 摘要重试流程结束；无其他字段 | 转发 | **未处理** |

`summarization_retry_attempt_start` 在 SDK 类型中有两个载荷分支，但只有一个事件名，因此计为一类。

### 上下文压缩：2 类

`reason` 的取值为 `manual`（手动）、`threshold`（达到阈值）、`overflow`（上下文溢出）。

| 事件 | 含义 / 字段 | 主进程处理 | 前端处理 |
| --- | --- | --- | --- |
| `compaction_start` | 压缩开始；`reason` | 转发 | **未处理**：没有该事件驱动的压缩中状态 |
| `compaction_end` | 压缩结束；`reason`、`result`、`aborted`、`willRetry`、`errorMessage?` | 转发 | **部分处理**：仅在 `result` 非空、未取消、当前不在运行且不准备重试时刷新控制信息与历史；不消费 `errorMessage` 或按 `reason` 展示状态 |

`result` 的值可以为 `undefined`。自动压缩可能发生在 `agent_end` 与 `agent_settled` 之间，前端此时仍保持运行状态，因此跳过此处刷新，最终由 `agent_settled` 刷新控制信息与历史；手动压缩没有完整 Agent 活动结束事件，仍在这里刷新。这里记录的是事件处理情况，不代表手动压缩调用的 Promise 错误也被忽略。

### 会话状态与直接 Bash 执行：5 类

| 事件 | 含义 / 字段 | 主进程处理 | 前端处理 |
| --- | --- | --- | --- |
| `queue_update` | 排队消息变化；`steering`、`followUp` | 转发；批量修改队列时延迟并合并中间通知 | **部分处理**：只同步合法的 `followUp` 字符串数组，不消费 `steering` |
| `entry_appended` | 会话新增条目；`entry` | 转发 | **未处理**：不基于该事件即时刷新；部分变化依赖后续历史读取 |
| `session_info_changed` | 会话名称变化；`name`，可为 `undefined` | 转发 | **部分处理**：只用非空字符串重命名标签，名称清空不处理 |
| `thinking_level_changed` | 思考等级变化；`level` | 转发 | **已处理**：接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 并更新会话状态 |
| `bash_execution_update` | 用户直接执行 Bash 的增量输出；`id?`、`delta` | 转发 | **部分处理**：只有 `id` 和 `delta` 均为字符串时，才按动画帧追加到对应 Bash 输出 |

`bash_execution_update` 来自 `AgentSession.executeBash()`，不是 Agent 调用 Bash 工具的 `tool_execution_update`。前者有输出展示，不代表后者的中间输出也被处理。

## 底层模型流事件：12 类

这些是 `AssistantMessageEvent`，不是额外的顶层会话事件。其中 9 类内容更新事件保留在 `message_update.assistantMessageEvent` 中；`start`、`done`、`error` 被 SDK 转为消息生命周期事件，不作为嵌套更新转发。

| 底层事件 | 字段（省略 `type`） | SDK 转换与 Pig 处理 |
| --- | --- | --- |
| `start` | `partial` | SDK 转为 `message_start`；Pig 追加实时消息 |
| `text_start` | `contentIndex`、`partial` | 随 `message_update` 更新完整消息快照，不单独处理文本块开始状态 |
| `text_delta` | `contentIndex`、`delta`、`partial` | 随 `message_update` 展示流式文本；使用完整消息快照而非单独拼接 `delta` |
| `text_end` | `contentIndex`、`content`、`partial` | 随 `message_update` 更新完整消息快照 |
| `thinking_start` | `contentIndex`、`partial` | 更新完整消息快照，并用于开始思考计时 |
| `thinking_delta` | `contentIndex`、`delta`、`partial` | 更新完整消息快照，并跟踪思考计时 |
| `thinking_end` | `contentIndex`、`content`、`partial` | 更新完整消息快照，并结束对应思考块的计时 |
| `toolcall_start` | `contentIndex`、`partial` | 更新完整消息快照，由 `toolCall` 内容块间接展示调用 |
| `toolcall_delta` | `contentIndex`、`delta`、`partial` | 更新完整消息快照，工具参数随内容块更新 |
| `toolcall_end` | `contentIndex`、`toolCall`、`partial` | 更新完整消息快照，保留最终工具调用 |
| `done` | `reason`、`message` | SDK 转为 `message_end`；Pig 保存最终消息 |
| `error` | `reason`、`error` | SDK 转为 `message_end`；Pig 保存最终错误或取消消息，错误文本由消息投影展示 |

`done.reason` 为 `stop`、`length`、`toolUse` 或 `deferred`；`error.reason` 为 `aborted` 或 `error`。若请求在模型流开始前失败，SDK 仍会先补发 `message_start`，再发 `message_end`。

思考计时还会根据消息内容推断开始及结束，并在 `message_end` / `agent_end` 收尾；`agent_settled` 还会收尾剩余思考计时。不完全依赖三个 `thinking_*` 事件。

没有独立的 `network_error` 或 `timeout` 顶层会话事件。网络错误和超时通常表现为 Assistant 消息的 `stopReason: 'error'`、`errorMessage`，以及符合重试条件时的重试事件。连接仍在等待、尚未报错时，不一定已有重试事件。

## 已知缺口

1. **重试详情缺失**：普通请求及摘要重试的五类事件都未消费；等待重试时已保持整体运行状态，但没有重试次数、等待时间、原因或事件驱动的最终结果展示。
2. **压缩状态不完整**：没有消费 `compaction_start`，`compaction_end.errorMessage` 也没有事件驱动的展示。
3. **工具中间输出缺失**：`tool_execution_update.partialResult` 未进入 GUI；工具开始和结束仅由消息间接呈现。
4. **部分状态字段未同步**：`queue_update.steering`、会话名称清空、没有 `id` 的直接 Bash 输出未处理；`entry_appended` 没有即时消费。
5. **事件类型没有穷尽性检查**：前端的 `PiSessionEvent.type` 是普通 `string`，`SessionApi.onEvent` 接收 `unknown`，事件路由没有默认告警。SDK 新增事件不会因此触发穷尽性类型错误，可能被静默忽略。

未直接处理不等于一定需要新增 UI。例如 `turn_start` 可以不独立展示，工具最终结果也已有消息路径。应区分功能确实缺失、字段遗漏和有意使用其他事件投影。

## 核对来源与维护

SDK 的类型与事件转换实现：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`：`AgentSessionEvent`。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`：重试、压缩和完整活动结束事件的发出逻辑。
- `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`：基础 `AgentEvent`。
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`：模型流事件到消息事件的转换。
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts`：`AssistantMessageEvent`。

Pig 的生产与消费实现：

- [主进程事件桥](../src/main/pi/event-bridge.ts)：转发、用户消息展示元数据、队列通知合并、完成通知。
- [Preload API](../src/preload/index.ts)：`pi:event` 监听白名单。
- [共享 API 契约](../src/shared/api.ts)：`SessionApi.onEvent`。
- [前端事件路由](../src/renderer/src/chat/session-events.ts)：直接处理分支与批量更新。
- [思考计时](../src/renderer/src/chat/thinking-tracker.ts)：嵌套模型流事件处理。
- [前端消息与事件类型](../src/renderer/src/pi/types.ts)：`PiSessionEvent`。
- [消息投影](../src/renderer/src/chat/turns.ts)：工具调用、工具结果、错误、摘要等展示数据的构建。
- [会话状态更新](../src/renderer/src/stores/sessions/conversation-slice.ts)：控制信息、消息与历史刷新。

升级 Pi SDK 或修改事件消费逻辑时，同步核对三个事件联合类型、更新处理状态及缺口，避免只依据 SDK 文档中的示例 `switch` 判断清单是否完整。
