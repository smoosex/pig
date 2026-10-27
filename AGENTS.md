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

内置系统插件默认范围：观测记忆全部关闭，pi-review 与 pig-subagent 仅项目启用，pi-web-access 与 pi-persona 项目和 Chat 都启用；已保存的选择不受默认值变化影响。插件范围为 `project` / `chat`，可多选，空数组表示停用；旧版布尔配置迁移为仅项目。`enabledPluginPaths(scope)` 按会话类型过滤，并跳过缺失的内置文件，在设置页标出不可用。pi-web-access 是从上游 **v0.40.0** fork 到 `src/main/plugins/pi-web-access/` 的源码，删掉了 slash 命令、快捷键、curator 摘要流程、activity widget、pi-tui 渲染、`toolActivation`/`web_enable`、summary-review 与 MCP server；工具执行逻辑留在上游的 `web-tool-core.ts`，`index.ts` 只是注册工具和接会话状态的 Pi host。它依赖较多 npm 包，必须经 `plugins:build` 打成单文件后再加载，`@earendil-works/*` 与 `typebox` 交给 SDK 的 jiti alias。插件配置由 Pig 独占写入 `$PIG_DIR/web-search.json`（开发时 `cwd/.pig/web-search.json`），PIG_DIR 在 main 启动时发布给同进程的扩展。

**re-fork 时要重新打上的 Pig 补丁**（上游没有，覆盖文件后会丢）：

1. `utils.ts` — `getWebSearchConfigDir()` 优先读 `PIG_DIR`；proxy 作用域用 `Symbol.for("pi-web-access.proxy-storage")` 挂到 globalThis，跨模块实例共享（扩展 reload 后已安装的 fetch wrapper 才能看到新实例的 proxy）。
2. `ssrf-protection.ts` — 连接期 DNS 校验（`createValidatingLookup` + undici `Agent` dispatcher，绕开 preflight 的 TOCTOU），地址策略复用 `src/main/network-address.ts` 的 `isBlockedAddress`，删掉上游自己的 `isBlockedIPv4`/`isBlockedIPv6`。预检与传输使用相同的 proxy 决策；实际直连始终检查 DNS，不因 `trustEnvProxy` 跳过，也不能在 undici 加载失败时降级到无保护 fetch。配置端点的 localhost 豁免只允许 loopback 地址及同源跳转。
3. 配置路径延迟解析 — `web-tool-core.ts`、`ssrf-protection.ts`、`index.ts` 里的配置路径必须是函数（`webSearchConfigPath()`），不能是模块级常量：Bun 的测试跨文件共享模块注册表，且宿主可能在 import 之后才设 `PIG_DIR`。
4. `gemini-web.ts` / `utils.ts` — `typeof fetch` 与 undici 类型的 cast（`as unknown as typeof fetch`），Pig 的 tsconfig 比上游严格。
5. v0.40.0 缺陷修复 — `utils.ts` 的 proxy wrapper 用 `Request` 序列化 URL + FormData；`pdf-extract.ts` 显式选择 endpoint 时不吞错误，只有 auto 可降级；`endpoint-pdf-extract.ts` 的字符串任务结果必须是 JSON 对象并通过非空 Markdown 校验；OpenAI SSE 错误保留 `code`/`type`，路由不匹配描述文本，畸形 JSON 直接报错。对应回归在 `tests/pi-web-access-network.test.ts`（真实 Node 本地 socket）与 `tests/pi-web-access-search-errors.test.ts`。

会话能力面板的工具页按来源折叠分组：「内置」只含 Pi 自身工具（builtin 与 codemode / tool_search 等 inline），逐个开关；「Pig 插件」与「其他来源」每个插件只占一行、一个开关，名称取插件设置页的名字（`toolProvidersByPath`，未登记的扩展文件按文件名），分组身份使用插件注册 ID，未登记扩展使用完整路径，不能按显示名称合并同名插件。插件行由 main 的 `groupPluginTools` 聚合，所有工具都启用才算开；会话偏好仍按工具名逐个记录，子 agent 与 `applySessionTools` 不感知分组。

Skills 设置页分「已安装 / 发现」。个人 Pi 配置与 `~/.agents/skills` 自动发现的文件只读，启停仅写 Pig 的 `skills.json`，不修改共享目录。导入保存副本到 `$PIG_DIR/skills/<uuid>/<name>/`，仅这些副本允许移除，移除后留在 `skill-backups/`。GitHub 导入先按不可变 commit 探测 `SKILL.md` 再多选复制，不执行仓库代码，不走 Pi package 安装。`chat-resources.ts` 的两个 loader 都通过 `applySkillPreferences` 动态合并副本与过滤禁用项；Chat 仍排除项目 Skills，空闲会话自动重载，运行中的会话延后到任务结束。另外会扫描 `~/.claude/skills` 与 `~/.codex/skills`（遵循 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，跳过 `.system` 等隐藏目录），它们不是 Pi 的来源，所以默认关闭，启用状态记在 `skills.json` 的 `enabledPaths`，由 `applySkillPreferences` 按原路径直接加载（不复制，Chat 也生效）；这类 Skill 不占用安装时的同名检查。全局清单不依赖项目目录，也不解析或加载用户配置的 packages。

模型思考强度偏好复用 Pi `settings.json` 的 `modelThinkingLevels`（按 `provider/modelId`），不另存 Pig 配置。输入框强度菜单的「记住此模型的强度」开启时保存当前值，关闭时删除该偏好但不改变当前会话；仅已有偏好的模型会跟随后续手动选档更新。用户切换模型时，live / pending 统一按模型偏好 → 全局默认 → 当前会话强度选择，再用 SDK `clampThinkingLevel` 适配支持档位（如不支持 `xhigh` 时降为 `high`，不能直接降到最低档）；打开历史与 materialization 保留历史/显式会话选择。SDK session 的只读 settings 快照可能较旧，用户切换时以 main 的共享偏好解析结果为准。UI 操作成功后，同步同模型已打开会话的偏好标记，并递增 controls revision 阻止旧读取覆盖；不改其他会话当前强度。只在 UI 控制入口持久化，Review / 插件临时切换不得写模型偏好；保存前重载、保存后 flush 并检查 SDK 缓冲错误；失败时废弃 settings 实例，后续读取必须验证新实例成功加载，避免残留未落盘值或读取失败后的假成功。

Pi Review 的全局模型偏好复用通用插件配置，保存在 `$PIG_DIR/plugin-settings/pi-review.json` 的 `pi-review` 命名空间（`provider` / `modelId`，必须同时填写或清空；可选 `thinking` 配置该模型的思考强度）。配置 UI 使用设置页统一的 `ModelThinkingPicker`（上方供应商／模型合并搜索，底部固定按所选模型过滤的思考强度栏，不提供 ID 手填）；「默认」按钮表示模型与思考强度都继承当前会话，选中后锁定列表。除输入框外，设置里所有选模型的地方（默认模型、Pi Review、观测记忆主/备用模型、子 agent）都用这一个组件，档位来自 `SessionModelInfo.thinkingLevels`，插件保留模型支持的 off/minimal，通用默认模型仍使用原有的可见档位过滤。Review 与子 agent 的旧数据若只有思考强度而没有模型，运行时忽略该强度、统一继承会话，子 agent 设置保存时同时清除该旧值。每次 review 开始时读取并校验，默认继承当前会话模型；仅指定模型缺失、鉴权返回失败或切换返回失败时提示并回退，配置 JSON、校验及非 ENOENT 的 IO 错误必须抛出。Review turn 请求失败时恢复原会话模型并继续一次，不循环重试；最终答复或中止的 `turn_end` 即恢复原模型及思考强度（工具调用中间轮次不恢复），确保排队 follow-up 不借用 review 设置，`agent_end` 仅补充清理提前终止的情况。不覆盖用户中途手动选择的模型或思考强度，后续修复使用会话设置。

pi-persona 从 `@smoose/pi-persona@0.1.5` 迁入 `src/main/plugins/pi-persona/`，仅保留人格注入与情绪模型，没有 slash、TUI、通知或模型工具。全应用只有一个人格和一份全局表达状态，子 agent 排除该插件；状态为愉快度（-1–1）、激活度（0–1）、精力（0–1）及仅展示的当前感受，不再使用八情绪轮盘或关键词／工具成败推力。各会话独立维护后台观察窗口。文件为 `$PIG_DIR/persona/{SOUL.md,IDENTIFY.md,USER.md,mood-state.json}`（目录 0700、文件 0600），路径延迟解析，仅使用 Pig 自己的文件，不读写 CLI 文件，也不提供本机 Pi 导入入口。IDENTIFY 的 YAML 配置名称、emoji；旧 0–1 性格参数与 description 保留校验但不驱动新心情模型，稳定性格由 SOUL 描述；USER 为用户自愿维护的上下文。系统提示开头一律替换为 `preamble` 章节（`preamble` 是唯一不包 XML 标签的章节，依赖 `patches/@earendil-works%2Fpi-coding-agent@1.4.0.patch` 放开该章节名，升级 SDK 时须重打，`tests/sdk-preamble-patch.test.ts` 守护；tools/rules/docs 照常生成），文本在 `src/main/plugins/pi-persona/preamble.ts`，措辞照搬 Alma：人格插件启用且 SOUL 非空时由插件写入（设了 customPrompt 时不写）「YOU ARE A REAL PERSON」身份段（名字取 IDENTIFY `name`，坚持人设、不自称 AI，调侃／试探／角色扮演一律按玩笑接，只有对方明确认真想确认时才用自己的口吻简短承认、随即回到人设，也不因人设编造感知或工具结果） + LANGUAGE RULE（用户或项目明确指定回复语言时以其为准） + CORE BEHAVIOR、DATE AWARENESS、带 SOUL.md 绝对路径的 SOUL、PERSONALITY EVOLUTION（Agent 自行编辑 SOUL.md 末尾的 `## Evolved Traits`，没有专用工具；这是唯一不加锁、非原子的写入，并发读最多让一轮拿到不完整的 SOUL）、USER PROFILE 和心情快照说明；否则（SOUL 为空或本会话关闭了插件）由 `src/main/pi/pig-identity.ts` 内置扩展写入默认身份（名字取 IDENTIFY `name`，缺省 Susan，主人取系统用户名，平台取 macOS/Windows/Linux），后面同样接 DATE AWARENESS 和存在时的 USER PROFILE。默认身份删去了 Alma 的自拍、群聊、记忆与「隐藏技术细节」，并改为：被认真问到时不否认是 AI、技术交付可分条、大改动先解释再等批准。内置扩展只在 preamble 尚未写入时生效，与扩展顺序无关；设了 customPrompt 时不写；子 agent 不加载（`createSessionRuntime` 的 `identity: false`）。日期每轮按本机时区生成，跨天只产生一次章节补丁。所有读改写经磁盘锁串行，只读（设置页读取、人格未启用、无情绪事件）不加锁也不写盘，心情状态仅在确有变化时写入；无主锁目录与 recovery 目录超过 30 秒自动回收。每次从最新状态重建引擎，main 与各 jiti 实例不能持有各自的心情真相；关闭自动变化冻结情绪与精力，手动设置仍生效。愉快度／激活度按约 60 分钟半衰期回归 0.15／0.35，观察员输出每维 −2…2 的整数相对步长，每步 0.12，结果钳制在取值范围内；精力工作四小时减 0.5、空闲两小时恢复 0.5，重叠任务只计一次，不自动睡眠。活动租约结束／重载释放，长任务定期续租，过期及旧宿主 PID 不再计工作。固定人格与 USER 上下文写入 `preamble` 系统章节（`systemPromptOptions.sections`），不返回 `systemPrompt`：强制提示词不进会话记录（导出看不到），且会把所有章节补丁折叠成每次改写的开头；动态心情作为 `persona-mood` 隐藏 custom message 追加到本轮消息末尾，不改写历史或系统前缀；快照只有一行程序生成的相对人格风格提示（每维 5 档，如 `[Expressive tone, relative to your personality: slightly warmer, steady, rested]`），不含数值、时间戳或观察员生成的任意感受文本；“由 Pig 插入、非用户所写”、只认最新一条、不宣告心情等固定规则放在 preamble，不在快照里重复。快照以 user 角色进入上下文，不改为 assistant：伪造的助手消息会被模型当作自己说过的话，部分 API 不接受，也和推理签名不连续。情绪只影响措辞，绝不改变准确性、执行、工具、验证、权限与安全；用户要求和稳定人格优先。每次任务开始通过 SDK `buildSessionProjection()` 检查当前分支有效上下文中的最新快照，仅内容变化或快照已被压缩／上下文编辑移除时补发；重载与分支切换不能依赖内存里的已发送标记，也不产生会话级心情。`session_compact` 的溢出重试或已有排队续跑不会再触发任务开始，需用 steer 补齐丢失的快照；普通压缩不排新消息、不额外启动模型轮次，等下次任务开始补齐。JSON/YAML/IO 错误必须抛出，不能重置默认值或降级成本地更新；只允许 YAML frontmatter，禁止 gray-matter 的可执行引擎。设置页通过固定文件名与 SHA-256 revision 保存，冲突不覆盖；文件逐个原子替换。`src/shared/persona.ts` 是唯一配置 IPC 契约，仅所属 UI 主 frame 可调用；文件保存沿用插件重载，运行中等空闲再应用。插件连同 gray-matter 经 `plugins:build` 打成单文件，`out/system-plugins/pi-persona/` 要进 `extraResources`；main 的配置服务运行时加载 gray-matter，因此它在 production dependencies。

情绪观察员在 `pi-persona/observer.ts`，是无工具、单次请求的后台 worker，通过宿主 modelRegistry 认证与 composed streamSimple 调用；默认继承会话模型但不传 reasoning（不继承会话思考强度；常见 API 下即关闭思考），可在设置选择独立模型与其支持的思考强度（含 off/minimal）及停用；只有自选模型的显式强度经 SDK clampThinkingLevel 适配后传入，恢复默认同时清除模型与强度。SOUL 正文截前 1500 字附在 system 末尾，让观察员按该人格判断反应，内容不变时仍在缓存前缀内。请求实际传入 reasoning，off 时省略；启用思考时为推理输出预留额外预算，不把思考过程作为观察输入。`conversation.ts` 只提取投影中的用户消息和无工具调用的最终回复，附件按元数据省略、代码块与行内代码换成占位符、引用过滤、长文裁剪头尾，原文不变；被中止或失败的轮次保留用户消息并以标记代替回复，绝不配给之后的回复。累计三轮或尾批等待 60 秒触发，两次至少间隔 60 秒，同会话单飞；失败批跳过、30 秒超时，不回退关键词、不启动主 Agent。缓存使用固定 system 和逐条追加的裁剪对话，动态分析范围放末尾；每批最多六个新轮次，窗口按 8K 或模型上下文 25% 的较小值以 UTF-8 字节保守预算并预留输出，换窗留两轮背景。重载／分支切换不重放已有完成轮次，关闭时取消；main 与 jiti 通过 `controls.ts` 的 globalThis 通知立即取消手动设置／开关变化前的观察，控制 revision 再防迟到结果覆盖。`mood-state.json` v3 从严格校验的 v2 映射，仅读取不写迁移，下一次显式变更原子保存。

pig-subagent 注册 `spawn({ title, prompt, background })`，分两层：`src/main/plugins/pig-subagent/` 是 jiti 加载的扩展，只负责工具和用 `pi.sendMessage({ triggerTurn: true, deliverAs: 'steer' })` 投递后台结果（父会话空闲时开新一轮，运行中在本批工具结果后插入）；子会话由 main 的 `src/main/subagents/` 构造，两层经 `pig-subagent-host.ts` 挂在 globalThis 上的注册表连接（与 `pig-ui.ts` 同理，打包时两者都要进 `extraResources`）。子 agent 与父会话同进程，用 `createSessionRuntime` 复用父会话的资源加载，只有干净上下文，排除观测记忆与自身（不能递归），不绑定任何 UI，prompt 不做模板展开。子 agent 启动时快照继承父会话的工具与 MCP 开关，工具工厂拦截与 SDK 工具可见性都应用该快照，并强制禁用 `spawn`；Skills 仍按自身默认配置加载，运行中的子 agent 不跟随父会话后续开关变化。扩展的 `session_shutdown` 在资源重载时也会触发，所以只解除投递；中断子 agent 由 `disposeLiveSession` 负责（关闭标签、删除会话、退出时都标为 `interrupted`，不恢复）。用户点停止只会中止前台子 agent（它是父会话这一轮里的工具调用），后台的继续运行。头像从 Lucide 动物图标中随机分配，同一父会话大轮（`agent_start` 时最近的用户消息 entry id）内优先不重复；动物与主题 `chart-*` 颜色索引随子 agent 记录持久化，旧记录按 id 稳定回退。记录在 `$PIG_DIR/subagents/<父会话 id>/`（`index.json` 加各子会话 JSONL），配置在 `$PIG_DIR/subagent-settings.json`。新记录保存父会话 JSONL 路径，启动时清理父文件已不存在的子 agent 目录（缺少路径的旧记录保留）；清理结束前暂停加载索引及 spawn，避免和索引修复写入竞争。关闭父会话会等待最终索引落盘，删除目录不会被迟到的写入重建。

会话隔离用上游 0.38 的引用计数模型（`holdResults`/`releaseResults`/`loadSessionResults` + `touchClones`/`releaseClonesUnusedSince` + `liveInstances`），不要再做 per-instance storage：Pig 每个 tab 一个扩展实例共用一个进程，最后一个存活 session 结束前不能清 clone 目录。

Pig 自己的数据：开发时 `cwd/.pig`，打包后 `$HOME/.pig`，`PIG_DIR` 作为最高优先级覆盖（见「启动」：开发时不要带上它）。Worktree 在该目录下 `worktrees/<项目名>/<uuid>`，同名项目撞目录时才加路径哈希；重命名只改 Git 分支，不改目录。pi 登录态读 `~/.pi/agent/auth.json`。所有会话（含 Chat 与子 agent）经 `createSessionRuntime` 加载 `src/main/pi/pig-docs.ts`（辅助 loader 不带），用同名自定义章节原位替换 SDK 的 `docs`：先说明本实例实际的 Pig 数据目录、与 pi CLI 共用的文件（auth、sessions、skills、settings.json 的默认模型／思考强度／`modelThinkingLevels`／`enabledModels`）及被忽略的 pi packages/extensions，安装版再提示 asar 内文档只能用 read 工具读，后面接 SDK 原文；路径不变时文本不变，不产生补丁。SDK 的默认 docs 文本从 `event.systemPrompt` 截取，缺失（且未设 customPrompt）时直接报错；新增 Pig 自有数据文件或共用文件时同步更新该说明。

添加项目使用应用内目录浏览器，不再调用原生选目录窗口。`ProjectPickerDialog` 通过 `project:browse-directories` 浏览本机一层目录，支持路径、面包屑、隐藏项与 Git 标记；最多返回 500 个子目录并提示截断，不建立 Home 索引。打开「搜索子文件夹」后，`project:search-directories` 从当前目录按层广度优先匹配名称：不跟随符号链接，不进入 Git 仓库和 `node_modules` 等依赖/构建目录，无权限子目录标为 Git 未知（`git: null` 加警告，与浏览一致）且不进入；Git 探测与 readdir 都按 32 个一批并计入 4 万次文件系统操作上限，达到 200 个结果、该上限或 8 层时停止并标记截断。每个窗口最多一个搜索在跑：新请求或 `project:cancel-directory-search`（输入变化、关闭开关或对话框时由 renderer 发出）会中止上一个，遍历在每批之前检查 `AbortSignal`。renderer 只消费 main 返回的路径，不自行拼接平台路径；确认后 `session:open-project` 接收明确路径，main 再校验真实目录并沿用原来的项目注册逻辑。`system:pick-directory` 仍供 Skills 等其他用途使用。打开状态归 sessions catalog，添加按钮与快捷键共享入口。

Open Computer Use 作为普通 stdio MCP 预置，不增加专用审批、宿主生命周期或 project/chat 限制。启动时 `initializeMcpDefaults()` 一次性写入 `npx -y open-computer-use@1.1.2 mcp`（默认停用、`deferred`）；`mcp.json` 的 `pigDefaults` 记录已初始化项，保留已有同名/同 namespace 配置，修改、启停和删除都走普通 MCP 流程且重启不恢复已删除项。首次启用需 Node.js/npx 与联网下载，macOS 权限授给 Open Computer Use，不授给 Pig；安装包不内嵌 OCU。MCP 直接调用会转发图片；codemode 脚本需显式 `image(block)`，仅 `text(result)` 不会把截图交给模型。

会话树左键点击节点直接跳转（不总结），右键菜单提供「直接跳转 / 总结并跳转 / 自定义提示词总结」，只有自定义提示词会弹出输入框。总结走 SDK `navigateTree`（summary 接在 Pi 自己选的叶子上，不再按轻量恢复重新 branch），不总结保留原轻量切换；两者都复用 `restoreSessionUserPrompt` 恢复图片与粘贴附件。main 用 `isNavigatingSessionBranch` 在准备会话前占位，prompt、bash、手动压缩入口都会拒绝；renderer 的 `isNavigatingBranch` 覆盖请求到目标分支 hydrate 完成，期间输入框禁用、树对话框不可关闭并显示进度，总结可经 `abortBranchSummary` 停止，取消结果保留当前分支与草稿。

手动压缩不再是斜杠命令，入口在输入框的上下文用量弹窗：用量数字右侧「压缩」直接压缩，下拉箭头展开自定义压缩说明。会话运行中（Pi 的 `compact` 会中止当前任务）、切换分支中、已有压缩（含自动压缩）进行中或尚无上下文时禁用并用 tooltip 说明原因；压缩失败由 Pi 的 compaction 事件显示在对话中，弹窗只显示 IPC 拒绝。进度条标出自动压缩阈值：`SessionContextUsage.autoCompactAt` 由 main 按 Pi `getCompactionSettings(model)` 计算（窗口减 `reserveTokens`，关闭自动压缩时为 null），live 会话用自身的 settingsManager，未构建会话用全局设置。

内置浏览器提供人工预览与元素标注，Agent 工具由独立的 pig-browser 插件提供（见下文）。浏览器是与会话／文件同级的独立标签和分屏面板，顶部 `+` 可选择「会话 / 浏览器」，项目和 Chat 都可创建；右侧栏仍只有文件／变更。浏览器使用 `browser:<uuid>` 独立身份，不创建 Pi session/runtime，也不随目标会话关闭；跨重启恢复见下文「浏览器与终端的重启恢复」。宿主 UI 主 frame 跨文档导航（含刷新）、renderer 退出及窗口关闭时，由 main 统一销毁该窗口的预览与 DevTools，清空地址、标注和归属登记；重载期间拒绝浏览器控制与创建，宿主 `dom-ready` 后允许重新创建，不依赖 React 卸载，子 frame／同文档导航及网页 guest 自身导航不触发清理。`src/shared/browser.ts` 是唯一 IPC 契约；`browser:create` 由 UI 注册所属窗口，后续控制请求只接受同一窗口的 UI 主 frame，页面 guest 不能创建或控制预览；不通过 Pi session 校验身份。页面启用 sandbox/contextIsolation、禁用 Node 和宿主 API，使用独立 `persist:pig-browser` partition；仅允许无凭据的 HTTP(S)，拒绝权限、下载及新窗口；证书校验失败一律拒绝（Chromium 在这里没有警告页），主文档失败时在状态里记下 `certificate`（站点、错误、签发者、主体、有效期、指纹），面板在网页区域显示与 Chrome 类似的拦截页（隐藏原生视图，可返回或「仍要继续」），经 `browser:allow-certificate` 按指纹校验后把「host + 指纹」加入 main 内存里的放行集合并重新加载；放行所有标签共用、不落盘，换证书或换站点需重新确认，子资源从不弹确认，Agent 只在自己的导航错误里看到需用户放行的提示（不进共享的 navigate 错误，避免英文 Agent 文案出现在面板），没有工具可绕过。每窗口最多保留 4 个原生预览，多个分屏可同时可见，隐藏项 LRU 淘汰；网址独立于原生视图保留，淘汰后切回按保留地址重新加载，网络加载不阻塞 bounds 队列，加载失败通过浏览器状态及 main 日志报告；关闭标签或窗口才清掉地址。`browser-guest.ts` 构建为独立 **`out/preload/browser-guest.cjs`**；两个 sandbox preload 都必须是独立单文件，不能因共享运行时 import 拆出公共 chunk（沙箱 `require` 不允许加载本地模块）；构建会拒绝非入口 chunk，preload 的 IPC 频道沿用字面量白名单；closed Shadow DOM 拾取仅支持主文档，不深入 iframe 或页面 Shadow DOM，不采集表单值。main 按页面 documentId 验证拾取事件，导航前先取消旧 documentId 的拾取；拾取后在元素旁的 guest 浮层填写可选评论，不占宿主顶部空间；添加后继续拾取并显示编号 pin，hover 只读查看，点击打开编辑框可更新（`browser:marker-update`，按 documentId 校验）或删除，标记同步不覆盖未保存的编辑，浮层用宿主计算后的语义主题值与 constructed stylesheet 适配 glass/solid 和严格 CSP，不用 backdrop-filter。标记由 main 的 `BrowserState.annotations` 持有，原生 LRU 淘汰不能清掉待发标记；每条保留 documentId 和页面快照，失效 DOM 的 pin 隐藏而不改绑到复用 selector 的新节点；最多 100 条、评论最多 4000 字。顶部显示数量、「放入输入框」按钮、目标下拉和清空：目标默认是打开浏览器时所在的会话，没有则不选；下拉里选会话只记录目标（存于浏览器标签的 `browserTargetSessionId`），点按钮才写入，未选目标时按钮改为弹出下拉；下拉的「当前聊天」子菜单在项目内只列浏览器所在 worktree 的已打开会话（Chat 首页的浏览器列出全部项目/Chat 会话）；「新建聊天」不展开，直接在所属 worktree 新建会话（无项目时新建 Chat）；`newChat()` 返回新建会话 ID，标记写入必须用该 ID，不能从创建结束时的 activeTabId 猜测。标记批次渲染为 Markdown（页面字段标为不可信、页面文本用比内容更长的 fence 包裹），作为名为「浏览器标注」的 pastedText 附件追加到目标会话草稿（保留已有 Tiptap 附件与图片），激活该标签由用户确认后发送，不自动发起 Pi 消息，也不能以 browserId 创建伪会话；写入草稿后只移除该批 IDs，期间新增的标记保留。截图仍单独加入关联会话的图片草稿，无目标时提示先打开会话。工具栏单行，有独立 glass 填充与上下留白，地址栏回车导航，元素选择和截图在刷新按钮右侧，地址栏右侧为复制 URL／外部浏览器打开／检查元素；复制与外部打开只使用 main 校验后的当前 HTTP(S) 页面 URL，检查元素切换该网页自己的 DevTools，经 `setDevToolsWebContents` 放在同一面板下方的第二个原生视图里，以 `mode: 'detach'` 打开（外部目标下 Electron 不移动视图；停靠模式会让前端在自身视图里为页面预留一块空白，且拖它的分隔线不改变页面高度），因此前端没有自带的关闭按钮，改由工具栏高亮的检查元素按钮关闭。页面与 DevTools 之间不留缝也不画任何东西：原生视图盖住 DOM，renderer 没处放拖动条，所以 DevTools 顶部 10 DIP 与网页底部 5 DIP 共同组成透明拖动边：main 向 DevTools 前端注入 `row-resize` 光标条，网页 guest preload 在 DevTools 可见时临时放置同样的透明光标区域（该 5 DIP 被拖动占用，关闭 DevTools 或隐藏面板即移除；网页出现原生 `:modal` 时同步暂停网页侧命中，保留 DevTools 侧拖动，模态关闭后恢复；此节点及后代不享有拾取事件豁免）；两侧分别按各自的缩放换算 CSS 高度。main 经各自的 `before-mouse-event` 吞掉拖动鼠标，按页面或 DevTools 的坐标换算为同一边界并扣除按下偏移以避免跳动，再把位置（renderer CSS px）经 `browser:devtools-resize` 发给 renderer；Electron 的鼠标事件没有按键状态 modifiers（`button` 在普通 hover 时也是 `left`），以 mouseUp 结束拖动，隐藏、失效或跨文档导航主动取消，不依赖隐藏期间收到释放事件；网页光标区域在 `pagehide` 清理，不能在可取消的 `beforeunload` 提前移除。高度比例归 renderer，经模块级订阅在所有已挂载面板间共用（以标记自身 style 上的 `--devtools-ratio` 传给样式，标记 style 变化即触发 bounds 重新测量；不能放在 viewport 上，hook 自己会写 viewport 的圆角样式），页面与 DevTools 各至少 120px，`data-devtools-divider` 是零高度的位置标记，`BrowserBounds.devtools.height` 交给 main 排布。DevTools 随面板隐藏/淘汰/关闭一起处理，不检查 Pig UI；网页和内嵌 DevTools 的 `Cmd+W` 由 main 的 `before-input-event` 阻止原生关闭窗口，通过 `BrowserApi.onCloseRequested` 通知对应面板调用现有 `closeTab(browserId)`，按住不重复关闭；视口不是独立卡片（无背景），空白时直接露出面板本身的颜色。位于底部的那个原生视图（DevTools 打开时是 DevTools，否则是网页）通过原生 `View` 父容器裁剪外层面板的底部圆角，裁剪容器只包住它；它向上多出一个圆角半径的透明区域仍会绘制并吃掉点击，所以 DevTools 打开时把网页提到裁剪容器之上：renderer 按视口与 `data-content-surface` 的边界计算左右底角并随 bounds 传给 main，内部拆分边保持直角；main 按 zoom 换算，裁剪容器先用 `setBackgroundBlur(0)` 建立透明合成层（不启用模糊；普通 View 无 layer 时圆角不能裁剪子 layer），再设置圆角并向上延伸以保留网页顶部直角；分屏后底角不再贴合外层圆角（半径为 0）时必须拆掉裁剪容器、把网页放回窗口，零半径的裁剪容器在 Electron 44 下不绘制任何子视图，截图占位同步使用相同底角。隐藏、淘汰与关闭一起处理裁剪容器，不能仅靠 DOM overflow 裁剪原生网页。renderer 串行同步 CSS bounds（main 按宿主 zoom 换算），隐藏面板、模态弹窗、实际遮挡网页的浮层及材质切换期间隐藏原生视图，不靠 z-index 或根 filter 覆盖它；因浮层隐藏前先经 `browser:snapshot` 截一帧 JPEG，解码并同步提交到视口、等待两帧后才隐藏原生视图；恢复原生视图后也保留占位到两帧交接结束（IPC 返回不代表原生页面已经上屏，实际合成效果仍需人工验证）。只检测实际浮层内容，不把 Radix 定位 wrapper 当遮挡，但继续监听其位置变化；目标状态变化即取消旧交接，过期截图不能再隐藏页面、过期恢复不能清掉占位。截帧或解码失败仍执行隐藏并报告错误，bounds 写入失败不缓存为已应用状态，下一次布局更新可重试。页面本身不强行 glass 化，工具栏复用语义玻璃材质。

网页与内嵌 DevTools 聚焦时，main 的 `before-input-event` 仅拦截 `HOST_SHORTCUT_ACTIONS`（全局与标签页分组，按 main 缓存的当前绑定匹配，见「快捷键」）：`tab.close` 关闭所属浏览器标签，其余经 `BrowserApi.onShortcutRequested` 转发到 App，与宿主键盘入口共用动作；组字及按键重复不触发动作，复制粘贴等网页快捷键不拦截。preload 继续使用字面量频道，避免 sandbox 公共 chunk。macOS 应用菜单的原生 `close` role 由 `tab-close-menu.ts` 替换为无 accelerator 的关闭标签项：菜单回调不暴露 repeat 标志，因此 `Cmd+W` 只走已有的 renderer / guest 按键处理，避免原生加速键绕过重复按键保护或直接关窗；菜单点击经同一通道关闭活动标签。只重建包含关闭项的分支并保留父级 role，其余 Services、Window 等原生子菜单保持原对象。项目选择器打开时自行接收关闭请求并遵守保存中不可关闭的限制，App 不关闭后台标签。

Agent 浏览器能力由内置插件 pig-browser 提供（默认仅项目启用），工具与 MCP 一样以 `deferred` 暴露、归入 `browser` namespace（使用约定在 namespace instructions 与各工具描述里，不用 `promptGuidelines`），模型经 tool_search 按需加载。与 Pi 的 `mcp_servers` 相同，浏览器与终端插件各自在 `before_agent_start` 往 `pig_servers` 系统章节追加一行（`src/main/plugins/pig-servers.ts`，需随插件进 `extraResources`），仅当本会话还有非 hidden 的本组工具时才列出；章节每轮重建，开关变化只由 Pi 发章节补丁，不改写已缓存前缀，全部关闭时章节移除。读取工具为 `browser_tabs` / `browser_open` / `browser_navigate` / `browser_history` / `browser_snapshot` / `browser_screenshot` / `browser_console` / `browser_annotations`；第二阶段增加 `browser_click` / `browser_type` / `browser_press` / `browser_scroll` / `browser_select` / `browser_wait`，第三阶段增加 `browser_switch` / `browser_release` / `browser_close` / `browser_network` / `browser_upload`，仍不提供任意 `evaluate` 或任意网络请求工具。结构与 pig-subagent 相同：`src/main/plugins/pig-browser/` 只注册工具，经 `pig-browser-host.ts` 的 globalThis 注册表调用 main 的 `BrowserAgentController`（`src/main/browser/agent.ts`），两者都要进 `extraResources`。操作的就是用户可见的同一批浏览器标签：一个会话同时只控制本窗口一个标签，`browser_open` 不带 browserId 时由 main 发 `browser:agent-open-request`，renderer 在该会话所在 worktree（Chat 则 Chat 侧）后台新建标签并经 `browser:agent-open-answer` 回答，main 只接受该窗口自己 `browser:create` 过的 id；带 browserId 则接管，另一存活会话持有的标签拒绝，已关闭会话的控制自动失效。控制记在 `BrowserHost` 的 `agents`（随 LRU 淘汰保留），接管被淘汰标签时立即按保留网址重建加载，不依赖用户切到该标签；受控标签按会话存活豁免淘汰并关闭后台节流，隐藏页默认 1280×800 视口；隐藏页截图走 CDP `Page.captureScreenshot`（先请求 Chromium 产帧，绕过 `capturePage` 对未显示过页面的 surface 前置检查），不切换标签或显示原生视图；同一页面的隐藏截图、交互与上传通过 `browser-debugger.ts` 共用串行队列，已有 debugger 连接复用不主动断开，仅释放自己临时建立的连接，可见页截图仍走 `capturePage`；`BrowserState.agentSessionId` 驱动工具栏 Bot 按钮，点击先弹二次确认，说明直接释放可能打断操作且 Agent 仍可能重新接管；运行中提供「直接释放 / 停止 Agent 并释放」，后者先等待 `abort` 成功再释放，停止失败保留控制并显示错误；未运行时改为简短说明与「取消 / 释放控制」，不调用 `abort`，弹窗文案随所属会话运行状态更新。确认期间锁定目标会话，main 按 expectedSessionId 校验，避免迟到确认释放其他会话的控制；不改变原有控制生命周期。子 agent 不加载该插件（`subagentPluginPaths` 排除），没有窗口的会话调用直接报错。快照由 `agent-snapshot.ts` 的自包含函数经 `toString` 在独立 isolated world（1207）执行，输出带 ref 的无障碍大纲，ref 存在 isolated world 供交互，密码值不输出，行内文本也逐层过滤隐藏节点和脚本；console 按文档缓存最近 200 条。实际快照求值与截图等待均响应工具取消，底层未完成的 Electron 操作仍接收迟到拒绝，但不阻塞已取消的工具调用。页面标题、文本、console 与标注页面字段都以不可信内容 fence 返回。导航最多等 30 秒后返回，之后的失败进浏览器状态与 main 日志。交互由 `agent-interaction.ts` 在同一 isolated world 解析 ref、滚动并检查可见性/遮挡/禁用，再通过 CDP 发鼠标和键盘事件，不切标签或请求原生焦点；输入默认替换文本，不回显输入值，支持文本类 input、textarea 和 contenteditable，原生 select 校验选项后派发 input/change。按键仅支持常用按键及受限编辑组合，macOS Command 编辑组合在 keyDown 附带 Blink editing commands（keyUp 不重复），拒绝关闭窗口、地址栏等浏览器快捷键；沿开放 Shadow DOM 查找实际焦点并校验目标，拒绝深层 iframe 焦点，只操作主文档，不跨 iframe。每个异步步骤校验文档与控制归属；取消及时结束工具等待，底层未完成操作仍持有队列直至结束，按下后的鼠标/按键必须释放，防止迟到输入影响下一调用。`browser_wait` 无目标时等加载完成，有 ref 或 CSS selector 时轮询 visible/hidden/attached/detached（二选一，默认 visible，默认 10 秒、上限 30 秒），导航/转交控制/用户停止立即使等待失效；等待脚本是自包含序列化函数，选择器只作数据，不执行任意 JS。交互、上传中的 DOM 校验、快照和等待统一经 `browser-script.ts` 执行：脚本异常在 isolated world 内转成结构化失败结果，main 验证后按原始消息重抛，避免 Electron 把异常泛化；Electron 自身的执行/生命周期拒绝原样传播，畸形结果直接报错，不做兜底。

第三阶段的 `browser_switch` 复用接管规则，默认不变更 UI，仅 `activate=true` 经原有 agent-open 请求/应答通道激活；请求类型在共享契约区分 open/activate/close，应答校验窗口、会话及确切 browserId。`browser_release` 保留页面，`browser_close` 只关当前受控标签，main 先销毁原生视图并移除归属，再让 renderer 从标签/分屏移除，防往返期间被另一会话接管；已关闭父会话不阻止授权过的 UI 关闭清理。`network-log.ts` 每个 Session 只安装一套 webRequest 监听，按 webContentsId 隔离日志与 pending，各最多 200 条；主文档跨文档导航清空，LRU 淘汰/关页/关窗释放。仅保存 HTTP(S) 的方法、资源类型、状态、耗时、重定向与规范 net::ERR 错误码，URL 移除凭据/query/hash，不保存 headers/body/Cookie；未知错误仍保留 failed 标记但不回显原文。工具最多返回 50 条不可信 fence 数据，URL 路径本身仍可能敏感，不承诺通用匿名化。上传只接收用户任务授权的 1–20 个绝对路径，经 realpath/stat 验证普通文件；路径仅留在 main 和 CDP，不写入页面脚本或工具结果。`agent-upload.ts` 按原 ref 校验 input[type=file]、disabled、multiple 和禁止目录，支持隐藏输入及开放 Shadow DOM；快照只额外列出遗漏文件输入的元数据与 upload-only ref，不读取其他隐藏内容或文件值。上传按 isolated world 算出的逐层元素子节点序号（含标签名，跨开放 shadow root 分段）用 CDP `DOM.describeNode` + `backendNodeId` 精确定位，不用 selector 匹配（shadow root 内 selector 会先命中更深的同形节点），发送前复查原 ref 连接和原位置，禁止绑定到替代节点；`browser_click` 拒绝点击文件输入框（会弹原生文件对话框），提示改用 `browser_upload`；不跨 iframe，不支持目录或原生文件对话框。赋值后网页可能自动上传，已发送动作不能撤回，结果需快照/网络日志确认。

按需网络正文捕获独立于轻量 `browser_network`：`browser_network_capture` 提供 start/stop/clear，`browser_network_requests` 列出最近 50 条匹配记录，`browser_network_detail` 按 ID 读取参数与响应。`network-capture.ts` 用 CDP Network 收集 HTTP(S)，支持 URL 子串与 CDP resourceTypes 过滤；start 重置记录、stop 保留记录、clear 不改运行状态，跨导航保留，控制权释放/转交/切换标签、关页/关窗及关闭父会话时停止并丢弃，不落盘。关闭父会话经 `closeSessionBrowserControl` 清理，不依赖插件启用。最多 200 条，每条请求和响应正文合计 64KiB；仅文本正文，二进制/base64、超限、失败/不可用有显式状态，不支持 WebSocket 帧。超限按 CDP 的 `hasPostData` 无正文及 `dataReceived` 解码字节判断，不匹配错误文本。过滤凭据头、URL 凭据、常见敏感 query 与 JSON/表单字段（任何文本正文能解析为 JSON 对象/数组即按 JSON 脱敏，覆盖 fetch 默认的 text/plain；JSON mime 解析失败为 unavailable）；这不是通用脱敏，路径、自由文本及自定义字段仍可能敏感，工具返回不可信 fence。`browser-debugger.ts` 的引用计数 lease 让长期捕获与截图/交互的临时 CDP 队列共享连接，不主动断开外部已连接的 debugger；异步结果按捕获代次与记录身份校验，旧 dispose 不得禁用新捕获。

浏览器工具栏的 Cookie 导入首版仅支持 macOS Chrome（Default / Profile N），Safari、其他浏览器、文件导入和非 macOS 解密暂不支持。来源 ID 由 main 检测生成，不接收任意文件路径；预览只读 SQLite 事务快照（含 WAL），不请求钥匙串，导入才通过 `/usr/bin/security` 获取 Chrome Safe Storage 密钥并校验 v24 域名哈希。Cookie 名称、值和密钥不进入 renderer、不写日志或 Pig 配置，解密密钥仅本次使用，源数据库不复制、不修改。当前站点按 PSL（含私有后缀）计算，支持明确确认后导入全部；过期、分区及不支持属性分别统计，保持 host-only / domain、path、SameSite、Secure、HttpOnly 与有效期语义。同键覆盖、一次复制，不做同步，所有浏览器标签共享 `persist:pig-browser` 登录态；清除本站需确认且不可撤销。导入重新读取来源，预览计数可能变化；读取/解密失败直接报错，单条 Chromium 写入或删除拒绝是显式部分结果边界（只返回失败计数，避免原生错误泄漏值），flush 失败仍抛出。跨标签写入和清除经 Promise 链排队串行；读取前后重新校验 UI 归属及站点，开始写入或删除后不再中断，必定 flush 并返回计数，避免留下未计数的部分写入。macOS Chrome 对 Cookies 库只持有 SQLite 共享锁（独占访问仅 Windows），读取带 5 秒 busy timeout，仍为 `SQLITE_BUSY`/`SQLITE_LOCKED` 时按 errcode 报“Chrome 正在写入”，其他 SQLite 错误保留 `cause`；成功变更后刷新页面，刷新失败与导入结果分开展示。Cookies 不涵盖 localStorage、设备绑定凭据等，不能保证复用所有站点登录。

快捷键唯一的定义表在 `src/shared/shortcuts.ts`：动作 ID、分组、默认值（可按平台区分，如终端在非 macOS 上避开 readline 的 Control+K/A）、匹配、冲突与保留键规则都在这里，main 与 renderer 共用。绑定是规范字符串 `Mod+Shift+KeyE`，修饰键顺序固定，最后是 `KeyboardEvent.code`（按物理键匹配，不受 Shift、键盘布局和 IME 影响）；`Mod` 在 macOS 是 Command，其他平台是 Control。`settings.json` 的 `shortcuts` 只存用户改过的项（缺省走默认，`null` 为停用），读取时逐项丢弃非法值；`settings:set-shortcuts` 接收 patch（`'default'` 删除覆盖），在设置文件队列内整体校验后写入，「替换」把新键和停用原占用者放在同一个 patch 里。main 的 `src/main/shortcuts.ts` 缓存当前绑定给浏览器 guest 使用，启动与每次保存后更新。renderer 经 `lib/shortcuts.ts` 读取当前绑定，App（全局与标签页动作，含 ⌘T 新建会话、⌘1–8 / ⌘9 按标签条 `stripSlots` 的槽位切换，分屏组算一个槽位）、输入框、文件、终端和项目选择器都查表，提示文字用 `ShortcutKbd` / `shortcutText` 显示当前键位。窗口级动作（全局、标签页与 `composer.focus`）必须带 Command/Control，并与所有分组互斥；其他分组只在组内互斥，不带修饰键时只允许 Tab 与 F 键（终端分组必须带 Command/Control，Tab 与 Alt 留给 shell）；恢复默认值同样检查冲突。本平台按不出来的写法（macOS 的 `Meta`、其他平台的 `Ctrl`，事件里都会变成 `Mod`）保存时拒绝、读取时丢弃。设置页录制期间由 `setShortcutRecording` 让所有监听让路。发送键（Enter / Shift+Enter）仍是独立的 `sendShortcut`，只是在快捷键页显示。

内置终端是与会话／浏览器同级的 `terminal:<uuid>` 标签，顶部 `+` 选「终端」创建，可分屏；项目内在当前 worktree 目录启动，Chat 侧（标签 cwd 为空）在 `$HOME` 启动，目录不存在直接报错。不绑定 Pi session，标签跨重启恢复（见下文「浏览器与终端的重启恢复」），shell 进程不恢复。shell 跑在 main 懒启动的 `utilityProcess`（`src/main/terminal/pty-host-worker.ts`，构建为独立入口 `out/main/pty-host-worker.js`）里，node-pty 崩溃不影响 main；进程退出时各终端收到 `failed`，下一个终端重新拉起。main 的 `TerminalHost` 只持有终端→窗口归属，IPC 仅接受所属 UI 主 frame，宿主页面跨文档导航、renderer 退出或窗口关闭时统一 kill；关闭幂等，仍在启动中的 shell 也会被 kill（kill 消息排在 spawn 之后）。kill 先 SIGHUP，1 秒后对 shell 自身的进程组 SIGKILL；交互 shell 开启 job control 后每个任务另有进程组，忽略 SIGHUP 的任务会存活（与其他终端关闭窗口时的 nohup 语义一致）。shell 取 `shellCandidates()` 首个并加 `-l`（Windows 为 powershell）；环境以已导入登录 shell 环境的 `process.env` 为底，去掉启动终端的 `TERM*`/`COLORTERM`/各终端标识、`NO_COLOR`/`FORCE_COLOR`、`ELECTRON_RUN_AS_NODE` 和 **`PIG_DIR`**（否则在该终端里起的开发实例会共用安装版数据目录），固定 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=Pig`，无任何 locale 时补 `LANG=en_US.UTF-8`。输出在 worker 内按 16ms／128K 合批，renderer 在 xterm 解析完成后按 UTF-16 长度 ack；未确认超过 100K 暂停 PTY，降到 5K 恢复，10 秒无 ack 强制恢复。renderer 的 xterm 实例随标签存活（`src/renderer/src/terminal/runtime.ts`），切换标签只把元素挪进屏外 parking 容器，标签从 store 消失时释放并关闭 shell；`TerminalPanel` 懒加载。字体只给终端用 Nerd Fonts v3.5.1 的 Lilex Nerd Font Mono（四个字重 woff2，OFL，`src/renderer/src/assets/fonts/lilex-nerd-font-mono/`），等字体加载后才 open/测量并启动 shell；聊天与代码块仍用 `@fontsource-variable/lilex`。WebGL 渲染失败或丢失上下文时退回 DOM 渲染。背景透明，前景、光标、选区与 16 色来自各主题的 `--terminal-*`，随 `<html>` 属性变化同步。按键先匹配终端自己的绑定（清屏、全选），再把窗口级快捷键交给应用，但单独 Control（不带 Command/Shift/Alt）的组合始终是 shell 输入，App 的 capture 监听同样跳过 xterm 内的这类按键；macOS 上其余 Command 组合除 C/V（复制粘贴）外都不进 shell；按住 Cmd/Ctrl 点击链接才用系统浏览器打开。打包：node-pty 在 `dependencies` 并 `asarUnpack`；1.1.0 的 macOS `spawn-helper` 发布时缺执行位，`postinstall` 的 `scripts/prepare-node-pty.ts` 补 0755；macOS/Windows 用其 N-API 预编译，Linux 需 `trustedDependencies` 放行现场编译。

浏览器与终端的重启恢复：`open-project-sessions.json`（v5）的 `tools` 记录所有打开的浏览器／终端标签（id、kind、所属 worktree 或 `''` 表示 Chat 侧、浏览器的 `url` 与标注目标）。renderer 在 `workspaceRestoreReady` 后整体写入成员（`saveOpenToolTabs`，新标签追加到所在标签条末尾）；网址只有 main 知道，`BrowserHost` 的 `onCommit` 在主 frame 提交时经 `saveBrowserTabUrl` 合并进下一次写入，未登记的 id 忽略。worktree 的 `tabOrder` 与 Chat 侧的 `chatOrder` 都包含这些 id，切到或前台新建它们也写入 `activeTabId`／`activeChatTabId`。网址保留 query 与 hash（页面要回到原处），其中可能带 token，因此该文件以 0600 写入。读取时只保留导航本身允许的 HTTP(S) 网址；恢复时浏览器先 `browser:create(id, url)` 登记归属并把网址放进保留表，不建原生视图，首次显示才加载；终端标签首次显示才启动新 shell，运行中的命令不恢复。标注、前进后退历史、DevTools、Agent 控制权与终端创建者记录都不恢复；目标会话没回来时清掉标注目标；所在 worktree 已删除的标签丢弃。分屏可以有多组，每组在标签条上是一个合并标签，画面只显示活动标签所在的组；一个标签同时只属于一组，拖进别的组就从原组移走，任何组剩不到两个面板即解散（`split-layout` store 的 `groups`）。在独立标签上分屏新建一组，不影响其他组。分屏组（`splits` 数组，节点类型在 `src/shared/split-layout.ts`）也保存在同一文件：renderer 在恢复完成后、每次 `groups` 变化时整体写入，没有分屏写空数组；main 写入时严格校验（组间面板 id 与标签 id 都不能重复），读取时损坏的布局视为无分屏，旧版单个 `split` 读作唯一一组。恢复在标记 `workspaceRestoreReady` 前进行，按关闭面板的方式移除标签没回来的面板（文件标签不持久化，所在面板总会被移除），剩不到两个面板的组丢弃；恢复期间用户已自行分屏则保留用户的。

终端输出的重启保留：PTY worker 为每个终端维护 `$PIG_DIR/terminals/<uuid>.json`（`{version: 1, cwd, history}`，0600，目录 0700；文件读写在 `src/main/terminal/history-file.ts`，命名与清理在 `history.ts`）。`history` 由 headless 解析器经 `@xterm/addon-serialize` 编码（不含备用屏幕与终端模式，超过 1M 字符时逐级减少 scrollback），在解析链上取值以保持与输出同序；有输出、clear、resize 后最多每五秒写一次，正常关闭仍写最终记录。同一终端的文件读写按队列串行，最终目录查询也在队列内；同 ID 的新 spawn 等待队列完成再读取，等待期间的请求按序重放，shutdown 也等待这些启动。已 close 的旧 shell 不再转发 output／exit，避免晚到消息影响同 ID 的新终端。迟到的写入不会重建已删除的记录。关闭消息是 `close`（替代原 `kill`），带 `history: 'keep' | 'discard'`：标签被关（含 shell 退出自动关、`terminal_close`）为 discard，已退出的 shell 也会收到以删除记录；窗口关闭、renderer 重载与退出应用为 keep，先查 shell 当前目录（macOS `lsof`、Linux `/proc/<pid>/cwd`，Windows 不查）并写最终记录，再挂断 shell，`shutdown` 等这些写入完成才应答。启动 shell 时同步读取记录：保存的目录仍存在就在该目录启动（`spawned` 回传实际目录，`terminal_tabs` 的 initialDirectory 随之变化；标签所属的 worktree 仍以 `tools` 的 cwd 为准），历史（不加任何分隔提示，新 shell 从下一行开始）作为第一段输出同时进入 renderer 与 headless 解析器（`terminal_read` 可读到旧输出）；记录无法读取时在面板显示错误，shell 照常启动，下次写入覆盖。main 启动时在建窗口前删除不在 `tools` 终端列表里的记录（例如从未显示就被关闭的标签）。输出可能含敏感内容，只靠文件权限保护。

Agent 终端能力由内置 `pig-terminal` 插件提供（默认仅项目启用，子 agent 排除），沿用浏览器的 deferred 工具与 globalThis host bridge，提供 `terminal_tabs/open/read/type/press/release/wait/switch/close` 九个工具。main 的 `TerminalAgentController` 校验会话所属窗口并维护独占控制，一个会话同时控制一个终端；接管另一个释放旧控制，不结束 shell。新建经 `terminal:agent-open-request/answer` 让所属 renderer 在会话 worktree（Chat 为 Home）后台创建，`ensureTerminal` 初始化并停放同一 xterm，等待 shell 就绪才应答，不切标签、不抢焦点；拒绝迟到应答后清理孤立标签。worker 用 `@xterm/headless` 和同版本 Unicode11 解析 PTY 输出，串行处理输出、resize、快照，滚动历史最多 5000 行、读取最多 500 行／32768 字符，返回光标、备用屏幕、输入模式及输出版本，不把 headless 自动响应再写回 PTY。Cmd+K 经 worker 发有序 clear 标记，前后输出与两端 parser 同序，不能只清 renderer 历史。工具读取按不可信文本 fence 返回。`terminal_wait` 每 100ms 轮询快照，支持单行字面文本、版本推进或静默间隔（文本与静默互斥），默认 10 秒、最多 120 秒；静默按单调时钟从最近观测到的版本变化起算，不推断命令完成。`afterVersion` 只要求快照版本更新，不能证明文字是新出现的；未指定时文本可立即匹配、静默从调用开始，无其他条件时等待本次初始版本之后的新输出。wait 不占输入队列，以便 switch/close 立即使旧控制等待失效。`terminal_switch` 默认不切 UI，`activate=true` 才经同一请求/应答通道激活，main 核对窗口、会话和确切 ID。`terminal_close` 仅允许本会话通过 open 新建的终端（内存创建登记跨 release 保留，tabs 返回 canClose），接管用户或其他会话创建的只能释放；先取消控制并移除主进程 PTY，再请求 renderer 移除标签，已开始 kill 后不因工具取消放弃 UI 清理，已关闭父会话不阻止授权后的清理应答。输入按会话串行，按 bracketed-paste/application-cursor 模式编码，成功仅表示输入已发送，不推断命令完成。释放／关窗／会话关闭使旧控制读取失效，插件重载不释放；用户停止 Agent 不发送 Ctrl+C、不杀 shell，已发送输入不可撤回。用户可同时人工输入；面板右上 Bot 按钮复用浏览器的运行中直接释放／停止后释放及空闲确认，main 按 expectedSessionId 拒绝迟到确认。`pig-terminal` 目录和 `pig-terminal-host.ts` 都必须进入 extraResources。

Agent 后台进程由内置 `pig-process` 插件提供（默认仅项目启用，子 agent 排除），与浏览器、终端一样以 deferred 工具归入 `process` namespace 并列入 `pig_servers`，提供 `process_start/list/read/wait/stop`。结构同 pig-terminal：插件只转发，经 `pig-process-host.ts` 的 globalThis 注册表调用 main 的 `BackgroundProcessController`（`src/main/processes/`），两者都要进 `extraResources`。用于 dev server、watch、长构建等非交互长任务，交互程序仍用终端。命令像 bash 工具一样用 `$SHELL -c` 跑在已导入登录环境的 `process.env` 下（去掉 `PIG_DIR`、`ELECTRON_*`、`FORCE_COLOR`，设 `NO_COLOR=1`、`TERM=dumb`），stdin 关闭、stdout/stderr 走管道而非 PTY：会提示输入的程序直接失败，退出码可靠。默认目录为会话 worktree（Chat 为 Home），可传相对或绝对 cwd，目录不存在直接报错。每个进程独占进程组，停止时先 SIGTERM，1 秒后对进程组 SIGKILL（shell 退出后仍执行，子进程可能忽略 SIGTERM）；Windows 没有进程组，改用 `taskkill /T /F` 杀整棵树（未验证）。进程以 shell 退出且管道关闭为结束；脱离进程组的子进程（setsid、守护进程）会一直占着管道，所以 shell 退出 1 秒后强制断开管道，停止、等待退出与关会话都不会无限挂起。行的输出版本取首次出现时的版本，未完成的行补上换行后不变。输出去掉 ANSI，`\r` 进度只保留最后一段，每进程最多 5000 行／1M 字符，读取最多 500 行／32K 字符并以不可信 fence 返回；两个管道之间没有共同顺序。`process_wait` 带 text 时按字面子串匹配最近 500 行（afterVersion 限定更新的输出），进程先退出则报错；不带 text 时等退出并返回退出码，默认 10 秒、最多 120 秒，超时报错，取消不停止进程。每会话最多同时运行 8 个、保留 32 条记录。进程归会话而非插件所有：`disposeLiveSession` 调 `closeSessionProcesses` 杀掉并忘记该会话的进程（插件被关掉也照样清理），退出应用时 `shutdownProcesses` 与终端一样是强制清理项，等所有进程组 SIGKILL 完成才退出；不跨重启恢复。Agent 没有观察到的结束（不是 `process_stop`，也没被 `process_wait` 返回或报错）——自行退出（含退出码 0）或用户在 UI 停止——由插件 `session_start` 时 attach 的投递函数以隐藏 `process-exit` custom message 发给 Agent，`triggerTurn: false`：运行中排到本批工具结果之后，空闲时直接写入会话等下一轮，不开新一轮；Pig 自己清理（关会话、退出）不投递。输入框右侧的 `ProcessStatus` 是所有进程共用的一个按钮（位于子 agent 与 Review 状态左侧，没有记录时隐藏），运行中外环转动，有 `failed` 时右上红点；弹层每行显示名称或命令、状态、时长与退出码，可展开最近 20 行输出，运行中可停止、已结束可移除。数据经 `src/shared/processes.ts` 契约：main 每会话 250ms 合并一次推送整份快照（`processes:changed`），stop/remove 只接受 UI 主 frame。UI 状态：用户或 Agent 要求停止为 `stopped`，自行退出码 0 为 `exited`，其余为 `failed`。

Pi SDK 当前固定为 1.4.0，直接依赖 `pi-ai` 同步固定为 1.4.0。`patches/@earendil-works%2Fpi-coding-agent@1.4.0.patch` 保留三项上游尚未合入的改动：允许自定义 `preamble` 而保留默认 tools/rules/docs；MCP HTTP 传输、OAuth 登录及刷新统一注入宿主 `fetch`，并等待异步 `openUrl` 以传播打开失败；从包入口导出 `resolveModelScopeFromModels`（含类型声明）。升级 SDK 时逐项核对，不能只迁移 preamble 补丁。

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
| `src/main/terminal/`                 | 终端归属、shell 与环境选择，PTY utility process（合批与背压） |
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
bun run test       # 4 个 worker 按文件隔离并行；不要直接给用例加 concurrent
bun run test:serial # 串行排查跨文件干扰
bun run build
```

全量测试默认用 `bun run test`（需要支持 `bun test --parallel` 的 Bun），按文件启用独立 worker/global 隔离，最多 4 路，避免 CPU 与子进程争抢。针对改动可用 `bun test tests/<file>.test.ts`；排查时用 `bun run test:serial`。不要使用 `--no-isolate` 或全局 `--concurrent`，测试里的模块 mock 与环境变量不能共享并发修改。

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
