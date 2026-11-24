# Bot 页面与交互设计

> 权威专题文档。本文定义单 Bot 入口的视觉布局、顶栏与侧栏重构、灵珠头像按钮、非 Bot 页弹出气泡、圆心扩散转场、无侧栏对话剧场及后台任务视图；领域模型与后台编排见 [Bot 编排实施计划](bot-plan.md)，跨组件视觉与材质规则遵守 [UI 规范](ui-conventions.md) 和 [浏览器原生视图规范](browser.md)。

---

## 1. 设计目标与空间心智

工作区与 Bot 页面承担两种不同的工作心智，通过**极简而鲜明的空间切换**自然区隔：

- **工作区（Projects / Chats）**：三栏 + 分屏的「干活工作台」，专注代码、Diff、终端与浏览器。
- **Bot 页面**：**无侧边栏的「单中轴对话客厅」**，核心主角是与 Bot 的持续对话，后台正在跑的活以轻巧、随手可查但不喧宾夺主的方式贴在视野顶部与按需抽屉里。
- **连接纽带**：顶栏左侧的 **Bot 圆形灵珠头像按钮（`BotOrbButton`）**。你在工作区时，它是 Bot 的「在场呼吸口」和消息弹出点；点它，从圆珠向外扩散展开整个 Bot 空间；再点它，把 Bot 空间收回圆珠，工作区编辑器、分屏与草稿原样无损恢复。

---

## 2. 顶栏与左侧栏重构

### 2.1 顶栏左侧（`header[data-app-header]`）

当前 `src/renderer/src/App.tsx` 的 `data-header-leading` 放着 `<SidebarToggle />` 和 `<GooglyEyesButton />`（切换 `projects` / `chats`）。调整如下：

```text
调整前：[红绿灯]  [SidebarToggle]  [GooglyEyes: 项目/对话]    |   TabBar   |   [+][书签][右侧栏]
调整后：[红绿灯]  [SidebarToggle]  [BotOrbButton ○]           |   TabBar   |   [+][书签][右侧栏]
```

- **`BotOrbButton` 占据原 `GooglyEyesButton` 的位置**：
  - 基础命中区 `size-7`（28px），与同栏图标按钮等高，居中对齐在 `h-10` 顶栏内，外环光晕通过不占布局空间的 `box-shadow` / 伪层绘制。
  - **独立于左侧栏折叠状态**：即使 `leftCollapsed === true`，`BotOrbButton` 始终留在 `data-header-leading`，保证随时可点击进入、随时能承接 Bot 弹出消息气泡。
  - 进入 `settingsOpen` 时随普通顶栏一起隐藏（沿用现有设置页覆盖规则），后台任务与未读角标继续保持。

### 2.2 左侧栏顶部（「项目 / 对话」切换器搬家）

将原来的「项目 / 对话」切换器迁移到 `src/renderer/src/components/Sidebar.tsx` 顶部，固定在 `ScrollArea` 上方、不随列表滚动：

```text
┌──────────────────────────────────┐
│  ( [📁 项目]  💬 )            +  │  ← 靠左胶囊容器 + 展开式活动药丸（顶边与中间卡片 8px 齐平）
├──────────────────────────────────┤
│  ProjectList / ChatList          │  ← 原有 ScrollArea + SidebarHoverHighlight
│  ...                             │
└──────────────────────────────────┘
```

- **形态与材质**：靠左放置的胶囊切换器（`SidebarModeSwitch`），复用右侧栏 `WorkspacePanel` 的 `ToggleGroup` + `motion/react` `layoutId` 滑动玻璃药丸与活动项文字展开动画，并将两枚按钮包裹在同一外层胶囊容器内（不再铺满整宽，也不把大眼睛按钮硬塞进窄侧栏）。
  - **顶部对齐**：外层 header 使用 `pt-2 pb-0.5`（总高 40px，与右侧栏 `h-9 mb-1` 一致），胶囊顶边与中间对话区 `m-2`（8px）齐平；
  - **外层胶囊容器**：Glass 使用 `rounded-full border border-glass-border bg-glass-prompt-foreground/6 p-0.5`，Solid 使用 `solid:border-sidebar-border solid:bg-transparent`；
  - **活动滑块药丸**：沿用 `WorkspacePanel` 的 `border-glass-button-border bg-glass-button-background bg-[image:var(--glass-button-sheen)] shadow-glass-button`（Solid 下为 `solid:border-border solid:bg-sidebar-accent`），`prefers-reduced-motion` 下退化为瞬切。
- **顶部动作对齐**：原 `Sidebar.tsx` 中仅在 `tab === 'chats'` 时才渲染的标题栏 + `+` 按钮收归到切换轨右侧（`projects` 下放 `FolderPlus` 或保持底部按钮，`chats` 下放 `Plus` 新建对话），使 `projects` 与 `chats` 两个标签的列表起始纵坐标完全一致，切换无跳动。
- `switchSidebarTab` 与 `halfSwitch` 状态迁移逻辑不变。

---

## 3. Bot 顶栏四叶草入口（`BotOrbButton`）与动态头像

### 3.1 顶栏动态四叶草入口

工作区顶栏与 Bot 页面顶栏共用同一 `BotOrbButton` 入口，直接复用 `bot-avatars` 的 `<BotAvatar type="clover" size={22} />`（与 Bot 页面形象统一，不再使用彩虹环、暗底盘或像素小猪徽章）：

1. **命中区与不裁切布局**：外层按钮维持 `size-7`（28×28px）圆形命中区，不加 `overflow-hidden`；`size={22}` 配合 `bot-avatars` 的 `1.5×` overscan（33×33px 画布，上方预留 `7.7px` 跳动余量）可完整落在 `h-10`（40px）顶栏内，动画不被裁切也不挤占顶栏；画布设置 `pointer-events-none` 与 `aria-hidden="true"`，确保命中区严格保持 28px 且无障碍名称由外层按钮统一提供。
2. **动态与省电**：后台任务运行或 Bot 思考回复时切换为 `state="working"`，空闲保持 `state="default"`；`registerAnchor={false}`（隐藏壳层内的副本）自动 `paused`，并尊重 `prefers-reduced-motion` 自动停在静态帧。
3. **状态光晕层（Outer Aura）**：位于按钮外缘的非占位柔光与告警环（`approval` 呼吸告警环、`attention` 失败细环、`open`/`unread`/悬停微光，复用 `--bot-orb-ring` / `--bot-orb-glow`）。
4. **状态微标层（Corner Badge）**：仅在有未读、运行中、失败或需审批时于右下角浮出极小实心点，不遮挡四叶草面部。

### 3.2 按钮状态矩阵

| 状态 | 优先级 | 外环与光晕 | 微标 / 动效 |
| --- | --- | --- | --- |
| **待审批（`blocked_approval`）** | 1（最高） | `warning` 柔呼吸光晕（2.2s 慢脉动） | 右下角 `warning` 实心点 |
| **需关注 / 失败（`attention`）** | 2 | `destructive` 静态细环（不闪烁） | 右下角 `destructive` 小点 |
| **后台任务运行中（`running`）** | 3 | 无额外强环，避免喧宾夺主 | 四叶草切为 `working` 态 + 右下角 `primary` 活跃点（悬停 tooltip 显示具体运行数） |
| **有未读 Bot 消息（`unread`）** | 4 | `--bot-orb-glow` 柔光 + 新消息到达轻弹一次（不重挂画布） | 右下角 `primary` 未读圆点 |
| **空闲（`idle`）** | 5 | 悬停微放大 + 柔和微光 | 无角标，四叶草保持 `default` 态 |
| **已在 Bot 页（`active`）** | 叠加态 | 不加外环，保持与工作区一致的清爽形态；悬停提示「返回工作区」 | 进入 Bot 页即清零未读点 |

### 3.3 Bot 页面头像与 Bot 设置页（`bot-avatars`）

顶栏 `BotOrbButton` 与 Bot 页面（空状态主头像、思考/审批继续行、历史消息行）统一读取 `$PIG_DIR/bot/state.json` 中的 `avatar` 配置（默认 `clover` 四叶草），并在设置页「Bot」分区提供图形化切换（支持当前 `bot-avatars` 全部款式），同时保留各处原有动画/静态语义：顶栏 `size={22}` 随运行态切 `working`；空态 `size={96}` 启用完整动态与交互；思考和审批放行后的继续运行提示共用 `size={24}` 的 `working` 状态行；历史消息行保持 `size={24}` 静态（`paused`）以避免列表同时晃动。组件免 WebGL、自动适配亮暗表面，且在滚出视口、窗口隐藏或开启 `prefers-reduced-motion` 时自动暂停。设置页「Bot」分区同时提供「默认执行模型」配置（复用 `ModelThinkingPicker`，支持模型与思考强度选择），未设置时继承 Pig 全局默认，并提示用户可直接通过对话指令单次指定模型覆盖。

---

## 4. 非 Bot 页面弹出气泡（`BotPeekBubble`）

当用户**不在 Bot 页面**且 Bot 通过 `send_message` 发出新消息（或后台任务触发审批阻塞）时，消息从顶栏 `BotOrbButton` 弹出：

```text
    [SidebarToggle]  ( ◉ )  ← BotOrbButton
                       ▲
             ┌─────────┴────────────────────────┐
             │ ● 已完成 · pig                  × │  ← 可选状态胶囊（任务卡/审批时显示）
             │ 导出加速改好啦，单测也跑绿了，    │  ← 最多 2 行截断（line-clamp-2）
             │ diff 留在 bot/fix-export-a1b2…   │
             │                       +2 条未读  │  ← 连续多条时仅显示计数
             └──────────────────────────────────┘
```

### 4.1 视觉与截断规则

- **锚点与动效**：通过 Portal 锚定在 `BotOrbButton` 正下方偏右（`top: rect.bottom + 8px`，左对齐圆珠左缘并保留窗口安全边距），顶部带指向圆珠圆心的三角形尖角；弹出时从圆珠方向弹性展开（`transformOrigin` 指向尖角，`scale(0.86) translateY(-6px)` → `scale(1) translateY(0)`），收起时轻缩回圆珠。
- **材质**：Glass 下采用与悬浮侧栏一致的半透明卡片材质（**禁止叠加 `backdrop-filter`**，遵循 `ui-conventions.md` Glass 合成边界）；Solid 下采用 `bg-popover border border-border shadow-lg`。
- **严格截断**：
  - 气泡宽度固定 `w-76`（304px），单条内容最多 **2 行截断**（`line-clamp-2 break-words`），绝不撑成满屏长文。
  - 若是任务交付或审批提醒，顶部增加一行极简元信息（状态色点 + 状态短语 + 项目名），正文仍限 2 行。
- **单气泡防轰炸**：同一时刻最多只显示 **1 个** 气泡，不做堆叠 Toast 塔。短时间连续收到多条 `send_message` 时，原地平滑更新为最新一条预览，右下角显示 `+N 条未读`。

### 4.2 交互与生命周期

- **点击气泡主体**：立刻以 `BotOrbButton` 为圆心扩散进入 Bot 页面，滚动并高亮定位到对应消息或审批卡，同时清除该气泡。
- **自动收起**：普通消息展示 **6 秒** 后自动缩回圆珠；鼠标悬停或键盘聚焦在气泡内时暂停倒计时，移出后重新计时；点击右上角 `×` 可立即关闭（未读角标仍留在圆珠上）。
- **审批气泡驻留**：`blocked_approval` 类气泡不 6 秒自动消失（用户可手动 `×` 收起，收起后圆珠保持 `warning` 脉冲直到批复完成）。
- **原生浏览器视图（`WebContentsView`）遮挡协议**：
  - `BotPeekBubble` 挂载标准浮层标记并接入 `useBrowserBounds` 的浮层遮挡检测。
  - 仅当气泡矩形与当前可见原生浏览器区域相交时，触发 `docs/browser.md` 规定的「`browser:snapshot` 截帧交接 → 隐藏原生视图 → 气泡收起后两帧恢复」；不相交时不触碰原生浏览器，绝不依赖 DOM `z-index` 硬压。

---

## 5. 圆心扩散转场（Radial Expansion Transition）

点击 `BotOrbButton`（或快捷键 / 点击弹出气泡）进入与退出 Bot 模式时，执行**以圆珠为圆心的全屏径向扩散 / 收缩动画**。

### 5.1 复用与泛化现有 `surface-transition.ts`

Pig 已在 `src/renderer/src/lib/surface-transition.ts` 与 `src/renderer/src/styles.css` 实现了基于 `document.startViewTransition` + `@property --surface-reveal-radius` 的圆形 `clip-path` 转场，Bot 模式切换直接抽象复用同一套底层能力（拆分为通用 `radial-reveal.ts` 或参数化 `data-bot-reveal="enter" | "exit"`）：

- **互补遮罩（Glass 透明底防重影）**：与 `surface-transition.ts` 保持同一机制，同时驱动 `::view-transition-old(root)` 与 `::view-transition-new(root)` 两个伪元素的 `--bot-reveal-radius`——圆内伪元素用 `clip-path: circle(...)`，对侧底层伪元素用互补 `mask-image: radial-gradient(..., transparent R, #000 calc(R + 1px))` 同步挖空圆内像素，确保 Glass 透明窗口下扩散过的区域彻底覆盖旧界面且结束零跳变。
- **进入 Bot 模式（`expand`）**：
  - 原点 `(x, y)` = `BotOrbButton` 几何中心；
  - 半径动画：`0px` → `ceil(hypot(max(x, W - x), max(y, H - y))) + 2px`；
  - 时长与缓动：`380ms`，`cubic-bezier(0.22, 1, 0.36, 1)`；
  - `::view-transition-new(root)` 用 `clip-path` 扩出，`::view-transition-old(root)` 用互补 `mask-image` 同步挖空。
- **退出 Bot 模式（`collapse`）**：
  - 原点仍为 `BotOrbButton` 几何中心；
  - 半径动画：最大角半径 + `2px` → `0px`；
  - 时长与缓动：`300ms`，`cubic-bezier(0.4, 0, 0.2, 1)`；
  - `::view-transition-old(root)` 收缩裁剪，`::view-transition-new(root)` 用互补 `mask-image` 从四周合拢显露工作区。

### 5.2 工作区保活与安全边界

- **隐藏不卸载**：与 `WorkspaceLayout` 处理 `settingsOpen` 的机制完全一致——进入 Bot 模式时，底层工作区容器设为 `hidden` / `inert`（不卸载 React 树），离开前打开的分屏、编辑器选区、草稿、终端状态全部无损保留。
- **防 Chromium `SIGTRAP` 崩溃**：启动 `startViewTransition` 前必须调用现有 `dropNonEditableSelection()`，清除跨 `contenteditable="false"` chip 的 DOM 选区。
- **原生浏览器视图交接**：若退出前工作区可见原生 `WebContentsView`：
  - 进入 Bot 页前：先走截帧交接并隐藏原生视图，再跑扩散动画，防止原生网页悬浮穿透扩散圆；
  - 退出 Bot 页后：等收缩动画 `finished` 再恢复原生视图与 bounds 同步。
- **竞争与降级**：
  - 动画进行中再次点击快速来回切：取消旧 transition，直接按最新目标落地，不卡中间态；
  - `prefers-reduced-motion: reduce`、`document.visibilityState !== 'visible'` 或不支持 `startViewTransition` 时，跳过扩散动画直接切态。
- **启动落点记忆（`lastSurface`）**：首次升级默认落在熟悉的工作区；之后重启记住上次关闭前停留在工作区还是 Bot 页（持久化于 `$PIG_DIR/bot/state.json`），冷启动直达对应视图，不额外播放进场扩散动画。

---

## 6. Bot 页面布局设计（无侧栏 · 对话剧场 · 活态任务）

Bot 页面铺满整个窗口内容区（无左侧栏、无右侧栏、无多标签 TabBar），采用**「单中轴对话剧场 + 顶部自适应活态任务条 + 右侧按需任务抽屉」**的四层骨架：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ [红绿灯]  [≡] (◉)                 红线 · 正在忙 2 件事             [⬇] [···] │ ← 极简顶栏 (h-10, drag)
├──────────────────────────────────────────────────────────────────────────────┤
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  [⟳ pig · 导出性能优化  1m12s ↗ □]  [⚠ pig · 需要确认执行命令 ↗]    │   │ ← 活态任务条 (有活才出现)
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│                             ╭────────────────────────────────────╮           │
│                             │ 帮我把导出慢的问题查一下，顺手改掉 │           │ ← 用户消息气泡（复用工作区 Bubble）
│                             ╰────────────────────────────────────╯           │
│                                                                              │
│         (◉)                                                                  │ ← 头像置于回复内容上方（连续回复仅首条展示）
│         收到啦老大！我已经给 pig 开了一个隔离分支跑着排查，一有结果马上喊你～│ ← 无框阅读流排版（仅代码块/表格/交付卡起卡片层次）
│                                                                              │
│         改完啦！是批量渲染没做分片，已补了单测全绿。                         │
│         [📄 export.ts 4.2 KB ↗]                                              │ ← 可交互附件芯片（点击直达工作区文件标签页）
│         ┌────────────────────────────────────────────────────────┐           │ ← 结构化任务交付卡
│         │ ✓ 已完成 · pig · bot/fix-export-a1b2c3                 │           │
│         │ 3 个文件  +84 / -19  ████░░                            │           │
│         │ [打开会话]  [查看变更]                                 │           │
│         └────────────────────────────────────────────────────────┘           │
│         [📋] [···] 18:36                                                     │ ← 悬停显现的复制与时间戳操作栏
│                                                                              │
│         ┌────────────────────────────────────────────────────────┐           │
│         │ 跟红线说点什么，或直接交代要干的活…           [@] [📎] │           │ ← Bot 净化输入区（与阅读列左右齐平）
│         │ [模型/思考强度]                                 [发送] │           │
│         └────────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 极简顶栏（复用原生 `h-10` 窗口拖拽栏）

- **左侧**：
  - **任务列表按钮（`data-bot-tasks-trigger`）**：放置在 `BotOrbButton` 左侧的 `size-7` 槽位内居中，采用与工作区材质切换（`SurfaceStyleToggle`）一致的 `size-5.5` 圆形玻璃水珠样式（`bg-glass-orb-background`、`--glass-orb-sheen`、`shadow-glass-orb`，Solid 下 `ring-1 ring-sidebar-border`），有待审批或进行中任务时在右上角显示状态小点；悬停 Tooltip 展示名称、进行中数量与快捷键（`⇧⌘T`），点击从左侧展开/收起**非模态任务抽屉**。
  - 紧接 `BotOrbButton`（不加外环，点击即收缩回工作区），确保切进切出 Bot 页时灵珠位置纹丝不动、圆心扩散转场完全对准；后面不额外放置「返回工作区」按钮。
- **中间**：Bot 身份与当前轻量状态（如人格名 + 简短动态副标，例：「正在忙 2 件事」或当前心情简词），保持低视觉权重，不喧宾夺主。
- **右侧**：
  - **导出会话按钮（`Download`）**：位于 `MoreHorizontal` 左侧，复用工作区会话导出能力（支持保存为 HTML 或 JSONL）；空会话或导出进行中自动置灰防重入。
  - **低调更多菜单（`MoreHorizontal`）**：由于 Bot 坚持单条常驻时间线、不提供多会话侧栏，仅在此处收纳应急操作「新起一段 / 重置当前上下文」——点击弹出遵循 `AlertDialogFooter` 规范的二次确认框（取消用 `ghost`、不自动聚焦确认按钮），确认后归档旧 JSONL 并开启新会话，保留任务账本与长期记忆且不中断运行中的后台任务。

### 6.2 顶部活态任务条（`BotLiveTaskBar`）

专门回答「在无侧边栏的页面里，怎么一眼看清当前正在干什么后台活」：

- **显隐策略**：**仅在存在活跃任务（`starting` / `running` / `blocked_approval` / `stopping`）时平滑展开**；全部完成后自动优雅收起，让零任务时的 Bot 页完全回归纯净聊天界面。
- **布局与信息密度**：
  - 居中对齐对话中轴（`max-w-3xl`），固定在消息滚动区上方、不随对话滚动消失，也不会覆盖第一条消息；
  - 横向排列最多 **3 张紧凑任务胶囊（`h-9`）**，按优先级排序：`blocked_approval` > `running` / `starting` > `stopping`；
  - 超过 3 个活跃任务时，第 3 个槽位渲染 `+M 个任务` 折叠胶囊，点击直接打开右侧任务抽屉。
- **单张胶囊内容**：
  - 左侧：状态指示（待审批琥珀点 / `starting` 准备中微脉动 / 运行中复用 `RunningSpinners` / 正在停止旋转）；
  - 中部：`项目名 · 任务标题`（单行截断）+ 轻量实时状态或耗时（`starting` 态显示「准备中…」，运行后切为 `1m 12s`）；
  - 右侧快捷动作（悬停/焦点或触控态显现）：
    - `ArrowUpRight`：**跳转现场**（`starting` 尚未就绪时暂置灰提示，会话就绪后收缩回工作区并聚焦对应 worktree Session）；
    - `Square`：**精确停止**（直接触发 `stopOrigin: 'user'`，变为「正在停止…」）；
  - 点击胶囊主体：打开右侧任务抽屉并直接展开该任务详情。

### 6.3 主体对话剧场（`BotConversationStage`）

- **容器与滚动**：
  - 外层使用与主工作区一致的 `[data-content-surface]`（glass 下透出原生 vibrancy 材质，solid 下使用 `bg-chat-background`）；
  - 阅读列、顶部活态任务条与底部输入区共用 `botColumn`（`mx-auto w-full max-w-3xl px-4`），**直接复用工作区 `MessageScroller`（`py-2` 呼吸留白 + `behavior="smooth"` 回底按钮）与 `--chat-edge-fade` 上下对称渐变淡出（内容区 `py-(--chat-edge-fade)`）**，严禁另建滚动状态机。
- **内容投影规则（严格对齐 `send_message` 契约）**：
  - 仅渲染 5 类对象，模型未走 `send_message` 的内部思考、隐藏 `<system_reminder>`、原始工具 JSON 与静默调度日志**绝不渲染为气泡**：
    1. **用户消息（落流即收，无排队吊条）**：直接复用工作区 `UserBubble` 的 `Message` + `Bubble` 表面（Glass 下 `bg-glass-popover-background` + `--glass-popover-sheen` + `shadow-glass-bubble`，Solid 下 `user-message-background` / `user-message-foreground`），支持粘贴文本预览、图片预览、`@项目` 胶囊标签及悬停显现的复制/时间戳操作栏。用户每次发送后**立刻作为正式气泡落入消息流底部并清空输入框**；主动发送回到末尾，Bot 新消息只在已随滚时跟随，不打断向上翻阅。视口沿用会话的固定边缘淡出，绝不渲染普通会话的 `QueuedMessageRow` 排队条或「按 Tab 插话」提示；连续补发多条消息时自然紧贴排在底部，由后台调度器按未落地抢占合并或 `steer` 无感衔接。
    2. **Bot 文本消息**：上方左对齐配小型静态头像（`size={24}`，连续多条 Bot 消息仅在首条上方展示头像并收紧间距），正文对齐工作区 `Answer` 的**无框阅读流排版**（直接呈现在阅读底板上，仅代码块、表格与下方任务交付卡起卡片层次，避免“框套框”），底部附悬停显现的轻量动作栏（一键复制、复制 Markdown / 纯文本菜单、`HH:mm` 时间戳与完整时间 Tooltip）；若附带本地文件（`attachments`），渲染带 `FileTypeIcon` 与文件大小的胶囊按钮，项目/存活 worktree 内文件点击直接切回工作区打开对应文件标签页，外部路径点击复制绝对路径，缺失文件展示删除线失效态。当 Bot 主会话处于活跃生成中（尚未调用 `send_message`）时，消息流底部复用工作区 `WaitLine` 轮流展示幽默等待短句，收到 `send_message` 后立即衔接成回复并收起提示（避免工具返回后的尾段静默收尾继续闪动思考态；仅在后续启动实质本地工具或收到 `steer` 追问时重新亮起）。
    3. **结构化任务卡（派活卡 / 交付卡 / 停止回执卡）**：作为 `send_message` 附带的轻量结构化卡片嵌于对应消息下（同一任务在时间线中被多次提及时，仅在最新一条引用该任务的消息下挂完整卡片，避免叠放重复卡片）：
       - 顶部：状态徽标（`已完成` / `已由你停止` / `已停止` / `失败` / `已接管`）+ 项目名 + 分支名 `bot/<slug>-<shortId>`；
       - 中部：写任务的变更文件数与 `+N / -M` 比例条（复用 `TurnFileChanges` 的视觉语言；只读任务不展示共享仓库原有未提交改动）；
       - 底部操作行：**打开会话**（若尚未打开标签页则自动从会话列表加载并聚焦）、**查看变更**（跳转工作区打开变更标签页并展开右侧 Changes 面板；worktree 清理后自动隐藏）、**继续 / 重试**（对应 `bot_followup_task`，仅 `failed` / `stopped` / `interrupted` 态展示主按钮，用户显式点击才建新 `BotRun`）。
    4. **镜像审批卡**：直接复用 Pig 现有审批卡片组件，顶部标注来源「后台任务 · `<项目名>` · `<任务标题>`」，与后台 worktree Session 共享同一个 `requestId`；任一侧批准或拒绝，另一侧实时消解（同时承接 `bot_cleanup_worktree` 对脏/未合并 worktree 的强确认卡）。用户提交后台任务镜像审批后，若该后台任务仍在继续执行，消息流底部原地承接一行轻提示（「已提交审批决定，后台任务正在继续执行…」）直至新回复到达或状态终结。
    5. **系统兜底提示 / 系统交付卡**：当一轮零 `send_message` 且经宿主 1 次静默补调仍无输出或模型接口报错时（见 [Bot 编排实施计划](bot-plan.md) §5.1），由宿主插入明确标示为系统兜底的轻量提示条（带重试入口）或系统交付卡，绝不把未受控的内部草稿伪装成普通气泡，也不让用户干等或遗漏后台终结回执。
- **首次空状态（Empty Stage）**：
  - 无历史对话时，居中展示 `<BotAvatar type="clover" size={96} />` + 简短人格问候 + 居中 `BotComposer`（复用现有空首页视觉比例），可选附 2–3 条基于已打开项目的轻量示例短语，点选即填入输入框。

Bot 页面收到关闭标签快捷键时返回工作区，不关闭隐藏标签或改写其草稿。

### 6.4 底部输入区（`BotComposer`）

- 与工作区复用 `ComposerSurface` 和 `ComposerControls`：输入框的圆角、Glass / Solid 材质、正文留白、工具栏和边框光效保持一致。Bot 保留独立的草稿与发送语义，组字期 Enter 不发送。
- **做减法**：隐藏普通项目工作区才需要的分支切换、会话树按钮等干扰项。
- **保留与强化**：
  - Bot 主会话独立的模型 / 思考强度选择器（仅作用于 Bot 主会话，后台执行默认继承 Pig 全局默认模型并支持按任务覆写，见 [Bot 编排实施计划](bot-plan.md) §5.5）；
  - 低调的**权限模式切换器**（紧邻模型选择器，首次初始化默认 `full-access`，平时视觉收敛，需要时可随时临时切回 `default` 或 `read-only`；具体权限上限与审批矩阵见 [Bot 编排实施计划](bot-plan.md) §5.5）；
  - 键入 `@` 或点击工具栏 `@` 均在输入框上方打开同一个项目列表。键入时按项目名或路径过滤，选中后用项目标签替换当前 `@` 词；支持方向键、Enter、Tab、Escape，组字期间不选中、不发送。
  - 图片与文件附件；
  - **彻底消除“被吊起”感（落流即收 + 无锁输入）**：无论是后台跑着多个 worktree 任务，还是 Bot 主会话正在思考/派活，输入框永不锁死、**不展示 `QueuedMessageRow` 排队条与「按 Tab 插话」提示**；每次发送即刻落流为正式气泡并清空输入，底层由 Bot 调度器按「未落地思考抢占合并 / 已有副作用后自动 `steer` 衔接」无感消化（见 [Bot 编排实施计划](bot-plan.md) §5.3）；与工作区一致采用单槽位动作按钮——`streaming` 且无草稿时原地替换为停止按钮供用户打断当前思考轮，一旦输入草稿即切回发送按钮。

### 6.5 按需浮动任务抽屉（`BotTaskDrawer`）

因为主界面没有常驻侧栏，按需抽屉承担完整任务台账与精准控制：

- **开启方式**：点击顶栏 `BotTaskTriggerPill`、点击顶部活态任务条中的某张胶囊、或按快捷键。
- **视觉定位**：从左侧滑入的浮动圆角面板（`w-90 max-w-[calc(100%-1rem)]`，紧贴左侧 `left-2`，距顶栏和底边各留 `8px` 间距），不挤压中轴对话区；Glass 下沿用 `data-sidebar-overlay` 悬浮质感（不用 `backdrop-filter`），Solid 下用 `bg-popover shadow-xl border border-border`。点击外部或按 `Esc` 收起。
- **信息分组**：
  1. **需要处理**（`blocked_approval`）：置顶高亮，支持直接展开定位到对话里的审批卡或跳转现场。
  2. **进行中**（`running` / `starting` / `stopping`）：`starting` 态随 `<50ms` Fast Ack 即刻入账并显示「准备 worktree 中…」，运行后显示实时耗时、分支名、阶段状态；提供「查看现场」「停止」「停止并接管」。
  3. **最近记录**（`completed` / `stopped` / `taken_over` / `failed` / `interrupted`，最近 20 条）：显示最终状态、变更摘要与「打开会话」「查看变更」「继续 / 重试」。
- **交互细节**：
  - 点击「停止」立即进入 `stopping`（按钮禁用并显示「正在停止…」），不立即假装完成，等后端 `stopOrigin: 'user'` 真正停稳后自动落入「最近记录」并由 Bot 发回执消息；
  - 点击「停止并接管」按二次确认或明确主动作，停稳托管后自动收缩退出 Bot 页并切入该 worktree Session。

---

## 7. 工作区回连与托管标识

用户在普通项目工作区里也能清楚识别哪些 worktree / Session 是 Bot 开的，且操作反馈无缝回传到 Bot：

1. **左侧栏 Worktree 列表（`WorktreeRow`）**：
   - `owner.kind === 'bot'` 的 worktree 显示统一的 `bot/<slug>-<shortId>` 分支名和轻量 `Bot` 微标；
   - 运行中继续沿用现有运行状态点，一目了然。
2. **托管 Session 顶部细条（`BotManagedBanner`）**：
   - 当打开一个仍处于 Bot 托管运行中的 worktree Session 时，聊天视口顶部展示一行克制的提示条：`由 Bot 托管 · bot/<slug>-<shortId>`；
   - 右侧操作：**「返回 Bot」**（点击或点顶栏灵珠）、**「停止」**（停稳并回传 Bot）、**「停止并接管」**（解除 Bot 托管，立即把输入控制权交回用户）。
3. **手动停止闭环**：
   - 若用户直接点击该 Session 原有的停止按钮（`session:abort`），按钮与托管条立即进入「正在停止…」；待统一停止协调器确认进程与子 agent 全停稳，顶栏 `BotOrbButton` 弹出截断气泡，由 Bot 亲口汇报刚才停下的进度和留下的文件改动。

---

## 8. 快捷键、主题契约与验证清单

### 8.1 快捷键规划

| 动作 | 建议默认快捷键 | 说明 |
| --- | --- | --- |
| 进入 / 退出 Bot 页面 | `⌘⇧B`（Win/Linux `Ctrl+Shift+B`） | 以顶栏 `BotOrbButton` 为圆心触发扩散 / 收缩；接入现有快捷键设置体系可自定义 |
| 展开 / 收起任务抽屉（Bot 页内） | `⌘⇧T`（Win/Linux `Ctrl+Shift+T`） | 快速盘点后台任务 |
| 返回工作区（Bot 页内） | `Esc` | 仅当无弹窗、任务抽屉已关闭且输入框未处于编辑/组字态时触发 |

### 8.2 主题与无障碍契约

- **语义 Token 增量**：仅在 `src/renderer/src/themes/theme-pig.css`、`theme-everforest.css` 的 light / dark 四个 selector 及 `styles.css` 中注册少量 Bot 入口语义变量（`--bot-orb-glow`、`--bot-orb-ring`），其余状态色全部复用现有 `primary`、`warning`、`destructive`、`popover`、`chat-background`、`user-message-*`。
- **对比度**：所有文字、状态胶囊、按钮标签在 `pig` / `everforest` × `light` / `dark` × `glass` / `solid` 下均需验证 ≥ 4.5:1（非文字指示 ≥ 3:1）。
- **键盘与读屏**：`BotOrbButton` 暴露 `aria-expanded`、`aria-label`（动态包含进行中/待审批/未读计数）；`BotPeekBubble` 使用 `role="status"`（审批提醒使用 `role="alert"`）且不强抢当前编辑器焦点；任务抽屉支持 `Esc` 关闭与焦点回收。

### 8.3 组件与文件落点规划（对应阶段 5）

| 模块 | 规划位置 | 职责 |
| --- | --- | --- |
| 通用径向转场 | `src/renderer/src/lib/radial-reveal.ts`（由 `surface-transition.ts` 抽离复用） | `BotOrbButton` 圆心扩散 / 收缩 + `dropNonEditableSelection()` + 取消保护 |
| 顶栏入口与页面头像 | `src/renderer/src/components/bot/BotOrbButton.tsx`、`bot-avatars` | 顶栏复用 `BotAvatar`（`clover`，`size={22}`）+ 状态光晕与角标；Bot 页采用 `BotAvatar`（`clover`） |
| 非 Bot 页弹出气泡 | `src/renderer/src/components/bot/BotPeekBubble.tsx` | 锚定圆珠下方、2 行截断、防堆叠、原生浏览器遮挡注册 |
| 左侧栏模式切换轨 | `src/renderer/src/components/sidebar/SidebarModeSwitch.tsx` | 承接原顶栏「项目 / 对话」切换器，对齐顶部动作位 |
| Bot 全景页与任务视图 | `src/renderer/src/components/bot/BotPage.tsx`、`BotLiveTaskBar.tsx`、`BotTaskDrawer.tsx`、`BotTaskCard.tsx`、`BotComposer.tsx` | 无侧栏单中轴剧场、`send_message` 气泡投影、活态任务条与按需抽屉 |
| 工作区托管条 | `src/renderer/src/components/bot/BotManagedBanner.tsx` | 项目 Session 内的托管提示、停止与接管入口 |
| 状态管理 | `src/renderer/src/stores/bot.ts` | Bot 页开关、未读与气泡队列、任务快照、抽屉状态与跳转协调 |
| 文案 | `src/shared/i18n/zh.ts`、`src/shared/i18n/en.ts` | 同步补全中英文文案 |

### 8.4 人工与自动化验证重点

- **自动化单测**：`BotPeekBubble` 2 行截断与多消息合并计数、审批气泡不自动消失、进入/退出 Bot 页不卸载工作区与草稿保活、连续发送落流即收（绝不出现 `QueuedMessageRow`）、`starting` 态活态任务胶囊秒现与优先级排序/3 槽位折叠、`send_message` 投影过滤内部文本与隐藏 `<system_reminder>`、零发言兜底提示/系统交付卡展示、顶栏「新起一段」二次确认不中断运行中任务、`lastSurface` 冷启动恢复、`BotComposer` 默认 `full-access` 权限切换、reduced-motion 降级路径。
- **真实 Electron 人工核验**：Glass / Solid 与亮暗色板下的灵珠立体发光质感、圆心扩散与原生 `WebContentsView` 截帧交接无穿透、弹出气泡压过浏览器区域时平滑截帧恢复、Bot 思考/派活期间连发消息零吊起体感、高速滚动对话与连续切换模式无闪烁或卡态。
