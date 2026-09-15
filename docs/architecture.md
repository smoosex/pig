# 代码导航

Pig 保留 Electron 的 main / preload / renderer 边界。会话由 main 中的 Pi SDK
持有，JSONL 是历史记录的真相；renderer 只保存可重建的展示投影和界面状态。

## 进程与接口

| 位置 | 职责 |
| --- | --- |
| `src/shared/api.ts` | 跨进程 DTO 与 `SessionApi`，不依赖 Electron 或 React |
| `src/preload/index.ts` | IPC 白名单，用共享契约检查暴露的接口 |
| `src/main/ipc/` | 接收请求、解析窗口、调用业务模块、返回 DTO |
| `src/renderer/src/ipc/api.ts` | renderer 的接口入口，复用共享类型 |

新增跨进程字段时先改共享契约，再改 main 的生产端和 renderer 的消费端。
不要在 preload 声明、renderer 或 main 各复制一份接口。

## Main：会话与工作目录

`pi/session-registry.ts` 负责 pending / preparing / live 会话的生命周期。
会话必须完成扩展绑定和待应用的模型设置后才能发布为 live；关闭目录时先等待
正在初始化的会话，再释放资源。模型设置、controls 投影、树投影、提示词处理
分别位于 `model-settings`、`session-controls`、`session-tree`、`session-prompt`。

`session-display` / `session-display-model` 从 JSONL 生成轻量的对话轮次，
过程详情按需读取。`event-bridge` 发布正在运行的 Pi 事件及队列状态。
这些模块不依赖 React，也不维护另一套聊天记录。

`worktrees.ts` 负责 Git 工作目录的串行变更、命名和删除保护；
`project-worktrees.ts` 负责项目与工作目录的组合查询。分支命名继续使用
独立、短生命周期的 utility process。

## Renderer：状态与展示

`stores/sessions.ts` 将三个 slice 组合成一个 Zustand store：

- `catalog-slice`：项目、独立对话、工作目录的发现和成员变更。
- `tabs-slice`：打开、关闭、切换标签页及标题。
- `conversation-slice`：历史轮次、实时 Pi messages、过程缓存、controls 与分支视图。

保留一个 store 是为了让删除项目、关闭关联标签页和清理运行状态保持原子性。
组件使用细粒度 selector；模型用量等频繁变化的数据由实际展示它们的控件订阅。

`hooks/useEventBridge.ts` 只绑定订阅生命周期。事件路由位于
`chat/session-events.ts`，思考耗时测量位于 `chat/thinking-tracker.ts`，
消息到 turn 的纯投影位于 `chat/turns.ts`。

UI 按功能组合：`components/composer/` 管理文档、附件、命令和发送；
`components/turn/` 展示用户消息、答案、过程和工具结果；
`components/sidebar/` 组合项目、工作目录和会话；`components/settings/`
按设置领域拆分。`components/ui/` 保持通用 shadcn 封装。

## 对话滚动

`ChatView` 按会话渲染面板，保留最近访问的三个面板并把其余隐藏，同时按会话 / 分支
缓存有限数量的阅读位置。`components/chat/ConversationViewport` 负责列表布局，
`useConversationScroll` 负责历史分页与阅读位置恢复，`TurnMinimap` 只发出跳转请求。

- `MessageScroller` 是唯一的滚动执行者，负责锚定、跟随、手动操作和回到底部按钮。
- 历史按窗口渲染：默认挂载最后 20 轮，窗口上限 40 轮；读到顶部向上追加一页，读到窗口底部再向下追加一页，超出上限的旧行卸载。
- 尚未归档的实时回合按正常文档流渲染在历史之后；历史窗口未覆盖到末尾时用分隔提示说明被省略的轮次。
- 发送提示后窗口回到末尾并继续跟随。
- 窗口增删行、以及视口上方的尺寸变化，都由 `useConversationScroll` 按顶部可见轮次重新对齐；手动滚动让出控制权，折叠操作暂停跟随。
- 隐藏面板不再写滚动位置：`autoScroll` 只在面板可见时生效，激活时按最后记录的阅读位置恢复。
- 导航到未挂载的轮次时先分页再通过消息锚点对齐，不使用轮询或置顶重试。
- 切换会话即时恢复阅读位置，恢复不使用平滑动画；生成过程中也可以使用回到底部按钮。

`patches/@shadcn%2Freact@0.3.1.patch` 为固定版本的组件补充显式暂停、偏移恢复、
状态读取及显式消息锚定。修改它时同步更新 `tests/message-scroller.test.ts`，
不要在业务组件外另建一套自动滚动状态机。

## 注释与验证

参考 [Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
和 [Agent](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)
的做法，模块开头交代职责，复杂逻辑说明生命周期、数据归属或时序约束。
能由函数名表达的动作不重复写成注释。

```bash
bun run typecheck
bun test
bun run build
```

单元测试覆盖纯投影、并发时序及模拟 DOM 下的组件行为；不需要调用真实模型。
