# Pig

Electron 桌面端，给 pi coding agent 做 GUI。包管理用 `bun`。

## 启动

```bash
bun install
env -u PIG_DIR bun run dev
```

`env -u PIG_DIR` 不是可选的。`PIG_DIR` 是 `pigDir()` 的最高优先级覆盖，而它的值会被父进程继承：从安装版 Pig（或它启动的 agent）里拉起的终端，环境里带着 `PIG_DIR=<安装版的目录>`，开发实例于是和日常用的那份共用 `settings.json`、`opened-projects.json`、`chats/` 等，两个实例互相覆盖。摘掉它，开发实例才会落到上一条分支，用本仓库的 `.pig/`；打包后仍然是 `$HOME/.pig`。

`electron-vite` 同时拉起 main / preload / renderer。改 main、preload 或 IPC 后要重启 Electron 才生效；只改 renderer 一般热更新即可。

```bash
bun run typecheck
bun run plugins:build   # 重新打包内置 pi-web-access 插件（dev / build 已自动调用）
bun run build:mac       # 或 build:win / build:linux
```

## 架构

main / preload / renderer 三层边界；preload 在 renderer 进程的隔离上下文中暴露白名单 API。
会话 pi SDK 跑在 main；分支命名例外，使用无工具、不保存会话的短生命周期 utility process：

```
renderer (React，沙箱)
   ↕  preload contextBridge（window.api）
main (Node，拥有 pi session)
```

```
src/
├── shared/         IPC 契约、跨进程数据结构
├── main/           窗口、IPC、pi session
│   ├── pi/         session 生命周期、模型设置、投影、事件桥、JSONL 读取
│   └── ipc/        invoke / push
├── preload/        白名单 API
└── renderer/src/
    ├── stores/     zustand（sessions 按 catalog / tabs / conversation 分 slice）
    ├── hooks/      React 生命周期绑定
    ├── ipc/        window.api 封装
    ├── chat/       事件路由、思考计时、turn 聚合
    ├── themes/     完整语义色板
    └── components/ 按 composer / turn / sidebar / settings 分组；shadcn 在 ui/
```

会话真相在 `~/.pi/agent/sessions/` 的 JSONL。UI 状态跟 Pi messages/turns，不要另做一套扁平 ChatMessage。

内置系统插件默认范围：观测记忆全部关闭，pi-review 与 pig-subagent 仅项目启用，pi-web-access 项目和 Chat 都启用；已保存的选择不受默认值变化影响。插件范围为 `project` / `chat`，可多选，空数组表示停用；旧版布尔配置迁移为仅项目。`enabledPluginPaths(scope)` 按会话类型过滤，并跳过缺失的内置文件，在设置页标出不可用。pi-web-access 是从上游 **v0.40.0** fork 到 `src/main/plugins/pi-web-access/` 的源码，删掉了 slash 命令、快捷键、curator 摘要流程、activity widget、pi-tui 渲染、`toolActivation`/`web_enable`、summary-review 与 MCP server；工具执行逻辑留在上游的 `web-tool-core.ts`，`index.ts` 只是注册工具和接会话状态的 Pi host。它依赖较多 npm 包，必须经 `plugins:build` 打成单文件后再加载，`@earendil-works/*` 与 `typebox` 交给 SDK 的 jiti alias。插件配置由 Pig 独占写入 `$PIG_DIR/web-search.json`（开发时 `cwd/.pig/web-search.json`），PIG_DIR 在 main 启动时发布给同进程的扩展。

**re-fork 时要重新打上的 Pig 补丁**（上游没有，覆盖文件后会丢）：

1. `utils.ts` — `getWebSearchConfigDir()` 优先读 `PIG_DIR`；proxy 作用域用 `Symbol.for("pi-web-access.proxy-storage")` 挂到 globalThis，跨模块实例共享（扩展 reload 后已安装的 fetch wrapper 才能看到新实例的 proxy）。
2. `ssrf-protection.ts` — 连接期 DNS 校验（`createValidatingLookup` + undici `Agent` dispatcher，绕开 preflight 的 TOCTOU），地址策略复用 `src/main/network-address.ts` 的 `isBlockedAddress`，删掉上游自己的 `isBlockedIPv4`/`isBlockedIPv6`。预检与传输使用相同的 proxy 决策；实际直连始终检查 DNS，不因 `trustEnvProxy` 跳过，也不能在 undici 加载失败时降级到无保护 fetch。配置端点的 localhost 豁免只允许 loopback 地址及同源跳转。
3. 配置路径延迟解析 — `web-tool-core.ts`、`ssrf-protection.ts`、`index.ts` 里的配置路径必须是函数（`webSearchConfigPath()`），不能是模块级常量：Bun 的测试跨文件共享模块注册表，且宿主可能在 import 之后才设 `PIG_DIR`。
4. `gemini-web.ts` / `utils.ts` — `typeof fetch` 与 undici 类型的 cast（`as unknown as typeof fetch`），Pig 的 tsconfig 比上游严格。
5. v0.40.0 缺陷修复 — `utils.ts` 的 proxy wrapper 用 `Request` 序列化 URL + FormData；`pdf-extract.ts` 显式选择 endpoint 时不吞错误，只有 auto 可降级；`endpoint-pdf-extract.ts` 的字符串任务结果必须是 JSON 对象并通过非空 Markdown 校验；OpenAI SSE 错误保留 `code`/`type`，路由不匹配描述文本，畸形 JSON 直接报错。对应回归在 `tests/pi-web-access-network.test.ts`（真实 Node 本地 socket）与 `tests/pi-web-access-search-errors.test.ts`。

会话能力面板的工具页按来源折叠分组：「内置」只含 Pi 自身工具（builtin 与 codemode / tool_search 等 inline），逐个开关；「Pig 插件」与「其他来源」每个插件只占一行、一个开关，名称取插件设置页的名字（`toolProvidersByPath`，未登记的扩展文件按文件名），分组身份使用插件注册 ID，未登记扩展使用完整路径，不能按显示名称合并同名插件。插件行由 main 的 `groupPluginTools` 聚合，所有工具都启用才算开；会话偏好仍按工具名逐个记录，子 agent 与 `applySessionTools` 不感知分组。

Skills 设置页分「已安装 / 发现」。个人 Pi 配置与 `~/.agents/skills` 自动发现的文件只读，启停仅写 Pig 的 `skills.json`，不修改共享目录。导入保存副本到 `$PIG_DIR/skills/<uuid>/<name>/`，仅这些副本允许移除，移除后留在 `skill-backups/`。GitHub 导入先按不可变 commit 探测 `SKILL.md` 再多选复制，不执行仓库代码，不走 Pi package 安装。`chat-resources.ts` 的两个 loader 都通过 `applySkillPreferences` 动态合并副本与过滤禁用项；Chat 仍排除项目 Skills，空闲会话自动重载，运行中的会话延后到任务结束。另外会扫描 `~/.claude/skills` 与 `~/.codex/skills`（遵循 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，跳过 `.system` 等隐藏目录），它们不是 Pi 的来源，所以默认关闭，启用状态记在 `skills.json` 的 `enabledPaths`，由 `applySkillPreferences` 按原路径直接加载（不复制，Chat 也生效）；这类 Skill 不占用安装时的同名检查。全局清单不依赖项目目录，也不解析或加载用户配置的 packages。

模型思考强度偏好复用 Pi `settings.json` 的 `modelThinkingLevels`（按 `provider/modelId`），不另存 Pig 配置。输入框强度菜单的「记住此模型的强度」开启时保存当前值，关闭时删除该偏好但不改变当前会话；仅已有偏好的模型会跟随后续手动选档更新。用户切换模型时，live / pending 统一按模型偏好 → 全局默认 → 当前会话强度选择，再用 SDK `clampThinkingLevel` 适配支持档位（如不支持 `xhigh` 时降为 `high`，不能直接降到最低档）；打开历史与 materialization 保留历史/显式会话选择。SDK session 的只读 settings 快照可能较旧，用户切换时以 main 的共享偏好解析结果为准。UI 操作成功后，同步同模型已打开会话的偏好标记，并递增 controls revision 阻止旧读取覆盖；不改其他会话当前强度。只在 UI 控制入口持久化，Review / 插件临时切换不得写模型偏好；保存前重载、保存后 flush 并检查 SDK 缓冲错误；失败时废弃 settings 实例，后续读取必须验证新实例成功加载，避免残留未落盘值或读取失败后的假成功。

Pi Review 的全局模型偏好复用通用插件配置，保存在 `$PIG_DIR/plugin-settings/pi-review.json` 的 `pi-review` 命名空间（`provider` / `modelId`，必须同时填写或清空；可选 `thinking` 独立配置思考强度）。配置 UI 复用默认模型的供应商／模型合并搜索下拉，不提供 ID 手填；模型与思考强度都可独立继承当前会话。每次 review 开始时读取并校验，默认继承当前会话模型；仅指定模型缺失、鉴权返回失败或切换返回失败时提示并回退，配置 JSON、校验及非 ENOENT 的 IO 错误必须抛出。Review turn 请求失败时恢复原会话模型并继续一次，不循环重试；最终答复或中止的 `turn_end` 即恢复原模型及思考强度（工具调用中间轮次不恢复），确保排队 follow-up 不借用 review 设置，`agent_end` 仅补充清理提前终止的情况。不覆盖用户中途手动选择的模型或思考强度，后续修复使用会话设置。

pig-subagent 注册 `spawn({ title, prompt, background })`，分两层：`src/main/plugins/pig-subagent/` 是 jiti 加载的扩展，只负责工具和用 `pi.sendMessage({ triggerTurn: true, deliverAs: 'steer' })` 投递后台结果（父会话空闲时开新一轮，运行中在本批工具结果后插入）；子会话由 main 的 `src/main/subagents/` 构造，两层经 `pig-subagent-host.ts` 挂在 globalThis 上的注册表连接（与 `pig-ui.ts` 同理，打包时两者都要进 `extraResources`）。子 agent 与父会话同进程，用 `createSessionRuntime` 复用父会话的资源加载，只有干净上下文，排除观测记忆与自身（不能递归），不绑定任何 UI，prompt 不做模板展开。子 agent 启动时快照继承父会话的工具与 MCP 开关，工具工厂拦截与 SDK 工具可见性都应用该快照，并强制禁用 `spawn`；Skills 仍按自身默认配置加载，运行中的子 agent 不跟随父会话后续开关变化。扩展的 `session_shutdown` 在资源重载时也会触发，所以只解除投递；中断子 agent 由 `disposeLiveSession` 负责（关闭标签、删除会话、退出时都标为 `interrupted`，不恢复）。用户点停止只会中止前台子 agent（它是父会话这一轮里的工具调用），后台的继续运行。头像从 Lucide 动物图标中随机分配，同一父会话大轮（`agent_start` 时最近的用户消息 entry id）内优先不重复；动物与主题 `chart-*` 颜色索引随子 agent 记录持久化，旧记录按 id 稳定回退。记录在 `$PIG_DIR/subagents/<父会话 id>/`（`index.json` 加各子会话 JSONL），配置在 `$PIG_DIR/subagent-settings.json`。新记录保存父会话 JSONL 路径，启动时清理父文件已不存在的子 agent 目录（缺少路径的旧记录保留）；清理结束前暂停加载索引及 spawn，避免和索引修复写入竞争。关闭父会话会等待最终索引落盘，删除目录不会被迟到的写入重建。

会话隔离用上游 0.38 的引用计数模型（`holdResults`/`releaseResults`/`loadSessionResults` + `touchClones`/`releaseClonesUnusedSince` + `liveInstances`），不要再做 per-instance storage：Pig 每个 tab 一个扩展实例共用一个进程，最后一个存活 session 结束前不能清 clone 目录。

Pig 自己的数据：开发时 `cwd/.pig`，打包后 `$HOME/.pig`，`PIG_DIR` 作为最高优先级覆盖（见「启动」：开发时不要带上它）。Worktree 在该目录下 `worktrees/<项目名>/<uuid>`，同名项目撞目录时才加路径哈希；重命名只改 Git 分支，不改目录。pi 登录态读 `~/.pi/agent/auth.json`。

添加项目使用应用内目录浏览器，不再调用原生选目录窗口。`ProjectPickerDialog` 通过 `project:browse-directories` 浏览本机一层目录，支持路径、面包屑、隐藏项与 Git 标记；最多返回 500 个子目录并提示截断，不建立 Home 索引。打开「搜索子文件夹」后，`project:search-directories` 从当前目录按层广度优先匹配名称：不跟随符号链接，不进入 Git 仓库和 `node_modules` 等依赖/构建目录，无权限子目录标为 Git 未知（`git: null` 加警告，与浏览一致）且不进入；Git 探测与 readdir 都按 32 个一批并计入 4 万次文件系统操作上限，达到 200 个结果、该上限或 8 层时停止并标记截断。每个窗口最多一个搜索在跑：新请求或 `project:cancel-directory-search`（输入变化、关闭开关或对话框时由 renderer 发出）会中止上一个，遍历在每批之前检查 `AbortSignal`。renderer 只消费 main 返回的路径，不自行拼接平台路径；确认后 `session:open-project` 接收明确路径，main 再校验真实目录并沿用原来的项目注册逻辑。`system:pick-directory` 仍供 Skills 等其他用途使用。打开状态归 sessions catalog，添加按钮与快捷键共享入口。

Open Computer Use 作为普通 stdio MCP 预置，不增加专用审批、宿主生命周期或 project/chat 限制。启动时 `initializeMcpDefaults()` 一次性写入 `npx -y open-computer-use@1.1.2 mcp`（默认停用、`deferred`）；`mcp.json` 的 `pigDefaults` 记录已初始化项，保留已有同名/同 namespace 配置，修改、启停和删除都走普通 MCP 流程且重启不恢复已删除项。首次启用需 Node.js/npx 与联网下载，macOS 权限授给 Open Computer Use，不授给 Pig；安装包不内嵌 OCU。MCP 直接调用会转发图片；codemode 脚本需显式 `image(block)`，仅 `text(result)` 不会把截图交给模型。

会话树选中节点后先确认「不总结 / 总结 / 自定义提示总结」。总结走 SDK `navigateTree`（summary 接在 Pi 自己选的叶子上，不再按轻量恢复重新 branch），不总结保留原轻量切换；两者都复用 `restoreSessionUserPrompt` 恢复图片与粘贴附件。main 用 `isNavigatingSessionBranch` 在准备会话前占位，prompt、bash、`/compact` 入口都会拒绝；renderer 的 `isNavigatingBranch` 覆盖请求到目标分支 hydrate 完成，期间输入框禁用、树对话框不可关闭并显示进度，总结可经 `abortBranchSummary` 停止，取消结果保留当前分支与草稿。

内置浏览器先只提供人工预览与元素标注，不注册 Agent 自动化工具。浏览器是与会话／文件同级的独立标签和分屏面板，顶部 `+` 可选择「会话 / 浏览器」，项目和 Chat 都可创建；右侧栏仍只有文件／变更。浏览器使用 `browser:<uuid>` 独立身份，不创建 Pi session/runtime，也不随目标会话关闭；当前不跨应用重启恢复。宿主 UI 主 frame 跨文档导航（含刷新）、renderer 退出及窗口关闭时，由 main 统一销毁该窗口的预览与 DevTools，清空地址、标注和归属登记；重载期间拒绝浏览器控制与创建，宿主 `dom-ready` 后允许重新创建，不依赖 React 卸载，子 frame／同文档导航及网页 guest 自身导航不触发清理。`src/shared/browser.ts` 是唯一 IPC 契约；`browser:create` 由 UI 注册所属窗口，后续控制请求只接受同一窗口的 UI 主 frame，页面 guest 不能创建或控制预览；不通过 Pi session 校验身份。页面启用 sandbox/contextIsolation、禁用 Node 和宿主 API，使用独立 `persist:pig-browser` partition；仅允许无凭据的 HTTP(S)，拒绝权限、下载及新窗口。每窗口最多保留 4 个原生预览，多个分屏可同时可见，隐藏项 LRU 淘汰；网址独立于原生视图保留，淘汰后切回按保留地址重新加载，网络加载不阻塞 bounds 队列，加载失败通过浏览器状态及 main 日志报告；关闭标签或窗口才清掉地址。`browser-guest.ts` 构建为独立 **`out/preload/browser-guest.cjs`**；两个 sandbox preload 都必须是独立单文件，不能因共享运行时 import 拆出公共 chunk（沙箱 `require` 不允许加载本地模块）；构建会拒绝非入口 chunk，preload 的 IPC 频道沿用字面量白名单；closed Shadow DOM 拾取仅支持主文档，不深入 iframe 或页面 Shadow DOM，不采集表单值。main 按页面 documentId 验证拾取事件，导航前先取消旧 documentId 的拾取；拾取后在元素旁的 guest 浮层填写可选评论，不占宿主顶部空间；添加后继续拾取并显示编号 pin，hover 只读查看，点击打开编辑框可更新（`browser:marker-update`，按 documentId 校验）或删除，标记同步不覆盖未保存的编辑，浮层用宿主计算后的语义主题值与 constructed stylesheet 适配 glass/solid 和严格 CSP，不用 backdrop-filter。标记由 main 的 `BrowserState.annotations` 持有，原生 LRU 淘汰不能清掉待发标记；每条保留 documentId 和页面快照，失效 DOM 的 pin 隐藏而不改绑到复用 selector 的新节点；最多 100 条、评论最多 4000 字。顶部显示数量、「放入输入框」按钮、目标下拉和清空：目标默认是打开浏览器时所在的会话，没有则不选；下拉里选会话只记录目标（存于浏览器标签的 `browserTargetSessionId`），点按钮才写入，未选目标时按钮改为弹出下拉；下拉的「当前聊天」子菜单在项目内只列浏览器所在 worktree 的已打开会话（Chat 首页的浏览器列出全部项目/Chat 会话）；「新建聊天」不展开，直接在所属 worktree 新建会话（无项目时新建 Chat）；`newChat()` 返回新建会话 ID，标记写入必须用该 ID，不能从创建结束时的 activeTabId 猜测。标记批次渲染为 Markdown（页面字段标为不可信、页面文本用比内容更长的 fence 包裹），作为名为「浏览器标注」的 pastedText 附件追加到目标会话草稿（保留已有 Tiptap 附件与图片），激活该标签由用户确认后发送，不自动发起 Pi 消息，也不能以 browserId 创建伪会话；写入草稿后只移除该批 IDs，期间新增的标记保留。截图仍单独加入关联会话的图片草稿，无目标时提示先打开会话。工具栏单行，有独立 glass 填充与上下留白，地址栏回车导航，元素选择和截图在刷新按钮右侧，地址栏右侧为复制 URL／外部浏览器打开／检查元素；复制与外部打开只使用 main 校验后的当前 HTTP(S) 页面 URL，检查元素切换该网页自己的 DevTools，经 `setDevToolsWebContents` 停靠在同一面板下方约 45% 的第二个原生视图里（以 `mode: 'bottom'` 打开，外部目标下 Electron 不移动视图，只让前端显示停靠工具栏及关闭按钮；`detach` 会隐藏关闭按钮）（页面至少保留 120 DIP，随面板隐藏/淘汰/关闭一起处理，DevTools 自带的关闭按钮也会收回；不检查 Pig UI）；网页和内嵌 DevTools 的 `Cmd+W` 由 main 的 `before-input-event` 阻止原生关闭窗口，通过 `BrowserApi.onCloseRequested` 通知对应面板调用现有 `closeTab(browserId)`，按住不重复关闭；视口不是独立容器（无背景、无圆角），空白时直接露出面板本身的颜色。renderer 串行同步 CSS bounds（main 按宿主 zoom 换算），隐藏面板、模态弹窗、实际遮挡网页的浮层及材质切换期间隐藏原生视图，不靠 z-index 或根 filter 覆盖它；因浮层隐藏前先经 `browser:snapshot` 截一帧 JPEG，解码并同步提交到视口、等待两帧后才隐藏原生视图；恢复原生视图后也保留占位到两帧交接结束（IPC 返回不代表原生页面已经上屏，实际合成效果仍需人工验证）。只检测实际浮层内容，不把 Radix 定位 wrapper 当遮挡，但继续监听其位置变化；目标状态变化即取消旧交接，过期截图不能再隐藏页面、过期恢复不能清掉占位。截帧或解码失败仍执行隐藏并报告错误，bounds 写入失败不缓存为已应用状态，下一次布局更新可重试。页面本身不强行 glass 化，工具栏复用语义玻璃材质。

Agent 浏览器能力由内置插件 pig-browser 提供（默认仅项目启用），工具与 MCP 一样以 `deferred` 暴露、归入 `browser` namespace（使用约定在 namespace instructions 与各工具描述里，不用 `promptGuidelines`），模型经 tool_search 按需加载，第一阶段只读：`browser_tabs` / `browser_open` / `browser_navigate` / `browser_history` / `browser_snapshot` / `browser_screenshot` / `browser_console` / `browser_annotations`，不提供点击输入与 `evaluate`。结构与 pig-subagent 相同：`src/main/plugins/pig-browser/` 只注册工具，经 `pig-browser-host.ts` 的 globalThis 注册表调用 main 的 `BrowserAgentController`（`src/main/browser/agent.ts`），两者都要进 `extraResources`。操作的就是用户可见的同一批浏览器标签：一个会话同时只控制本窗口一个标签，`browser_open` 不带 browserId 时由 main 发 `browser:agent-open-request`，renderer 在该会话所在 worktree（Chat 则 Chat 侧）后台新建标签并经 `browser:agent-open-answer` 回答，main 只接受该窗口自己 `browser:create` 过的 id；带 browserId 则接管，另一存活会话持有的标签拒绝，已关闭会话的控制自动失效。控制记在 `BrowserHost` 的 `agents`（随 LRU 淘汰保留），接管被淘汰标签时立即按保留网址重建加载，不依赖用户切到该标签；受控标签按会话存活豁免淘汰并关闭后台节流，隐藏页默认 1280×800 视口；隐藏页截图走 CDP `Page.captureScreenshot`（先请求 Chromium 产帧，绕过 `capturePage` 对未显示过页面的 surface 前置检查），不切换标签或显示原生视图；同一页面截图串行，已有 debugger 连接复用不主动断开，仅释放自己临时建立的连接，可见页仍走 `capturePage`；`BrowserState.agentSessionId` 驱动工具栏 Bot 按钮，点击释放控制。子 agent 不加载该插件（`subagentPluginPaths` 排除），没有窗口的会话调用直接报错。快照由 `agent-snapshot.ts` 的自包含函数经 `toString` 在独立 isolated world（1207）执行，输出带 ref 的无障碍大纲，ref 存在 isolated world 供第二阶段交互，密码值不输出，行内文本也逐层过滤隐藏节点和脚本；console 按文档缓存最近 200 条。实际快照求值与截图等待均响应工具取消，底层未完成的 Electron 操作仍接收迟到拒绝，但不阻塞已取消的工具调用。页面标题、文本、console 与标注页面字段都以不可信内容 fence 返回。导航最多等 30 秒后返回，之后的失败进浏览器状态与 main 日志。

浏览器工具栏的 Cookie 导入首版仅支持 macOS Chrome（Default / Profile N），Safari、其他浏览器、文件导入和非 macOS 解密暂不支持。来源 ID 由 main 检测生成，不接收任意文件路径；预览只读 SQLite 事务快照（含 WAL），不请求钥匙串，导入才通过 `/usr/bin/security` 获取 Chrome Safe Storage 密钥并校验 v24 域名哈希。Cookie 名称、值和密钥不进入 renderer、不写日志或 Pig 配置，解密密钥仅本次使用，源数据库不复制、不修改。当前站点按 PSL（含私有后缀）计算，支持明确确认后导入全部；过期、分区及不支持属性分别统计，保持 host-only / domain、path、SameSite、Secure、HttpOnly 与有效期语义。同键覆盖、一次复制，不做同步，所有浏览器标签共享 `persist:pig-browser` 登录态；清除本站需确认且不可撤销。导入重新读取来源，预览计数可能变化；读取/解密失败直接报错，单条 Chromium 写入或删除拒绝是显式部分结果边界（只返回失败计数，避免原生错误泄漏值），flush 失败仍抛出。跨标签写入和清除经 Promise 链排队串行；读取前后重新校验 UI 归属及站点，开始写入或删除后不再中断，必定 flush 并返回计数，避免留下未计数的部分写入。macOS Chrome 对 Cookies 库只持有 SQLite 共享锁（独占访问仅 Windows），读取带 5 秒 busy timeout，仍为 `SQLITE_BUSY`/`SQLITE_LOCKED` 时按 errcode 报“Chrome 正在写入”，其他 SQLite 错误保留 `cause`；成功变更后刷新页面，刷新失败与导入结果分开展示。Cookies 不涵盖 localStorage、设备绑定凭据等，不能保证复用所有站点登录。

## 进程与接口

| 位置                                 | 职责                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `src/shared/api.ts`                  | 跨进程 DTO 与 `SessionApi`，不依赖 Electron 或 React                    |
| `src/shared/session-images.ts`       | `pig-image` URL 的形状与解析；renderer 只把 url 当不透明字符串          |
| `src/preload/index.ts`               | IPC 白名单，用共享契约检查暴露的接口                                    |
| `src/main/ipc/`                      | 接收请求、解析窗口、调用业务模块、返回 DTO                              |
| `src/main/session-image-protocol.ts` | 注册 `pig-image` scheme 并按需返回图片字节                              |
| `src/main/app-url.ts`                | 窗口只允许停在自己的 UI 上（含重定向）                                  |
| `src/main/shell-env.ts`              | 启动时从用户登录 shell 导入 PATH 与缺失的环境变量（GUI 启动不继承终端环境） |
| `src/main/browser/`                  | 内嵌预览的视图生命周期、导航安全、截图与元素拾取事件 |
| `src/preload/browser-guest.ts`        | 网页隔离上下文中的元素拾取，不暴露 Pig API |
| `src/main/project-directory-browser.ts` | 应用内添加项目的本机目录浏览、真实路径校验与目录列表 |
| `src/main/open-project-sessions.ts`  | 持久化已打开会话、活动标签与标签顺序（Worktree 和 chats 两半）；与 session 生命周期分离 |
| `src/main/pi/session-jsonl.ts`       | 按行索引 JSONL，只解析要用的行；担保不了就报错让 SDK 接手               |
| `src/main/pi/session-source.ts`      | pending / live 会话统一的只读条目视图                                   |
| `src/main/pi/plugins.ts`             | 内置 / 第三方插件注册表、启用状态与打包路径                             |
| `src/main/pi/web-search-settings.ts` | 内置 pi-web-access 的配置读写（`$PIG_DIR/web-search.json`，权限 0600）  |
| `src/main/skills/`                  | 个人 Skills 清单、Pig 副本与启停偏好、本地 / GitHub 导入及 skills.sh 搜索 |
| `src/main/subagents/`               | 子 agent 的排队、上限、生命周期、结果投递与落盘；执行器接口与同进程 SDK 实现 |
| `scripts/build-system-plugins.ts`    | 用 esbuild 把 vendored 插件打成单文件到 `out/system-plugins/`           |
| `src/renderer/src/ipc/api.ts`        | renderer 的接口入口，复用共享类型                                       |
| `src/renderer/src/lib/highlight.ts`  | Shiki 高亮（WASM 引擎、按可见性触发、LRU 缓存）                         |

新增跨进程字段时先改共享契约，再改 main 的生产端和 renderer 的消费端。
不要在 preload 声明、renderer 或 main 各复制一份接口。

`patches/@shadcn%2Freact@0.3.1.patch` 为固定版本的组件补充显式暂停、偏移恢复、
状态读取及显式消息锚定。修改它时同步更新 `tests/message-scroller.test.ts`，
不要在业务组件外另建一套自动滚动状态机。

## 注释与验证

参考 [Pi AgentSession](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
和 [Agent](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)
的做法，模块开头交代职责，复杂逻辑说明生命周期、数据归属或时序约束。
能由函数名表达的动作不重复写成注释。

tsconfig 开了 `allowImportingTsExtensions`，因为 vendored 插件保留上游的 `.ts` 后缀 import。

```bash
bun run typecheck   # node、web、tests 三个 tsconfig 项目
bun test
bun run build
```

单元测试覆盖纯投影、并发时序及模拟 DOM 下的组件行为；不需要调用真实模型。
tests/ 由 `tsconfig.test.json` 单独检查（依赖从 `src/` 的真实类型推导），改跨进程
数据结构时 typecheck 会连同 fixtures 一起报错。

## 注意事项

- 能用 `components/ui` 里的 shadcn 组件就不要写原生标签：按钮、输入、选择、对话框等都走现成封装。图标用 `lucide-react`，不要手画 SVG。
- 主题：`src/renderer/src/themes/` 定义完整语义颜色；`styles.css` 只注册 Tailwind token，不绑定基础色板。切换靠 `html[data-palette]` + `.dark`，组件不要引用色板编号或写死颜色。
- glass 的磨砂来自网页下面的原生材质（macOS `vibrancy`、Windows `acrylic`）。glass 下不要依赖 `backdrop-filter`：窗口透明，网页内容大多半透明，Chromium 会把模糊结果叠在未模糊的原内容上而不是替换（[electron#19765](https://github.com/electron/electron/issues/19765)、[Chromium 380416865](https://issues.chromium.org/issues/380416865)），直接铺在窗口上时还会读回上一帧，出现半截变色。浮层、卡片、按钮的层次靠填充不透明度、边缘高光与投影表达；solid 下底色不透明，遮罩可用 `solid:` 前缀保留模糊。glass 弹窗的背景模糊改用 `filter`：Dialog / AlertDialog 打开时，`styles.css` 用 `:has()` 给应用根容器 `[data-modal-blur-root]` 加 `filter: blur(8px)`，它只栅格化元素自身，没有上述问题；弹窗 portal 到 `body` 保持清晰。标记不要复用 `data-app-surface`，设置页嵌套了一个，会重复模糊。
- Composer：IME 组字时 Enter 不能发送。工作耗时那一行不要 hover / `aria-expanded` 高亮。
- Tailwind 写在组件 `className` 里。能用间距刻度就不要任意值：`--spacing` 是 `0.25rem`，`Npx / 4` 即类名（`px-[18px]` → `px-4.5`）。百分比用分数（`max-w-1/2`）。只有刻度表达不了、或 keyframes / `::after` 才用 `*.module.css` 或 `[…]`。
- 中文引号字体是 LXGW WenKai Lite，其余 Geist Variable。
- 依赖分区按「谁能 external 加载」而不是「谁被 import」：只有 main / preload 运行时 `import` 的包（今天就是 `@earendil-works/pi-coding-agent` 和 `@electron-toolkit/utils`）留在 `dependencies`，renderer 用的全进 `devDependencies`。renderer 由 Vite 完整打包，不区分两者；`electron-builder` 只打 production deps，放错的代价是安装包暴涨。
- 不要擅自 `git commit`。

## Theme Palette Rules

### Structure

- Store palettes in `src/renderer/src/themes/theme-<name>.css` using the shared variable names. Use `html[data-palette='<name>']` for light colors and `html.dark[data-palette='<name>']` for dark colors.
- Each light/dark palette selector defines the same complete semantic color contract. `styles.css` registers these variables as Tailwind colors; it must not impose palette-to-role mappings.
- Components consume semantic tokens, never raw palette names such as `bg2`, `grey0`, or `green`. A theme may keep private base colors internally, but these are not a component API.
- Literal theme colors belong in palette selectors, not in components or generic `.dark` overrides.

### Backgrounds and Grays

- Use shadcn roles: `background`/`foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, their foreground pairs, `border`, `input`, `ring`, and `sidebar-*`.
- Pig-specific surfaces are `chat-background`, `composer-background`, and `user-message-background`/`user-message-foreground`. Keep them independently configurable rather than coupling messages to primary buttons.
- `input` follows shadcn usage: control borders and translucent fills. It is not the chat composer's background.
- There is no mandatory lightness ordering between page, sidebar, card, and chat surfaces. Each theme chooses its own hierarchy; distinguish adjacent surfaces without sacrificing readability.
- Menu hover and keyboard selection use `accent`, not `muted`, which shares the popover background color.

### Accents and Readability

- Keep `link`, `selection-background`/`selection-foreground`, `success`, `warning`, `info`, `destructive-background`, status background pairs, and `chart-1` through `chart-7` independent of primary actions.
- Code container colors are `code-background`, `code-foreground`, and `code-border`; syntax highlighting remains the responsibility of Shiki. `dot-base` controls decorative activity dots.
- Status and selection backgrounds should be subtle but distinguishable. Check normal text, including button labels, against its actual background for at least 4.5:1 contrast. Large text and necessary non-text UI indicators require at least 3:1.
- Decorative colors need not all meet text contrast requirements, but any color used for text must be checked against its actual background.
- Validate both light and dark modes with body text, descriptions, buttons, inputs, popovers, and selection highlights. A visually pleasing swatch alone is not sufficient.
