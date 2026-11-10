# Markdown 关联记忆

长期记忆由主 Agent 按需读取和维护。Markdown 文件是唯一内容来源，没有知识数据库、固定分类、自动提取／整合、后台学习任务、模型召回筛选或 Dream。OM 的 observations/reflections 继续只负责当前会话压缩，不参与这条链路。

## 存储与范围

```text
$PIG_DIR/memory/
├── global/
│   ├── MEMORY.md
│   └── <主题>.md
└── projects/<项目身份 SHA-256>/
    ├── MEMORY.md
    └── <主题>.md
```

开发默认 `cwd/.pig`，安装版默认 `~/.pig`；`PIG_DIR` 优先。项目身份沿用可靠 Git common dir，否则使用真实 cwd，因此同仓库 worktree 共用目录。Chat scratch 不继承外层开发仓库，只提供 global。Agent 不能传任意项目身份或本机绝对路径；UI 可检查全部项目文件。

global 是跨项目共用内容，不是绕过项目范围的副本库。项目实现细节应写在 project；记忆不构成上传、联网、命令执行等权限授权。

新配置为 OM namespace 内独立的 `fileMemory: { enabled: boolean }`，默认关闭。旧 `longTerm` 配置、独立模型配置和 SQLite 文件完全不读取、不迁移，也不自动删除。没有旧 API 兼容层；升级后需在设置中开启文件记忆。关闭时不注册四个 memory_* 工具，也不注入 memory 使用说明或 pig_servers 的 memory 入口；tool_search 无法发现这些工具。切换沿用会话资源重载：空闲立即应用，运行中等本轮结束，重新开启时恢复工具及说明；已写入历史的旧提示不擦除，由 SDK 章节补丁移除当前有效章节。原始聊天、OM 与人格数据不改动。

## 入口与按需阅读

`MEMORY.md` 只是很小的回忆起点，放有区分度的线索、简短说明和主题链接，不是知识正文。Agent 可以自由组织主题文件和 Markdown 相对链接，没有强制类型或 frontmatter。

系统提示词的 `memory` 章节仅包含简短英文使用说明：需要记忆时通过 tool_search 加载 memory_ 工具，先读取对应 scope 的 MEMORY.md，再沿链接阅读；索引缺失或为空时可列出文件，其他记忆仍可能存在。global 和 project 的索引及主题正文都不自动注入。每份索引仍限制为 4 KiB／60 行，末尾换行不额外算一行、真实空白行仍计数；这些限制仅用于文件保存，不再用于系统提示词预览。

在 SDK `before_agent_start` 中只按启用状态设置／移除 `systemPromptOptions.sections.memory`，不读取记忆文件，不返回强制 systemPrompt，也不通过 `context` 追加临时消息。索引创建、修改、删除或项目切换均不改变这段使用说明；当前文件内容通过 memory_read 按需读取。Pi 仅在使用说明或启用状态变化时按章节差量机制更新，旧的带索引正文的章节会被完整替换为使用说明。
四个工具通过 `deferred` 和 `memory` namespace 由 `tool_search` 渐进加载，工具目录沿用 `pig_servers`。没有每轮辅助模型请求或强制读取目录的动作。

## 四个工具

- `memory_read(scope, path?, from?, query?, offset?, limit?)`：不传 path/query 时列目录；query 为字面文本搜索；path 读取一份笔记或原样接收 Markdown 相对链接。from 为来源笔记的规范路径（复制上次返回的 file.path），工具以其所在目录解析 `./`／`../`；省略 from 时以 scope 根目录解析。from 必须与 path 一起使用，path/query 互斥。返回 file.path 是 scope 根下的规范路径，可直接用于编辑／删除，或作为下一次读取的 from。文件 offset 是零起始行偏移，目录／搜索 offset 是条目偏移，跟随 nextOffset。每页最多 200 行／条，输出按字节进一步限幅。revision 总是完整文件的 SHA-256，即使只读了一页。
- `memory_add(scope, path, content)`：只创建，不覆盖已有文件；重复添加报 `MEMORY_ALREADY_EXISTS`，与 edit/delete 的 `MEMORY_REVISION_CONFLICT` 区分。一般先查相关笔记再决定是否需要新建；添加后检查对应 scope 的 MEMORY.md，不存在则通过记忆工具创建，并维护有价值的入口链接。
- `memory_edit(scope, path, revision, oldText, newText)`：唯一精确文本替换；只有现有文件为零字节时，允许 oldText 为空、用 newText 初始化，无需删除重建。仅含空白的文件不是零字节，不能使用这一特例；revision 必须来自读取，空文件初始化也严格检查版本。冲突先重读再判断，不盲重试，不支持整目录重写。
- `memory_delete(scope, path, revision)`：删除单个 Markdown 文件，不递归删目录。永久删除，不影响原始会话；没有旧方案的来源封禁、替代链或遗忘级联。相关链接由 Agent 局部维护，不静默改写其他文件。删除后在 catalog writer lease 内用非递归 rmdir 向上回收空父目录，保留 scope 根及其外层目录；遇到非空目录（含隐藏文件／链接）停止，不删除其内容。其他清理失败明确报告文件已删除但目录回收失败，不宣称回滚；不额外扫描清理历史遗留空目录。

scope 只能是 global 或当前 project。read 工具说明明确索引名为 `MEMORY.md`，对应各自 scope 根；需要完整索引或 revision 时可直接传 `scope` 和 `path: MEMORY.md`。Markdown 链接按标准相对所在笔记的目录，不引入虚拟路径或强制平铺。Agent 无需换算：例如从 `guides/start.md` 跟随 `../testing.md` 时，传 `from: guides/start.md, path: ../testing.md`，返回 `file.path: testing.md`。底层拒绝越出 scope 的回退（固定 code `MEMORY_LINK_OUTSIDE_SCOPE`）、绝对路径、URL、编码路径、隐藏路径；解析后的读取仍执行既有符号链接／硬链接检查。编辑／删除继续使用返回的规范路径，不接收 from 或 `../`。主题文件最多 64 KiB，单行最多 15 KB，确保工具能分页读取。索引限额在提交前校验，超限不会保存。所有记忆读取均经工具返回，结果用自适应 JSON fence 标为不可信历史数据，不作为指令或授权。

## 记忆维护

工具说明采用英文，以查看／添加／修改／删除记忆的方式描述，不把 Markdown 格式当成主要概念。read 明确说明列目录、搜索、读文件的参数选择，以及链接解析、分页和版本的用法。add 要求先查相关记忆、优先补充已有内容；edit 要求先读、唯一精确替换（零字节文件允许空 oldText 初始化），冲突后重读；delete 明确单文件永久删除。维护受影响的链接和索引，不保存密码、密钥等敏感信息。主题笔记 add／edit 成功返回 path、revision 和 reminder，提醒检查同 scope 的 MEMORY.md、缺失时创建并维护入口；直接写根 MEMORY.md 不返回这一提醒，避免反复维护索引的循环。底层不代写摘要，不自动把所有主题放入索引。

Agent 按需维护记忆，没有强制补记忆轮次或后台定时器。

## 安全与并发

文件工具只开放记忆根内的路径，拒绝绝对路径、遍历、隐藏路径、符号链接、硬链接及非普通文件。目录 0700、文件 0600。UTF-8 严格解码，损坏和 IO 错误明确报错。读取失败保留 ENOENT 等错误码，只展示 scope 内相对路径，不返回底层错误的真实磁盘路径或原始 cause。常见凭据模式拒写，但不宣称这是对任意敏感内容的完整识别。

默认／完全访问模式允许专用工具在受限目录内维护记忆，无逐条人工准入；只读模式拒绝全部修改，读取仍可用。取消及实际提交前重新检查权限。普通 bash／文件工具继续受已有沙箱保护，不能用它们绕开记忆接口。

全体 global／project 笔记共用 `memory/` 的遍历预算与 writer lease：最多 1000 个 Markdown 文件、2000 个非隐藏条目，目录深度从 `memory/` 起最多 8 层（包含 scope 目录）。写入在锁内检查新增文件和目录的预算，超限时不创建目标目录、不落盘；达到容量上限仍可编辑已有文件。深度／文件数／条目数超限分别使用固定 code `MEMORY_DEPTH_LIMIT`／`MEMORY_FILE_LIMIT`／`MEMORY_SCAN_LIMIT`。搜索只保留当前分页，找到下一条匹配即可返回，不累计全库匹配行。

写入采用目录 writer lease、revision 比较和临时文件 rename；并发写者返回 busy，过期版本返回 conflict，不自动覆盖。崩溃遗留 lease 仅在其 PID 已不存在时回收；无法确认的 lease 报错，不抢锁。提交临界区无异步等待。该机制防协作实例的丢更新，不宣称隔离拥有同一本机账号权限的恶意进程。

## 设置页

人格与记忆 → 长期记忆提供文件记忆开关和 Markdown 文件浏览器。开关保存失败后重新读取持久化配置；若重读也失败，明确显示两次错误并将配置标为未知、禁用开关，提供重新读取按钮，仅在成功读到配置后恢复操作。没有五分类列表、模型选择、后台队列、学习用量或自动召回诊断。文件可查看、编辑、保存、删除；保存／删除使用相同 revision 校验，失败保留草稿，未保存关闭或切换文件需确认；切换笔记会取消上一份笔记的删除确认。UI IPC 仅所属主 frame 可调用。滚动保留但隐藏滚动条。

## 参考与边界

- [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)：小入口、按需展开、关联表示，以及写记忆的注意力成本。
- [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)：宿主执行受限文件操作、精确替换和路径边界。
- [Claude Code auto memory](https://code.claude.com/docs/en/memory)：MEMORY.md 索引常驻、主题文件按需读取。

四个工具拆分与 deferred 是 Pig 的接口选择，不是官方比较实验得出的最优结论。首版没有 Dream、向量检索、跨项目任意读取、自动链接修复、历史导入或删除后禁止未来重新学习的机制。
