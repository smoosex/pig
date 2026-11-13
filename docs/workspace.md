# 工作区、目录选择与快捷键

修改侧栏、设置布局、文件搜索、标签引用、分屏或工具标签恢复前阅读。

## 右侧文件与变更面板

- 右侧 `WorkspacePanel` 顶部是文件／变更图标切换，仅选中项展开文字，通过独立 layoutId 的胶囊和宽度动画平滑切换，尊重 reduced-motion；正文不横移。
- 工作树确实无变更时，列表区域居中显示圆形文件图标、「没有更改」及编辑来源说明；搜索无匹配、加载、非 Git 目录和读取失败仍各自展示，不能混作无变更。
- 变更底栏上方有内缩分隔线，左侧分组／全部使用同风格的平滑胶囊（两个文字项常显），右侧只保留树形视图开关。
- 两页共用 `WorkspaceFilter`，变更按路径筛选已有 Git 数据，文件页通过 `files:search` 搜索未展开目录（不读正文、不跟随符号链接），广度优先遍历最多 500 个目录／10000 项／200 个结果，搜索目录用有界迭代读取，隐藏项与非普通文件也计入扫描预算，不先读取整个目录再截断；迭代与 Git 忽略批次都检查取消，信号传到正在运行的 Git 进程。
- 达到限制明确提示不完整，IO 错误不当成空结果。
- 搜索 200ms 去抖，输入变化／离开时取消，主进程按窗口单飞，并在宿主跨文档导航／退出时取消；工作区通知和本地文件操作更新目录快照时，同一关键词也会重新搜索；新 IPC 只接受 UI 主 frame 且校验已注册 worktree。
- 文件页搜索右侧依次为隐藏 Git 忽略项、定位当前文件、全部收起；定位展开父目录并滚动到行，必要时解除忽略过滤，无当前文件时禁用；收起只清当前 cwd 的展开状态，不丢目录缓存或其他 worktree 状态。
- 搜索结果重命名时先展开并加载目标父目录链，清空搜索后仍能显示重命名输入框。

## 设置页与侧栏轨道

- 工作区与设置页共用 `WorkspaceLayout` 的左右轨道（各 248px、200ms 宽度过渡）。
- 进入设置时 main 立即换为设置正文，只通过左轨展开使 main 左边界往中间收、露出固定在左侧的设置菜单，如同普通 sidebar 展开；左栏已开时同宽直接换菜单。
- 正文和菜单都不做平移或淡入淡出，也不保留退出动画层或计时器。
- 右轨进入设置时通过宽度收起，退出时 main 立即回到工作区、左右轨按原偏好反向恢复，不修改偏好。
- 设置导航经 portal 放在同一个左轨，原侧栏隐藏但保持挂载以保留列表状态。
- 折叠侧栏的悬停触发边留在轨道裁剪之外，悬浮面板仍独立覆盖内容；尊重 reduced-motion。

## 应用内目录选择器

- 添加项目使用应用内目录浏览器，不再调用原生选目录窗口。
- `ProjectPickerDialog` 通过 `project:browse-directories` 浏览本机一层目录，支持路径、面包屑、隐藏项与 Git 标记；最多返回 500 个子目录并提示截断，不建立 Home 索引。
- 打开「搜索子文件夹」后，`project:search-directories` 从当前目录按层广度优先匹配名称：不跟随符号链接，不进入 Git 仓库和 `node_modules` 等依赖/构建目录，无权限子目录标为 Git 未知（`git: null` 加警告，与浏览一致）且不进入；Git 探测与 readdir 都按 32 个一批并计入 4 万次文件系统操作上限，达到 200 个结果、该上限或 8 层时停止并标记截断。
- 每个窗口最多一个搜索在跑：新请求或 `project:cancel-directory-search`（输入变化、关闭开关或对话框时由 renderer 发出）会中止上一个，遍历在每批之前检查 `AbortSignal`。
- renderer 只消费 main 返回的路径，不自行拼接平台路径；确认后 `session:open-project` 接收明确路径，main 再校验真实目录并沿用原来的项目注册逻辑。
- 浏览器本体是共用的 `PathPickerDialog`，导入本地 Skill 与安装本地插件也用它，应用内不再调用原生选择窗口；插件模式传 `includeFiles`，main 额外列出 `.ts/.js/.mjs/.cjs/.json` 文件（`kind: 'file'`，排在目录之后；文件满 500 后不再 stat 剩余文件），手输这类文件路径时返回其所在目录并以 `file` 预选，子文件夹搜索只找目录所以该模式下隐藏；选中只回填路径，不直接导入或安装。
- 打开状态归 sessions catalog，添加按钮与快捷键共享入口。

## 快捷键

- 快捷键唯一的定义表在 `src/shared/shortcuts.ts`：动作 ID、分组、默认值（可按平台区分，如终端在非 macOS 上避开 readline 的 Control+K/A）、匹配、冲突与保留键规则都在这里，main 与 renderer 共用。
- 绑定是规范字符串 `Mod+Shift+KeyE`，修饰键顺序固定，最后是 `KeyboardEvent.code`（按物理键匹配，不受 Shift、键盘布局和 IME 影响）；`Mod` 在 macOS 是 Command，其他平台是 Control。
- `settings.json` 的 `shortcuts` 只存用户改过的项（缺省走默认，`null` 为停用），读取时逐项丢弃非法值；`settings:set-shortcuts` 接收 patch（`'default'` 删除覆盖），在设置文件队列内整体校验后写入，「替换」把新键和停用原占用者放在同一个 patch 里。
- main 的 `src/main/shortcuts.ts` 缓存当前绑定给浏览器 guest 使用，启动与每次保存后更新。
- renderer 经 `lib/shortcuts.ts` 读取当前绑定，App（全局与标签页动作，含 ⌘T 新建会话、⌘1–8 / ⌘9 按标签条 `stripSlots` 的槽位切换，分屏组算一个槽位）、输入框、文件、终端和项目选择器都查表，提示文字用 `ShortcutKbd` / `shortcutText` 显示当前键位。
- 窗口级动作（全局、标签页与 `composer.focus`）必须带 Command/Control，并与所有分组互斥；其他分组只在组内互斥，不带修饰键时只允许 Tab 与 F 键（终端分组必须带 Command/Control，Tab 与 Alt 留给 shell）；恢复默认值同样检查冲突。
- 本平台按不出来的写法（macOS 的 `Meta`、其他平台的 `Ctrl`，事件里都会变成 `Mod`）保存时拒绝、读取时丢弃。
- 设置页录制期间由 `setShortcutRecording` 让所有监听让路。
- 发送键（Enter / Shift+Enter）仍是独立的 `sendShortcut`，只是在快捷键页显示。

## 浏览器、终端标签与分屏恢复

- 浏览器与终端的重启恢复：`open-project-sessions.json`（v5）的 `tools` 记录所有打开的浏览器／终端标签（id、kind、所属 worktree 或 `''` 表示 Chat 侧、浏览器的 `url` 与标注目标）。
- renderer 在 `workspaceRestoreReady` 后整体写入成员（`saveOpenToolTabs`，新标签追加到所在标签条末尾）；网址只有 main 知道，`BrowserHost` 的 `onCommit` 在主 frame 提交时经 `saveBrowserTabUrl` 合并进下一次写入，未登记的 id 忽略。
- worktree 的 `tabOrder` 与 Chat 侧的 `chatOrder` 都包含这些 id，切到或前台新建它们也写入 `activeTabId`／`activeChatTabId`。
- 网址保留 query 与 hash（页面要回到原处），其中可能带 token，因此该文件以 0600 写入。
- 读取时只保留导航本身允许的 HTTP(S) 网址；恢复时浏览器先 `browser:create(id, cwd, url)` 登记归属并把网址放进保留表，不建原生视图，首次显示才加载；终端标签首次显示才启动新 shell，运行中的命令不恢复。
- 标注、前进后退历史、DevTools、Agent 控制权与终端创建者记录都不恢复；目标会话没回来时清掉标注目标；所在 worktree 已删除的标签丢弃。
- 分屏可以有多组，每组在标签条上是一个合并标签，画面只显示活动标签所在的组；一个标签同时只属于一组，拖进别的组就从原组移走，任何组剩不到两个面板即解散（`split-layout` store 的 `groups`）。
- 在独立标签上分屏新建一组，不影响其他组。
- 分屏组（`splits` 数组，节点类型在 `src/shared/split-layout.ts`）也保存在同一文件：renderer 在恢复完成后、每次 `groups` 变化时整体写入，没有分屏写空数组；main 写入时严格校验（组间面板 id 与标签 id 都不能重复），读取时损坏的布局视为无分屏，旧版单个 `split` 读作唯一一组。
- 恢复在标记 `workspaceRestoreReady` 前进行，按关闭面板的方式移除标签没回来的面板（文件标签不持久化，所在面板总会被移除），剩不到两个面板的组丢弃；恢复期间用户已自行分屏则保留用户的。

## 输入框标签引用

- 输入框可以引用已打开的浏览器、终端与会话：`@` 菜单在文件候选前按「会话 / 浏览器 / 终端」分组列出（排除当前会话，类型词中英文都能搜），把这类标签从标签条拖到输入框也插入同样的引用（`tab-reference.ts` 经 `pig:tab-reference-drop` 事件交给 `Composer`，悬停输入框时清掉分屏预览，合并的分屏组不能拖）。
- 引用是原子 Tiptap 节点 `tabMention`（`TabMentionNode.tsx`，共用 `INLINE_CHIP_CLASS`），浏览器／终端标签自身没有名字，chip 显示「类型: ID 前 8 位」；发给模型的文本：浏览器／终端为 `@[完整 id]`（如 `@[browser:uuid]`，不重复类型前缀），会话为 `@[session:完整 id]`；旧版重复前缀的历史原文保留，工具说明明确其对应完整 ID。
- 浏览器候选及拖入校验只接受当前 worktree（Chat 为独立 scope）；Chat 首页草稿尚未进入 openTabs 时按 chatDraft.sessionId 明确识别为空 scope，不能把文件补全用的私有目录当成浏览器 scope。
- 会话与终端引用范围不变。
- 引用只标明对象，不附带内容、不代表授权操作，模型按需用各自的工具读取。
- 草稿按 JSON 保存节点；已发送消息不记录引用范围，历史里显示原文。
- bash 模式不能插入引用，含引用时拒绝执行。

## 相关入口

- 视觉规范见 [UI 规范](ui-conventions.md)。
- 浏览器和终端运行时分别见 [浏览器](browser.md)、[终端](terminal.md)。
- 注册／移除项目及普通会话控制见 [会话控制](session-control.md)。
