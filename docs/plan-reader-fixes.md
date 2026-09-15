# 会话读取与窗口修复计划

来源：外部评审的 8 条（5 + 3，其中会话树一条重复）。每条都先验证过存在，证据见下。
原则：先改 reader 的数据契约，再改它的消费者；每条一个独立提交；每条都做变异验证。

**不变量（每条修复都必须保住）**

- 索引只由「确实能解析的行」决定：`turnCount`、`leafId`、`branch` 与 SDK 口径一致。
- 任何窗口都等于全量投影的对应切片；`fileSource` 与 `managerSource` 对同一内容的摘要逐字段相等。
- `branchIds()` 与 `branch().map(id)` 相等。
- 切分支仍整窗替换；窗口只向上增长；挂载上限仍 40 行；首屏仍是尾部 60 轮。
- 不做清单：不动 `measureAnchor`/`reanchor`、不动 20/40/60/200 上限、不动 `content-visibility`、
  不动 shiki/markdown、不新增 IPC 通道、preload 只改类型不改运行时。

**性能闸门（真实会话，临时脚本）**

- 索引相对当前 ±5% 以内；首屏仍尾部 60 轮；树首次打开从约 1.4s 降到约 0.6s（584MB 会话）；投影成本不变。

## 状态

| # | 问题 | 状态 |
|---|------|------|
| 1 | 索引收录无法解析的行（截断尾行 → 轮数/leafId 漂移） | 完成 |
| 2 | 会话树取 id 却全量解析分支（`session-tree.ts:363`） | 完成 |
| 3 | 返回分支只恢复尾窗，锚点丢失（31 → 198） | 完成 |
| 4 | 刷新失败只进控制台（`conversation-slice.ts:186-191`） | 完成 |
| 5 | 索引未就绪时顶部按钮可点但无效 | 完成 |
| 6 | `SUMMARY_BYTES_CAP` 两份定义 + 单位不一致 | 完成 |
| 7 | preload 推送类型写窄（`index.ts:99`） | 完成 |

## 逐条方案与证据

### 1. 索引收录无法解析的行

根因：`probeSessionRow` 只校验首字节 `"type"`、末字节 `}`。截断的末行丢掉最外层 `}` 但以内部 `}`
结尾时通过探针 → 进索引，而 `parseSessionEntries` 读取时把它丢掉。复现（`/tmp/phantom.ts`）：
`turnCount` 2 vs SDK 1、`leafId='u2'`（解析后不存在）、`windowUpdate` 推 startIndex 1 / 权重 2。

改法：

- 索引尾部校验：扫描结束后对末行实打实解析一次，解析不出条目就剔除该行（最多 8 行），再做
  悬空父引用检查、算 `leafId` 与 `branch`。这样索引的计数与 id 只建立在能解析的行上。
- 读取断言：`readBranchEntries` / `readAllEntries` / `readTurnEntries` / `readEntryById` /
  `readTreeEntries` 断言「产出条目数 == 请求行数」，不一致抛 `UnsupportedSessionFile`；
  `session-registry` 捕获后把该文件会话降级成内存会话（`SessionManager.open`，与 `warmIndex`
  现有兜底同一份逻辑）并重试一次请求。
- 不改探针为逐字节状态机（那要 JS 遍历 612MB）；探针漏判只多付一次解析，不会出错。

### 2. 会话树取 id 的全量解析

`SessionSource.branchIds()`：fileSource 用 `index.branch.map(row => row.id)`（零解析），
managerSource 用 `sessionManager.getBranch().map(entry => entry.id)`。实测 584MB 会话这一项
816.7ms / 29650 行，精简读取本身 608.7ms。依赖 #1 先落地（索引里不再有不可解析的行）。

### 3. 返回分支的窗口与锚点

`ScrollSnapshot.anchor` 增加 `index`（绝对轮次序号，`capture()` 用 `windowStart + localIndex` 算）；
恢复 effect 在锚点不在 `allTurns` 且 `anchor.index < windowStart` 时调用 `onLoadOlder(anchor.index)`
并保留 `pendingRestore`，窗口长上来后走既有的 `changeWindow` + 对齐；索引未就绪（`indexPending`）
时不消费锚点。`onLoadOlder` 改成接受可选 target。不做「按分支保存窗口」（状态更多）。

### 4. 刷新失败的错误出口

leafId 不一致时的重取失败改为写 `{ turnPending: false, turnError }`（与 warmIndex 失败推送一致），
不再只 `console.error`。

### 5. 索引未就绪时的顶部提示

`indexPending && windowStart === 0`（占位窗口）时渲染状态行「正在统计更早轮次…」，不做成可点按钮；
`turnError` 优先，加载中仍显示「正在加载更早消息…」。索引到位后按钮恢复。

### 6. 摘要口径统一

常量只留在 `session-jsonl.ts` 并导出；口径统一为「用户行写入磁盘的字节长度，封顶 4096，含图封顶」：
文件侧 `row.end - row.start`（去掉换行），manager 侧 `Buffer.byteLength(JSON.stringify(entry))`
（含图轮直接取 CAP，不 stringify），两侧天然相等且不增加解析成本。

### 7. preload 推送类型

`index.ts:99` 的 `SessionWindowUpdate` 改为 `SessionWindowMessage`（`shared/api.ts` 已是联合类型），
运行时零变化。

## 执行日志

### 1. 索引与读取契约（完成）

- `src/main/pi/session-jsonl.ts`：`indexSessionFile` 在算 `leafId`/`branch` 前用 `trimUnreadableTail`
  解析末行（最多 8 行，解析不出就剔除，仍读不出则 `UnsupportedSessionFile`）；新增
  `readRowsStrict`，`readTurnEntries` / `readEntryById` / `readBranchEntries` / `readAllEntries` 与
  `readTreeEntries` 的非 stub 行都断言「产出条目数 == 请求行数」。
- `src/main/pi/session-registry.ts`：`downgradeFileSession` 把文件会话换成 `SessionManager.open`
  的内存会话（warmIndex 与读取路径共用），并给 renderer 补发一次 manager 口径的 `session:window`；
  `retryAfterIndexFallback` / `withSource` 把 `UnsupportedSessionFile` 变成「降级 + 重试一次」。
- `src/main/pi/session-display.ts` 走 `withSource`；`session-controls.ts` 的 `fileTokenStats` 用
  `readRowsStrict`；`getSessionTree` / `getSessionTokenStats` 走同一重试。
- fixture：`session-jsonl.test.ts` 三条（截断尾行被剔除且 leafId 回退、中段坏行读取抛错、
  字符串里的括号不误剔）；`session-source.test.ts` 一条（截断尾行在索引/投影/windowUpdate/SDK
  四处一致）；`session-open-window.test.ts` 新增中段坏行段（索引先报 2 轮 → 读取降级 → 窗口按 SDK 口径补正）。
- 变异验证：去掉 `trimUnreadableTail` → jsonl 挂 1、session-source 挂 1；把 strict 读换回 lenient →
  jsonl 挂 1；去掉降级 → `session-open-window` fixture 失败。
- 实测（真实会话）：122MB 索引 41.1ms（此前 36–54ms）、584MB 113.9ms（此前 131–204ms），
  `leafId` 与 SDK 一致、轮数与 SDK 的用户轮数一致（939 / 1769），未触发 SDK 兜底。

### 2. 会话树的 branchIds（完成）

- `SessionSource.branchIds()`：`fileSource` 用 `index.branch.map(row => row.id)`，`managerSource` 用
  `sessionManager.getBranch().map(entry => entry.id)`；`sessionTreeRows` 改用它。
- fixture：`session-source.test.ts` 断言两种 source 的 `branchIds()` == `branch().map(id)`；
  `session-projections.test.ts` 用「`branch()` 一被调用就抛错」的 source 断言树不再解析分支。
- 变异验证：把 `sessionTreeRows` 换回 `source.branch()` → projections 挂 1。
- 实测：`branchIds()` 0.17ms / 0.22ms（此前 162.7ms / 816.7ms）；树首次打开 120ms（122MB，此前约 286ms）
  与 241ms（584MB，此前约 1400ms），树投影与 SDK manager 的结果完全一致。

### 3. 返回分支时把锚点所在的窗口取回来（完成）

- `chat/scroll-state.ts`：`ScrollSnapshot.anchor` 增加可选 `index`。
- `useConversationScroll.ts`：`measureRow` 顺带读行的绝对序号，`capture()` 在窗口未定（`windowPending`）
  时不写 `index`；恢复 effect 在锚点不在已加载窗口且 `index < windowStart` 时调用
  `onLoadOlder(anchor.index)` 并保留待恢复请求（最多 32 次，防病态窗口），随后走既有的
  `changeWindow` + 对齐；`onLoadOlder` 类型改为 `(target?: number) => void`。
- `ConversationViewport.tsx`：把 `indexPending` 作为 `windowPending` 传给 hook，`onLoadOlder` 透传 target。
- fixture：`chat-view-scroll.test.ts` 新增 `return-to-branch-window`（200 轮分支用缩略图跳到第 41 轮，
  切到另一分支再回到只带回尾窗的同一分支 → 断言按锚点取页、窗口覆盖锚点、锚点行回到原偏移）。
- 变异验证：去掉取页分支 → 该 fixture 挂 1。全套 18 条 fixture 通过。

### 4. 刷新失败的错误出口（完成）

- `conversation-slice.ts`：leafId 不一致的重取失败写 `{ turnPending: false, turnError }`。
- fixture：`session-store.test.ts` 新增 `stale-window-failure`（失败后不再 pending、有错误文案，
  下一次成功窗口清除它）。
- 变异验证：换回 `console.error` → session-store 挂 2。

### 5. 占位窗口的顶部提示（完成）

- `ConversationViewport.tsx`：`indexPending && windowStart === 0` 时渲染「正在统计更早轮次…」状态行，
  不再是可点按钮；settle 后按钮恢复（`turnError` 优先级仍在最前）。
- fixture：`chat-view-scroll.test.ts` 新增 `pending-window-status`。
- 变异验证：去掉状态行分支 → 该 fixture 挂 1。

### 6. 摘要口径统一（完成）

- `session-jsonl.ts` 导出 `SUMMARY_BYTES_CAP`，文件侧口径改为「行字节去掉换行、含图直接封顶」；
  `session-source.ts` 删除本地常量、manager 侧改为 `Buffer.byteLength(JSON.stringify(entry))`
  （含图直接封顶，不 stringify）并缓存结果。
- fixture：`session-source.test.ts` 新增「两种 source 对同一轮权重完全相同」（纯文本、中文、含图各一轮）。
- 变异验证：把 manager 侧换回 `text.length` → 该 fixture 挂 1。
- 实测：122MB 会话文件侧 0.2ms、manager 侧首次 34.3ms / 重复 0.0ms，两侧 939 轮权重完全相同；
  584MB 会话首次 37.4ms，两侧 1769 轮完全相同；首屏未受影响（10.6ms / 60 轮）。

### 7. preload 推送类型（完成）

- `src/preload/index.ts`：`onSessionWindow` 的入参类型与 handler 改成 `SessionWindowMessage`
  （引入同名类型，移除未用的 `SessionWindowUpdate`）。运行时零变化，`bun run typecheck` 干净。

### 收尾闸门

- `bun run typecheck`（node + web）干净。
- 全量 `bun test`：**233 pass / 0 fail / 497 expect() / 29 文件**，连跑两次（41.5s）无 flake。
- 真实会话闸门：索引成本未回退、树投影与 SDK 一致、两种 source 的轮次权重一致、首屏仍是尾部 60 轮。
- 未提交（等指示）。
