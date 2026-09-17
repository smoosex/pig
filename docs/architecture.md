# 代码导航

Pig 保留 Electron 的 main / preload / renderer 边界。会话由 main 中的 Pi SDK
持有，JSONL 是历史记录的真相；renderer 只保存可重建的展示投影和界面状态。

## 进程与接口

| 位置 | 职责 |
| --- | --- |
| `src/shared/api.ts` | 跨进程 DTO 与 `SessionApi`，不依赖 Electron 或 React |
| `src/shared/session-images.ts` | `pig-image` URL 的形状与解析；renderer 只把 url 当不透明字符串 |
| `src/preload/index.ts` | IPC 白名单，用共享契约检查暴露的接口 |
| `src/main/ipc/` | 接收请求、解析窗口、调用业务模块、返回 DTO |
| `src/main/session-image-protocol.ts` | 注册 `pig-image` scheme 并按需返回图片字节 |
| `src/main/app-url.ts` | 窗口只允许停在自己的 UI 上（含重定向） |
| `src/main/open-project-sessions.ts` | 按 Worktree 持久化已打开会话及活动标签；与进程中的 session 生命周期分离 |
| `src/main/pi/session-jsonl.ts` | 按行索引 JSONL，只解析要用的行；担保不了就报错让 SDK 接手 |
| `src/main/pi/session-source.ts` | pending / live 会话统一的只读条目视图 |
| `src/renderer/src/ipc/api.ts` | renderer 的接口入口，复用共享类型 |
| `src/renderer/src/lib/highlight.ts` | Shiki 高亮（WASM 引擎、按可见性触发、LRU 缓存） |

新增跨进程字段时先改共享契约，再改 main 的生产端和 renderer 的消费端。
不要在 preload 声明、renderer 或 main 各复制一份接口。

## Main：会话与工作目录

`pi/session-registry.ts` 负责 pending / preparing / live 会话的生命周期。
打开会话只索引 JSONL（`pi/session-jsonl.ts` 按行记录 id/parentId/type/role 与字节偏移），
SDK 构建推迟到第一次真正需要 agentSession 的交互
（发送提示词、斜杠命令、切换分支、导出）。会话必须完成扩展绑定和待应用的模型设置后
才能发布为 live；关闭目录时先等待正在初始化的会话，再释放资源。空分支页会按 cwd 持有一个
未加入标签和打开记录的 pending 草稿，使模型、思考强度和斜杠命令在首条消息前可用；发送时
提升为正式标签，离开时丢弃。草稿在发送前不落盘：斜杠命令、控件与投影这类读路径只建 SDK 会话，
文件由 `activateSession` 在首条消息真正发出时创建——写 header 并连同 manager 已持有的条目把文件
交给 SDK，build 失败则把刚建的文件收回，因此历史与侧边栏不会出现从未发过消息的空会话。模型设置、controls 投影、
树投影、提示词处理分别位于 `model-settings`、`session-controls`、`session-tree`、
`session-prompt`。pending 会话通过 `pi/session-source.ts` 读取：新会话读内存里的 manager，
已打开的会话按分支读文件行，只有需要的那几行会被解析（`pi/session-jsonl.ts` 的探针能直接
读出 id/parentId/type/role，读不出就退回整行 `JSON.parse`，与 SDK 一致地跳过坏行）。
打开本身只读文件尾部的 60 轮，不建索引：分支索引与全轮次摘要在首屏之后才构建，完成后用
`session:window` 推送补正 `startIndex`/`totalTurns`/摘要（此前 renderer 只知道"上面还有"）。
推送里的偏移由打开时交给 renderer 的那个窗口反推（尾窗已覆盖整个文件时偏移保持 0），
不假定窗口一定是 60 轮。索引建不起来时走同一条 `session:window` 推送报错，renderer 据此停止
承诺更早的轮次并显示失败原因，而不是把「上面还有」永久留在界面上。
索引扫描顺带记下每轮开行是否有图并跳过隐藏类型（`display: false` 的 `custom_message` 要读一次
它自己的 payload 才能判定，每份会话只有个位数），所以全轮次摘要
与轮次边界都不再回头读文件；轮次边界与投影用同一套规则（首条用户消息之前的可见行自成一"轮"）。
会话树读的是同一份行的精简版（`readTreeEntries`）：工具结果的输出和 compaction 的总结留在磁盘上，
只保留它们的标签需要的字段，整棵树在会话还是 pending 时最多构建一次（首次仍要读一遍文件，
最大会话约 1.4s，重开对话框不再重读）。
凡是要读全分支的路径——翻页、会话树、控件里的模型与上下文用量、token 统计、pig-image 的
条目查找——都等同一个 `sessionIndex()` promise，所以首屏不再为它们排队；尾窗里的图片先由
打开时留下的尾部条目作答，不去等索引。
controls 从最后一条 model_change / thinking_level_change 与最后一处 assistant 用量回退出模型、
思考等级与上下文用量，不呈现全局默认值，也不为了一行总结付整棵树的解析代价；整个会话文件的
累计 token 只在用量弹层打开时通过 `session:get-token-stats` 现取（最大会话约 250ms）。
reader 无法担保的文件（旧版本、坏行导致父子链断裂）会退回 SDK 自己的解析；索引建立后如果发现某一行
其实解析不出条目（截断的写入、手工改坏），同一条通道把该会话降级成 SDK 内存会话、补发一次 manager
口径的窗口，并把当次请求按 SDK 的结果重做一遍——索引的轮数、`leafId` 与分支因此不会和文件本身不一致。

`session-display` / `session-display-model` 从 JSONL 生成轻量的对话轮次，
过程详情按需读取（只解析该轮自己的行，不再为一行展开读整条分支）。打开只带回尾部 60 轮与
全轮次摘要（每轮只读用户行的字节数与是否含图，
不解析正文，口径是「该轮开行的磁盘行字节，含图封顶」，与实时 source 从条目序列化出来的数字相同），
更早的轮次由 `session:get-turn-window` 按需取；renderer 只保存一个窗口，
读到顶部时向上补页，向上补页不会移动读者当前的位置。同一分支的刷新（回答结束、消费掉斜杠命令）
会用带 `keepOlderTurns` 的 hydrate 把新尾窗接到已加载的前缀上，不会把读者翻上去的历史丢掉；切换分支
仍然整窗替换。取历史、取轮次窗口或取用量统计失败时，错误会进 runtime 并显示在顶部提示或用量弹层里，
不会只留在控制台。停在最顶端的读者滚不出新的滚动事件，所以顶部提示本身就是一个按钮：已加载的行
由它挂到读者上方（仍然保持阅读行不动），还没取过的页由它触发取页。窗口切在某轮开头时会带上该轮前面的
`pig.pasted-text` 行，否则首轮会丢掉粘贴卡片。轮次里的图片只带 `pig-image://session/<sessionId>/<entryId>/<blockIndex>`
URL，base64 字节由 `session-image-protocol` 在真正渲染时按需返回，所以长会话的轮次载荷
不会随历史图片增长；未落盘的实时消息仍然内联 base64。写入端与读取端共用
`shared/session-images` 的判据（`isImagePayload` / `imageBlockPayload`）：`prompt-input` 用它决定
能落盘什么，读取端用它决定能返回什么，所以写入端接受的东西一定能取回（content-type 参数会被
归一化掉）。投影只做结构判定（type / mime / 非空），不扫 base64：这个会话的图片 base64
有 61MB，全量扫一遍要 180ms，而投影本身只要 4ms，所以字节由读取端在真正取图时判定，被拒绝的
块表现为缺图。窗口导航由 `app-url` 限制在自己 UI（dev server 或打包入口）之内，因为 preload 桥
会附着到窗口里的任何文档上。`event-bridge` 发布正在运行的 Pi 事件及队列状态。这些模块不依赖
React，也不维护另一套聊天记录。

`worktrees.ts` 负责 Git 工作目录的串行变更、命名和删除保护；
`project-worktrees.ts` 负责项目与工作目录的组合查询。分支命名继续使用
独立、短生命周期的 utility process。`open-project-sessions.ts` 把“已打开”保存到
`PIG_DIR/open-project-sessions.json`：用户关闭才移除记录，应用退出时的资源释放不移除。
恢复时只有当前 Worktree 的活动标签真正调用 `openSession`，其余标签保持冷状态。启动扫描暂时无法匹配的 Worktree 或会话只在本次恢复中忽略，不回写删除持久化记录；记录仅由用户关闭、删除项目或删除 Worktree 等明确操作移除。恢复只有真正成功才算完成：项目扫描或持久化读取失败时不置 `workspaceRestoreReady`，把原因留在 `workspaceRestoreError`，窗口重新聚焦或用户点击重试都会再跑一次，直到成功。只有文件不存在才会被当作空状态；其他读取错误直接上抛并中止本次写入，内容无法解析的文件先改名为 `open-project-sessions.json.corrupt` 归档，避免下一次写入把已有记录覆盖成空。

## Renderer：状态与展示

`stores/sessions.ts` 将三个 slice 组合成一个 Zustand store：

- `catalog-slice`：项目、独立对话、工作目录的发现和成员变更。
- `tabs-slice`：按 Worktree 打开、关闭、恢复和懒加载标签页，并管理标题。
- `conversation-slice`：历史轮次、实时 Pi messages、过程缓存、controls 与分支视图。

保留一个 store 是为了让删除项目、关闭关联标签页和清理运行状态保持原子性。
组件使用细粒度 selector；模型用量等频繁变化的数据由实际展示它们的控件订阅。

`hooks/useEventBridge.ts` 只绑定订阅生命周期。事件路由位于
`chat/session-events.ts`，思考耗时测量位于 `chat/thinking-tracker.ts`，
消息到 turn 的纯投影位于 `chat/turns.ts`。

UI 按功能组合：`components/composer/` 管理文档、附件、命令和发送；
`components/turn/` 展示用户消息、答案、过程和工具结果；
`components/sidebar/` 组合项目、工作目录和已打开会话；顶部 `SessionHistoryPopover`
展示当前 Worktree 的全部磁盘会话，删除也只从这里进入；`components/settings/`
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
- 停在最顶端的读者滚不出新的滚动事件：分页已经在上一次滚动里发生，所以顶部提示是按钮，点击即可把已加载的轮次挂到上方（阅读行保持不动），之后继续向上滚动恢复常态；窗口还只是占位尾窗（偏移未定）时这行改成状态文案，不给一个点了也没用的按钮。
- 阅读位置按分支/分支视图记录；切回某分支时它只带回尾窗，因此恢复快照里会带上该轮的绝对序号，由 `useConversationScroll` 先把包含锚点的窗口逐页取回来再对齐，而不是退回旧的滚动偏移。
- 导航到未挂载的轮次时先分页再通过消息锚点对齐，不使用轮询或置顶重试；跳向很远的历史时按每页最多 200 轮逐步补页（同一页的在途请求由多个读者共用），不会一次读完整段空白。
- 缩略图每根条带的是该轮在分支中的绝对序号，窗口内已加载的行与只有权重的行用同一套跳转语义。
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
bun run typecheck   # node、web、tests 三个 tsconfig 项目
bun test
bun run build
```

单元测试覆盖纯投影、并发时序及模拟 DOM 下的组件行为；不需要调用真实模型。
tests/ 由 `tsconfig.test.json` 单独检查（依赖从 `src/` 的真实类型推导），改跨进程
数据结构时 typecheck 会连同 fixtures 一起报错。
