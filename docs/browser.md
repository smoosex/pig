# 内置浏览器与 Agent 浏览器工具

修改 BrowserHost、guest preload、DevTools、原生视图交接、浏览器工具、网络记录或 Cookie 前阅读。

## 身份、归属与导航边界

- 内置浏览器提供人工预览与元素标注，Agent 工具由独立的 pig-browser 插件提供。
- 浏览器是与会话／文件同级的独立标签和分屏面板，顶部 `+` 可选择「会话 / 浏览器」，项目和 Chat 都可创建；右侧栏仍只有文件／变更。
- 浏览器使用 `browser:<uuid>` 独立身份，不创建 Pi session/runtime，也不随目标会话关闭；跨重启恢复见 [工作区](workspace.md)。
- 宿主 UI 主 frame 跨文档导航（含刷新）、renderer 退出及窗口关闭时，由 main 统一销毁该窗口的预览与 DevTools，清空地址、标注和归属登记；重载期间拒绝浏览器控制与创建，宿主 `dom-ready` 后允许重新创建，不依赖 React 卸载，子 frame／同文档导航及网页 guest 自身导航不触发清理。
- `src/shared/browser.ts` 是唯一 IPC 契约；`browser:create(id, cwd, url?)` 由 UI 注册所属窗口及 worktree（Chat 为 `''`），同 ID 不可重绑 scope；后续控制请求只接受同一窗口的 UI 主 frame，页面 guest 不能创建或控制预览；不通过 Pi session 校验身份。
- 页面启用 sandbox/contextIsolation、禁用 Node 和宿主 API，使用独立 `persist:pig-browser` partition；仅允许无凭据的 HTTP(S)，拒绝权限、下载及新窗口；证书校验失败一律拒绝（Chromium 在这里没有警告页），主文档失败时在状态里记下 `certificate`（站点、错误、签发者、主体、有效期、指纹），面板在网页区域显示与 Chrome 类似的拦截页（隐藏原生视图，可返回或「仍要继续」），经 `browser:allow-certificate` 按指纹校验后把「host + 指纹」加入 main 内存里的放行集合并重新加载；放行所有标签共用、不落盘，换证书或换站点需重新确认，子资源从不弹确认，Agent 只在自己的导航错误里看到需用户放行的提示（不进共享的 navigate 错误，避免英文 Agent 文案出现在面板），没有工具可绕过。

## 原生视图与 guest 构建

- 每窗口最多保留 4 个原生预览，多个分屏可同时可见，隐藏项 LRU 淘汰；网址独立于原生视图保留，淘汰后切回按保留地址重新加载，网络加载不阻塞 bounds 队列，加载失败通过浏览器状态及 main 日志报告；关闭标签或窗口才清掉地址。
- `browser-guest.ts` 构建为独立 **`out/preload/browser-guest.cjs`**；两个 sandbox preload 都必须是独立单文件，不能因共享运行时 import 拆出公共 chunk（沙箱 `require` 不允许加载本地模块）；构建会拒绝非入口 chunk，preload 的 IPC 频道沿用字面量白名单；closed Shadow DOM 拾取仅支持主文档，不深入 iframe 或页面 Shadow DOM，不采集表单值。

## 元素标注

- main 按页面 documentId 验证拾取事件，导航前先取消旧 documentId 的拾取；拾取后在元素旁的 guest 浮层填写可选评论，不占宿主顶部空间；添加后继续拾取并显示编号 pin，hover 只读查看，点击打开编辑框可更新（`browser:marker-update`，按 documentId 校验）或删除，标记同步不覆盖未保存的编辑，浮层用宿主计算后的语义主题值与 constructed stylesheet 适配 glass/solid 和严格 CSP，不用 backdrop-filter。
- 标记由 main 的 `BrowserState.annotations` 持有，原生 LRU 淘汰不能清掉待发标记；每条保留 documentId 和页面快照，失效 DOM 的 pin 隐藏而不改绑到复用 selector 的新节点；最多 100 条、评论最多 4000 字。

## 截图、标注与草稿投递

- 工具栏截图按钮右侧常驻目标选择器（显示目标会话标题，截图与标注共用）；有标注时再显示数量、「放入输入框」按钮和清空：目标默认是打开浏览器时所在的会话，没有则不选；下拉里选会话只记录目标（存于浏览器标签的 `browserTargetSessionId`），点按钮才写入，未选目标时截图与放入按钮都改为弹出该下拉；下拉的「当前聊天」子菜单在项目内只列浏览器所在 worktree 的已打开会话（Chat 首页的浏览器列出全部项目/Chat 会话）；「新建聊天」不展开，直接在所属 worktree 新建会话（无项目时新建 Chat）并设为目标，再投递打开下拉的那个按钮要发送的内容（截图或标注；直接点选择器打开则只设目标）；截图必须在新建前完成，新会话激活后浏览器面板变为非活动，晚到的截图会被丢弃；`newChat()` 返回新建会话 ID，标记写入必须用该 ID，不能从创建结束时的 activeTabId 猜测。
- 标记批次渲染为 Markdown（页面字段标为不可信、页面文本用比内容更长的 fence 包裹），作为名为「浏览器标注」的 pastedText 附件追加到目标会话草稿（保留已有 Tiptap 附件与图片），激活该标签由用户确认后发送，不自动发起 Pi 消息，也不能以 browserId 创建伪会话；写入草稿后只移除该批 IDs，期间新增的标记保留。
- 截图单独加入目标会话的图片草稿。

## 工具栏与内嵌 DevTools

- 工具栏单行，有独立 glass 填充与上下留白，地址栏回车导航，元素选择和截图在刷新按钮右侧，地址栏右侧为复制 URL／外部浏览器打开／检查元素；复制与外部打开只使用 main 校验后的当前 HTTP(S) 页面 URL，检查元素切换该网页自己的 DevTools，经 `setDevToolsWebContents` 放在同一面板下方的第二个原生视图里，以 `mode: 'detach'` 打开（外部目标下 Electron 不移动视图；停靠模式会让前端在自身视图里为页面预留一块空白，且拖它的分隔线不改变页面高度），因此前端没有自带的关闭按钮，改由工具栏高亮的检查元素按钮关闭。

## DevTools 拖动

- 页面与 DevTools 之间不留缝也不画任何东西：原生视图盖住 DOM，renderer 没处放拖动条，所以 DevTools 顶部 10 DIP 与网页底部 5 DIP 共同组成透明拖动边：main 向 DevTools 前端注入 `row-resize` 光标条，网页 guest preload 在 DevTools 可见时临时放置同样的透明光标区域（该 5 DIP 被拖动占用，关闭 DevTools 或隐藏面板即移除；网页出现原生 `:modal` 时同步暂停网页侧命中，保留 DevTools 侧拖动，模态关闭后恢复；此节点及后代不享有拾取事件豁免）；两侧分别按各自的缩放换算 CSS 高度。
- main 经各自的 `before-mouse-event` 吞掉拖动鼠标，按页面或 DevTools 的坐标换算为同一边界并扣除按下偏移以避免跳动，再把位置（renderer CSS px）经 `browser:devtools-resize` 发给 renderer；Electron 的鼠标事件没有按键状态 modifiers（`button` 在普通 hover 时也是 `left`），以 mouseUp 结束拖动，隐藏、失效或跨文档导航主动取消，不依赖隐藏期间收到释放事件；网页光标区域在 `pagehide` 清理，不能在可取消的 `beforeunload` 提前移除。
- 高度比例归 renderer，经模块级订阅在所有已挂载面板间共用（以标记自身 style 上的 `--devtools-ratio` 传给样式，标记 style 变化即触发 bounds 重新测量；不能放在 viewport 上，hook 自己会写 viewport 的圆角样式），页面与 DevTools 各至少 120px，`data-devtools-divider` 是零高度的位置标记，`BrowserBounds.devtools.height` 交给 main 排布。
- DevTools 随面板隐藏/淘汰/关闭一起处理，不检查 Pig UI；网页和内嵌 DevTools 的 `Cmd+W` 由 main 的 `before-input-event` 阻止原生关闭窗口，通过 `BrowserApi.onCloseRequested` 通知对应面板调用现有 `closeTab(browserId)`，按住不重复关闭；视口不是独立卡片（无背景），空白时直接露出面板本身的颜色。

## 原生圆角裁剪

- 位于底部的那个原生视图（DevTools 打开时是 DevTools，否则是网页）通过原生 `View` 父容器裁剪外层面板的底部圆角，裁剪容器只包住它；它向上多出一个圆角半径的透明区域仍会绘制并吃掉点击，所以 DevTools 打开时把网页提到裁剪容器之上：renderer 按视口与 `data-content-surface` 的边界计算左右底角并随 bounds 传给 main，内部拆分边保持直角；main 按 zoom 换算，裁剪容器先用 `setBackgroundBlur(0)` 建立透明合成层（不启用模糊；普通 View 无 layer 时圆角不能裁剪子 layer），再设置圆角并向上延伸以保留网页顶部直角；分屏后底角不再贴合外层圆角（半径为 0）时必须拆掉裁剪容器、把网页放回窗口，零半径的裁剪容器在 Electron 44 下不绘制任何子视图，截图占位同步使用相同底角。
- 隐藏、淘汰与关闭一起处理裁剪容器，不能仅靠 DOM overflow 裁剪原生网页。

## 浮层遮挡与截图交接

- 分屏面板仅改变位置而尺寸不变时，仍通过所属 pane frame 的样式变化及动画结束／取消事件同步原生网页坐标；浏览器自身的容器动画期间持续测量，停止后提交最终位置，不依赖 ResizeObserver 或拖动预览消失来碰巧刷新，也不因其他面板移动而额外同步。面板容器本身不算遮挡浮层。
- renderer 串行同步 CSS bounds（main 按宿主 zoom 换算），隐藏面板、模态弹窗、实际遮挡网页的浮层及材质切换期间隐藏原生视图，不靠 z-index 或根 filter 覆盖它；因浮层隐藏前先经 `browser:snapshot` 分别捕获网页与可见 DevTools 的 JPEG（共享契约 `BrowserFrame`），两张图全部解码并按原分区同步提交到视口、等待两帧后才隐藏原生视图；恢复原生视图后也保留占位到两帧交接结束（IPC 返回不代表原生页面已经上屏，实际合成效果仍需人工验证）。
- 浮层遮挡使用 `BrowserBounds.occluded` 保留实际布局（`null` 仅表示无显示区域）；遮挡期间侧栏／分屏尺寸变化仍同步隐藏原生视图，再用 CDP 重截网页与 DevTools 占位，不得一直缩放旧截图；初次遮挡仍先截帧并完成绘制交接再隐藏。
- 只检测实际浮层内容，不把 Radix 定位 wrapper 当遮挡，但继续监听其位置变化；目标状态变化即取消旧交接，过期截图不能再隐藏页面、过期恢复不能清掉占位。
- 截帧或解码失败仍执行隐藏并报告错误，bounds 写入失败不缓存为已应用状态，下一次布局更新可重试。
- 页面本身不强行 glass 化，工具栏复用语义玻璃材质。

## 网页与 DevTools 的宿主快捷键

- 网页与内嵌 DevTools 聚焦时，main 的 `before-input-event` 仅拦截 `HOST_SHORTCUT_ACTIONS`（全局与标签页分组，按 main 缓存的当前绑定匹配，见 [工作区快捷键](workspace.md)）：`tab.close` 关闭所属浏览器标签，其余经 `BrowserApi.onShortcutRequested` 转发到 App，与宿主键盘入口共用动作；组字及按键重复不触发动作，复制粘贴等网页快捷键不拦截。
- preload 继续使用字面量频道，避免 sandbox 公共 chunk。
- macOS 应用菜单的原生 `close` role 由 `tab-close-menu.ts` 替换为无 accelerator 的关闭标签项：菜单回调不暴露 repeat 标志，因此 `Cmd+W` 只走已有的 renderer / guest 按键处理，避免原生加速键绕过重复按键保护或直接关窗；菜单点击经同一通道关闭活动标签。
- 只重建包含关闭项的分支并保留父级 role，其余 Services、Window 等原生子菜单保持原对象。
- 项目选择器打开时自行接收关闭请求并遵守保存中不可关闭的限制，App 不关闭后台标签。

## 插件、工具发现与宿主

- Agent 浏览器能力由内置插件 pig-browser 提供（默认仅项目启用），工具与 MCP 一样以 `deferred` 暴露、归入 `browser` namespace（使用约定在 namespace instructions 与各工具描述里，不用 `promptGuidelines`），模型经 tool_search 按需加载。
- 与 Pi 的 `mcp_servers` 相同，浏览器与终端插件各自在 `before_agent_start` 往 `pig_servers` 系统章节追加一行（`src/main/plugins/pig-servers.ts`，需随插件进 `extraResources`），仅当本会话还有非 hidden 的本组工具时才列出；章节每轮重建，开关变化只由 Pi 发章节补丁，不改写已缓存前缀，全部关闭时章节移除。
- 读取工具为 `browser_tabs` / `browser_open` / `browser_navigate` / `browser_history` / `browser_snapshot` / `browser_screenshot` / `browser_console` / `browser_annotations`；交互工具包括 `browser_click` / `browser_hover` / `browser_type` / `browser_press` / `browser_scroll` / `browser_select` / `browser_wait`，控制及网络工具包括 `browser_switch` / `browser_release` / `browser_close` / `browser_network` / `browser_upload`，仍不提供任意 `evaluate` 或任意网络请求工具。
- 结构与 pig-subagent 相同：`src/main/plugins/pig-browser/` 只注册工具，经 `pig-browser-host.ts` 的 globalThis 注册表调用 main 的 `BrowserAgentController`（`src/main/browser/agent.ts`），两者都要进 `extraResources`。

## 控制租约与后台页面

- 操作的就是用户可见的同一批浏览器标签：一个会话同时只控制本窗口、同 worktree（Chat 为独立 scope）的一个标签；Agent 列表、接管及创建应答均校验 scope，不能只在 renderer 隐藏其他分支。
- `browser_open` 不带 browserId 时由 main 发 `browser:agent-open-request`，renderer 在该会话所在 worktree（Chat 则 Chat 侧）后台新建标签并经 `browser:agent-open-answer` 回答，main 只接受该窗口自己 `browser:create` 过的 id；带 browserId 则接管，另一存活会话持有的标签拒绝，已关闭会话的控制自动失效。
- 控制记在 `BrowserHost` 的 `agents`（随 LRU 淘汰保留），接管被淘汰标签时立即按保留网址重建加载，不依赖用户切到该标签；受控标签按会话存活豁免淘汰并关闭后台节流，隐藏页默认 1280×800 视口；隐藏页截图走 CDP `Page.captureScreenshot`（先请求 Chromium 产帧，绕过 `capturePage` 对未显示过页面的 surface 前置检查），不切换标签或显示原生视图；同一页面的隐藏截图、交互与上传通过 `browser-debugger.ts` 共用串行队列，已有 debugger 连接复用不主动断开，仅释放自己临时建立的连接，可见页截图仍走 `capturePage`；

## 控制权释放的用户界面

- `BrowserState.agentSessionId` 驱动工具栏 Bot 按钮，点击先弹二次确认，说明直接释放可能打断操作且 Agent 仍可能重新接管；运行中提供「直接释放 / 停止 Agent 并释放」，后者先等待 `abort` 成功再释放，停止失败保留控制并显示错误；未运行时改为简短说明与「取消 / 释放控制」，不调用 `abort`，弹窗文案随所属会话运行状态更新。
- 确认期间锁定目标会话，main 按 expectedSessionId 校验，避免迟到确认释放其他会话的控制；不改变原有控制生命周期。
- 子 agent 不加载该插件（`subagentPluginPaths` 排除），没有窗口的会话调用直接报错。

## 快照、截图与工具取消

- 快照由 `agent-snapshot.ts` 的自包含函数经 `toString` 在独立 isolated world（1207）执行，输出带 ref 的无障碍大纲，ref 存在 isolated world 供交互，密码值不输出，行内文本也逐层过滤隐藏节点和脚本；console 按文档缓存最近 200 条。
- 实际快照求值与截图等待均响应工具取消，底层未完成的 Electron 操作仍接收迟到拒绝，但不阻塞已取消的工具调用。
- 页面标题、文本、console 与标注页面字段都以不可信内容 fence 返回。
- 导航最多等 30 秒后返回，之后的失败进浏览器状态与 main 日志。

## 页面交互与首次产帧

- 交互由 `agent-interaction.ts` 在同一 isolated world 解析 ref、滚动并检查可见性/遮挡/禁用，再通过 CDP 发鼠标和键盘事件，不切标签或请求原生焦点；每个文档首次交互在同一 CDP 队列内准备，不论视图可见性都先用 `captureHiddenFrame` 强制产帧（视图可见不代表宿主窗口未隐藏／最小化或已存在合成帧），成功且视口稳定后才标记就绪，失败不缓存，导航／原生页面重建重新准备；Agent 首次截图也先准备再绑定截图 ID，避免首次产帧的视口落定使截图自行失效。

## 滚动与坐标令牌

- `browser-motion.ts` 在滚轮发送前监听容器滚动与视口变化，并采样命中元素的祖先滚动偏移（含开放 Shadow DOM），发送后以 50ms 间隔等待至少 150ms 稳定，最多 3 秒，超时明确报错、不宣称滚动完成；等待继续校验取消、文档及控制租约，不承诺任意网页布局动画都已结束。
- click 支持 left/right/middle（默认 left），hover 只移动鼠标，均优先用快照 ref，无可用 ref 才用新截图返回的 screenshotId 与 CSS 视口坐标（不是图片像素）。
- 截图 ID 单次使用，导航、滚动、resize、控制权交接或任意工具交互使其失效；截图前后验证视口，交接与截图并发不得复活旧令牌；ID 不匹配与 ID 匹配但视口变化分别报告 stale screenshot 和 Screenshot viewport changed；绑定截图时递归监听当时存在的开放 Shadow Root 滚动，并保存内部元素滚动偏移以捕获尚未派发的 scroll，观察到变化后即使滚回原位也保持失效，换截图时解除旧监听，动态 DOM 变化不保证被识别。
- 坐标命中仍拒绝 iframe；坐标与 ref 点击统一拒绝文件输入及其关联 label／后代（含实际命中点），要求使用 browser_upload，原生浏览器/OS 菜单不支持。
- 快照补充可聚焦／显式 onclick 的非标准交互元素，并继续提取交互节点内独立控件，不假装能识别所有 React 委托事件。
- 宿主原生焦点转交／恢复仅在所属窗口前台时允许，失焦清除延迟聚焦请求，后台 guest focus 不触发面板激活。

## 输入、焦点与按键

- 输入默认替换文本，不回显输入值，支持文本类 input、textarea 和 contenteditable，原生 select 校验选项后派发 input/change。
- 按键仅支持常用按键及受限编辑组合，macOS Command 编辑组合在 keyDown 附带 Blink editing commands（keyUp 不重复），拒绝关闭窗口、地址栏等浏览器快捷键；沿开放 Shadow DOM 查找实际焦点并校验目标，拒绝深层 iframe 焦点，只操作主文档，不跨 iframe。
- 每个异步步骤校验文档与控制归属；取消及时结束工具等待，底层未完成操作仍持有队列直至结束，按下后的鼠标/按键必须释放，防止迟到输入影响下一调用。

## 等待与脚本错误

- `browser_wait` 无目标时等加载完成，有 ref 或 CSS selector 时轮询 visible/hidden/attached/detached（二选一，默认 visible，默认 10 秒、上限 30 秒），导航/转交控制/用户停止立即使等待失效；等待脚本是自包含序列化函数，选择器只作数据，不执行任意 JS。
- 交互、上传中的 DOM 校验、快照和等待统一经 `browser-script.ts` 执行：脚本异常在 isolated world 内转成结构化失败结果，main 验证后按原始消息重抛，避免 Electron 把异常泛化；Electron 自身的执行/生命周期拒绝原样传播，畸形结果直接报错，不做兜底。

## 切换、释放与关闭

- `browser_switch` 复用接管规则，默认不变更 UI，仅 `activate=true` 经原有 agent-open 请求/应答通道激活；请求类型在共享契约区分 open/activate/close，应答校验窗口、会话及确切 browserId。
- `browser_release` 保留页面，`browser_close` 只关当前受控标签，main 先销毁原生视图并移除归属，再让 renderer 从标签/分屏移除，防往返期间被另一会话接管；已关闭父会话不阻止授权过的 UI 关闭清理。

## 轻量网络日志

- `network-log.ts` 每个 Session 只安装一套 webRequest 监听，按 webContentsId 隔离日志与 pending，各最多 200 条；主文档跨文档导航清空，LRU 淘汰/关页/关窗释放。
- 仅保存 HTTP(S) 的方法、资源类型、状态、耗时、重定向与规范 net::ERR 错误码，URL 移除凭据/query/hash，不保存 headers/body/Cookie；未知错误仍保留 failed 标记但不回显原文。
- 工具最多返回 50 条不可信 fence 数据，URL 路径本身仍可能敏感，不承诺通用匿名化。

## 上传授权与精确 DOM 绑定

- 上传只接收用户任务授权的 1–20 个绝对路径，经 realpath/stat 验证普通文件；路径仅留在 main、审批卡和 CDP，不写入页面脚本或工具结果。
- 默认模式每次只提供「本次允许 / 拒绝」，卡片优先展示真实路径、请求路径及已知受保护路径警告，再展示网页地址（去掉 query/hash）、标题和输入 ref；网页地址超过 16384 字符时拒绝而不截断审批内容。
- 只读模式拒绝，完全访问不询问。
- 网页地址不保证实际上传目的地，敏感路径检查并不完整。
- 审批绑定当前控制、文档、原 ref 和文件真实路径/元数据；导航（含同文档）、转交控制、关闭、权限模式变化或取消中止等待，执行前再次校验，审批时不占 CDP 队列。
- 文件在最后检查后仍可能被替换，不能承诺文件内容的强隔离。
- `agent-upload.ts` 按原 ref 校验 input[type=file]、disabled、multiple 和禁止目录，支持隐藏输入及开放 Shadow DOM；快照只额外列出遗漏文件输入的元数据与 upload-only ref，不读取其他隐藏内容或文件值。
- 上传按 isolated world 算出的逐层元素子节点序号（含标签名，跨开放 shadow root 分段）用 CDP `DOM.describeNode` + `backendNodeId` 精确定位，不用 selector 匹配（shadow root 内 selector 会先命中更深的同形节点），发送前复查原 ref 连接和原位置，禁止绑定到替代节点；`browser_click` 拒绝点击文件输入框（会弹原生文件对话框），提示改用 `browser_upload`；不跨 iframe，不支持目录或原生文件对话框。
- 赋值后网页可能自动上传，已发送动作不能撤回，结果需快照/网络日志确认。

## 原生焦点保护

- 原生焦点保护由 `browser/focus-guard.ts` 按窗口维护：网页的 focus 监听在原生视图挂载前安装，隐藏网页不得激活面板或保留抢来的键盘焦点；Agent 的 navigate/history 在启动导航前登记后台保护（open 的加载沿用 navigate），可见的非聚焦分屏网页也受保护。
- 发生非用户焦点转移时同步恢复当前有效的原 WebContents（宿主、其他网页或 DevTools），不调用 DOM 输入框 focus、不激活窗口，也不发送错误的 `focused` 状态。
- 保护不随工具返回或导航完成自动解除，迟到焦点仍受限；恢复本身的 focus 事件不重新激活面板。
- 仅用户点击目标页、显式 focusPage 或成功的 `browser_switch(activate=true)` 解除对应目标页的保护；普通 Tab 不代表跨页面激活，bounds 从 null 恢复也可能只是菜单／弹窗遮挡结束，两者都不能解除保护；用户改用其他页面／DevTools 后，仍在加载的旧页只能返回当前键盘归属，不能恢复旧输入位置。
- 窗口 blur/hide/minimize 清空保护与归属，销毁 WebContents／窗口移除监听与引用，不在重新前台化后补做旧恢复。

## 按需网络正文捕获

- 按需网络正文捕获独立于轻量 `browser_network`：`browser_network_capture` 提供 start/stop/clear，`browser_network_requests` 列出最近 50 条匹配记录，`browser_network_detail` 按 ID 读取参数与响应。
- `network-capture.ts` 用 CDP Network 收集 HTTP(S)，支持 URL 子串与 CDP resourceTypes 过滤；start 重置记录、stop 保留记录、clear 不改运行状态，跨导航保留，控制权释放/转交/切换标签、关页/关窗及关闭父会话时停止并丢弃，不落盘。
- 关闭父会话经 `closeSessionBrowserControl` 清理，不依赖插件启用。
- 最多 200 条，每条请求和响应正文合计 64KiB；仅文本正文，二进制/base64、超限、失败/不可用有显式状态，不支持 WebSocket 帧。
- 超限按 CDP 的 `hasPostData` 无正文及 `dataReceived` 解码字节判断，不匹配错误文本。
- 过滤凭据头、URL 凭据、常见敏感 query 与 JSON/表单字段（任何文本正文能解析为 JSON 对象/数组即按 JSON 脱敏，覆盖 fetch 默认的 text/plain；JSON mime 解析失败为 unavailable）；这不是通用脱敏，路径、自由文本及自定义字段仍可能敏感，工具返回不可信 fence。
- `browser-debugger.ts` 的引用计数 lease 让长期捕获与截图/交互的临时 CDP 队列共享连接，不主动断开外部已连接的 debugger；异步结果按捕获代次与记录身份校验，旧 dispose 不得禁用新捕获。

## Chrome Cookie 导入

- 浏览器工具栏的 Cookie 导入仅支持 macOS Chrome（Default / Profile N），Safari、其他浏览器、文件导入和非 macOS 解密暂不支持。
- 来源 ID 由 main 检测生成，不接收任意文件路径；预览只读 SQLite 事务快照（含 WAL），不请求钥匙串，导入才通过 `/usr/bin/security` 获取 Chrome Safe Storage 密钥并校验 v24 域名哈希。
- Cookie 名称、值和密钥不进入 renderer、不写日志或 Pig 配置，解密密钥仅本次使用，源数据库不复制、不修改。
- 当前站点按 PSL（含私有后缀）计算，支持明确确认后导入全部；过期、分区及不支持属性分别统计，保持 host-only / domain、path、SameSite、Secure、HttpOnly 与有效期语义。
- 同键覆盖、一次复制，不做同步，所有浏览器标签共享 `persist:pig-browser` 登录态；清除本站需确认且不可撤销。
- 导入重新读取来源，预览计数可能变化；读取/解密失败直接报错，单条 Chromium 写入或删除拒绝是显式部分结果边界（只返回失败计数，避免原生错误泄漏值），flush 失败仍抛出。
- 跨标签写入和清除经 Promise 链排队串行；读取前后重新校验 UI 归属及站点，开始写入或删除后不再中断，必定 flush 并返回计数，避免留下未计数的部分写入。
- macOS Chrome 对 Cookies 库只持有 SQLite 共享锁（独占访问仅 Windows），读取带 5 秒 busy timeout，仍为 `SQLITE_BUSY`/`SQLITE_LOCKED` 时按 errcode 报“Chrome 正在写入”，其他 SQLite 错误保留 `cause`；成功变更后刷新页面，刷新失败与导入结果分开展示。
- Cookies 不涵盖 localStorage、设备绑定凭据等，不能保证复用所有站点登录。

## 浏览历史与地址栏补全

- 浏览历史全局共享（不分项目，与 Cookie 一致），由 main 的 `src/main/browser/history.ts` 独占：`BrowserHistory` 在内存中按完整 URL 去重（访问次数、地址栏输入次数、最近访问、标题），上限 2000 条，超出淘汰 frecency（访问 + 2×输入次数，7 天半衰期）最低者；变更 2 秒去抖后经串行队列原子写入 `$PIG_DIR/browser-history.json`（v1，0600，URL 保留 query 可能含 token），退出前 `flushBrowserHistory`（先等待已有首次加载，让此前挂起的修改完成，再清理定时器并排空写入）。
- 文件损坏或非 ENOENT 的 IO 错误直接抛出且永不覆盖；写入失败只记日志，下次变更整体重写。
- `BrowserHistoryRecorder` 通过 `BrowserHost` 的 `BrowserPageEvents` 接收主 frame 提交与标题：状态码不为正（错误页）不记，同文档导航仅 hash 变化不记，Agent 导航照常记录；地址栏回车或选择联想项走 `navigate(..., typed=true)`，令该次加载的下一个文档提交（含重定向后的最终 URL）计为 typed，加载结束即失效。
- renderer 只能经 `browser:history-query`（最多 20 条，按 URL 前缀 > 词首 > 子串分档、档内 frecency 排序）、`browser:history-list`（按最近访问倒序、URL 打破平局的游标分页，每页最多 100 条，各词须同时出现在 URL 或标题中）、`browser:history-remove` / `-clear` 与记录开关访问，仅 UI 主 frame 可调用，拿不到全量；任何变更（含开关）广播无数据的 `browser:history-changed`，由界面重读。
- 「记录浏览历史」开关存在同一文件的 `recording`（缺省 true），关闭只暂停新访问与标题更新、不删除已有记录；它不进 `SettingsService`，Agent 无法修改。
- 工具栏的历史按钮打开 `BrowserHistoryDialog`：按天分组（今天／昨天／本地化日期）、搜索、加载更多、逐条删除、清除全部（对话框内二次确认），点击条目在当前标签打开（不计 typed）并关闭对话框；打开期间收到变更会按已显示数量重读首页。
- 地址栏 `BrowserAddressInput` 用 Popover 显示联想（借现有浮层检测隐藏原生页面），不抢焦点，默认无选中项、Enter 打开输入原文；↑↓ 循环选择并回填，Esc 恢复输入原文，Shift+Delete/Backspace 删除选中项，输入法组字期间不处理。
- 行内补全（`inline-completion.ts`）只在光标位于末尾的 `insertText` 输入后触发（删除、粘贴、组字不触发），只补全 `typedCount ≥ 1` 的页面（Agent 或链接打开的不会冒出来），按去掉协议与 www.、根路径省略斜杠的显示形式前缀匹配，用户输入了协议时须一致；补全部分选中在光标后，继续输入相同字符就地保留，该页移到联想首位；Esc 同步使排队与在途查询失效，首个 Esc 只撤销补全，失焦撤销补全，回车在字段仍等于补全文本时经 `onPick` 打开该页的原始 URL（保留 http 与端口，计为 typed）。

## 网站图标与常用网站

- 网站图标按 origin 存在同一历史文件的 `icons`（`{source, data}`，data 为不超过 64K 的 PNG data URL，严格校验），写盘时删除已无页面的 origin，清空历史一并清掉；条目经 `icon` 字段带给界面，不单独存在条目里。
- `BrowserHost` 的 `page-favicon-updated` 经可选的 `BrowserPageEvents.icon` 交给 `BrowserHistoryRecorder`，它在记录中且页面已入库时取前三个 HTTP(S) 候选，已存图标来源在候选内则不抓；同 origin 单飞，期间收到新候选保留最新一组，旧下载返回后不采用过期结果并继续处理最新组；整组失败后本次运行内同一候选列表不再重试。
- 抓取在 `src/main/browser/favicon-network.ts`：独立 Node HTTP(S) 直连（不带 Cookie、不继承浏览器代理或证书例外、总计 10 秒超时、最多 256KB、最多 5 次重定向、禁用连接复用），IP 字面量预先校验，主机名通过 socket lookup 检查实际 DNS 结果，复用 `network-address.ts` 拒绝内网、loopback、link-local 等地址，每次重定向重新校验；内网站点图标不抓。
- `favicon-image.ts` 在任何原生解码前仅放行边长 ≤512 的 PNG/JPEG（PNG 拒绝动画及重复 IHDR），ICO 内嵌 PNG 同样检查真实尺寸，不信任 ICO 目录尺寸；未知格式用地球占位，不交给原生解码。
- `favicon.ts` 用 `nativeImage` 解码并缩到 32px 重新编码为 PNG，界面只见重编码位图；原生解码失败时 `ico.ts` 从 ICO 提取 PNG 帧，或把未压缩 24/32 位 DIB 转成 nativeImage 的 BGRA bitmap（含旧式 AND 透明掩码），限制目录、尺寸与偏移；其他格式不支持时仍无图标。
- 测试里 mock electron 的 IPC 测试须同时 mock 该模块。
- 空白标签（无 URL 且无证书拦截）显示 `BrowserTopSites`：`browser:history-top`（默认 8，最多 20）按去掉 www. 的 host 每站取 frecency 最高的一页，按站点最高分排序；点击在当前标签打开（不计 typed），收到 `browser:history-changed` 300ms 去抖后重读。
- 常用网站、历史条目和鼠标点击的地址栏联想导航后经 `browser:focus-page`（校验所属 UI 主 frame）请求网页键盘焦点；`BrowserHost.focusPage` 在原生页面下次有可见 bounds 时消费一次请求，避免起始按钮卸载或地址框 blur 后 Cmd+W 无接收者，Agent 导航不主动聚焦。

## 相关入口

- `browser:<uuid>` 标签、目标会话和分屏的重启恢复见 [工作区](workspace.md)。
- 评论输入使用宿主 [UI 输入表面](ui-conventions.md) 的计算颜色；`src/shared/browser.ts` 统一声明 `input`、`inputBorder`、`inputPlaceholder`，不能把未解析的 CSS 变量传入 guest。
- 权限模式和上传审批边界见 [权限](permissions.md)。
