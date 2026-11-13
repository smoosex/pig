# 人格、表达状态与观察员

修改 `src/main/features/persona/`、preamble、心情设置或观察员前阅读。OM 与文件记忆见 [记忆](long-term-memory.md)。

## 会话接入与文件

- 人格和观测记忆是 `src/main/features/` 内置功能，不走插件注册表或插件路径白名单。项目和 Chat 均接入，子 agent 的 `identity:false` 同时排除两者；没有会话类型开关。这不取消文件记忆自身的开关。
- `createSessionRuntime` 用 SDK inline factories 加载；配置变化复用空闲资源 reload，运行中等任务结束。旧 `conversation-features.json`、`personaScopes`、`memoryScopes`、`memoryEnabled` 不读取、不迁移、不删除数据。
- 仅使用 `$PIG_DIR/persona/{SOUL.md,USER.md,mood-state.json}`，目录 0700、文件 0600，路径延迟解析；不读写 CLI 人格文件、不读取 IDENTIFY.md，也无本机 Pi 导入入口。
- `src/shared/persona.ts` 是 IPC 唯一契约，只接受所属 UI 主 frame；记忆设置另走 `memory:*` IPC 和 `conversation-features:changed`。
- 人格页签右侧提供「灵魂」「关于你」按钮，点击才显示 Dialog 编辑器。保存成功关闭、失败保留草稿，未保存关闭需确认，保存期间禁止关闭。文件保存按固定文件名、SHA-256 revision 逐个原子替换，冲突不覆盖。

## 系统前缀与动态快照

- 人格模块自身不注册模型工具、slash 或 TUI，通用设置工具的心情修改仍走 [应用设置](settings.md)。
- `preamble.ts` 统一身份前缀；preamble 是唯一不包 XML 标签的系统章节。SOUL 非空且激活时注入稳定人格、语言规则、行为边界、日期、SOUL 路径与正文、演化规则、USER 上下文及快照解释；不编造感知或工具结果，被认真询问身份时不否认实际身份。
- SOUL 为空或未激活时，由 `src/main/pi/pig-identity.ts` 提供默认身份、日期及存在时的 USER；不设置名字，主人取系统用户名，平台按系统确定。仅在 preamble 未写入时生效，与扩展顺序无关。
- 设置了 `customPrompt` 时，两条身份注入路径都不写。日期每轮按本机时区生成，跨天只产生一次章节补丁。
- 固定人格和 USER 通过 `systemPromptOptions.sections.preamble` 注入，不能返回 `systemPrompt` 强制改写前缀；相关 SDK 补丁见 [SDK 维护](sdk-maintenance.md)。该强制提示不写入会话导出。
- 动态心情用隐藏 `persona-mood` custom message 追加到本轮消息末尾，以 user 角色进入上下文，不伪造 assistant 消息，不改写历史或系统前缀。
- 快照只有一行程序生成的相对人格风格描述（如 `[Expressive tone, relative to your personality: slightly warmer, steady, rested]`）；不含数值、时间戳或观察员自由文本。固定规则在 preamble，声明由 Pig 插入、只认最新一条、不宣告心情。
- 心情只影响措辞，不能改变执行、准确性、工具、验证、权限和安全；用户要求和稳定人格优先。
- 每次任务开始通过 SDK `buildSessionProjection()` 检查当前分支有效上下文，只有内容变化或快照被压缩／上下文编辑移除才补发。不能依赖内存里的“已发送”标记。
- `session_compact` 溢出重试或已有排队续跑不再触发任务开始，需 steer 补齐丢失快照；普通压缩不排消息或另启轮次，等下次任务开始补齐。

## 全局状态与并发

- 全应用共用一份表达状态：愉快度 −1…1、激活度／精力 0…1、仅展示的当前感受。各会话仅独立维护后台观察窗口；不恢复八情绪轮盘或关键词／工具成败推力。
- 读改写经磁盘锁串行，每次从最新状态重建引擎，main 与 jiti 实例不能各持心情真相。只读不加锁、不写盘，仅确有变化才保存；无主锁目录和 recovery 目录超过 30 秒可回收。
- 愉快度／激活度按约 60 分钟半衰期回归 0.15／0.35。观察员每维输出 −2…2 整数相对步长，每步 0.12，结果钳制。
- 精力工作四小时减 0.5、空闲两小时恢复 0.5；重叠任务只计一次，不自动睡眠。活动租约结束／reload 释放，长任务定期续租，过期与旧宿主 PID 不计工作。
- 关闭自动变化冻结情绪和精力，手动设置仍生效。`mood-state.json` v3 严格校验 v2 后映射，仅读不迁移，下一次显式变更原子保存。
- JSON／YAML／IO 错误抛出，不能重置默认或降级；只允许 YAML frontmatter，禁止 gray-matter 可执行引擎。
- Agent 自行编辑 SOUL 末尾 `## Evolved Traits` 是唯一不加锁、非原子写入，不能改核心段落；并发读取可能让一轮拿到不完整内容。
- 运行模块进入 main bundle，不复制源码到 extraResources；记忆上游 LICENSE 仍随包附带。

## 情绪观察员

- `src/main/features/persona/observer.ts` 是无工具、单次请求的后台 worker；通过宿主 modelRegistry 鉴权与 composed streamSimple 调用，不启动主 Agent。
- 默认继承会话模型但不继承思考强度，不传 reasoning；可选独立模型及 off／minimal 等支持档位，只有自选模型的显式强度经 SDK clamp 后传入，off 省略。恢复默认同时清除模型与强度。
- SOUL 正文前 1500 字附在固定 system 末尾，内容不变时留在缓存前缀；启用 reasoning 为其预留输出预算，思考过程不作观察输入。
- `conversation.ts` 只取投影中的用户消息和无工具调用的最终回复：附件省略为元数据，代码替换占位符，过滤引用，长文保留头尾，不改原文。失败／中止保留用户消息并标记回复，不能配给后续回复。
- 累积三轮或尾批等待 60 秒触发，两次至少间隔 60 秒，同会话单飞，失败批跳过、30 秒超时，不做关键词降级。
- 固定 system 与逐条追加的裁剪对话保留缓存，动态分析范围放末尾；每批最多六轮。窗口预算取 8K 或模型上下文 25% 的较小值，按 UTF-8 字节保守估计并预留输出，换窗保留两轮背景。
- reload／切分支不重放已完成轮次，关闭时取消。手动设置或开关变化通过 `controls.ts` 的 globalThis 通知立即取消观察，control revision 再阻止迟到结果覆盖。

## 观察员用量

- `usage.ts` 为每次实际请求通过 onUsage 追加一行 `persona/observer-usage-YYYY-MM.jsonl`，UTC 月份、0600、O_APPEND、不加锁，不保存对话文本。
- 记录模型、强度、轮次数、预算估算、SDK usage／cost、耗时和 changed／unchanged／invalid／error／timeout／aborted；超时和中止无 usage，未发出的请求不记。写入失败只告警。
- 唯一 UI 入口是人格页「观察员用量」只读弹窗。`persona:observer-usage` 由 main 汇总，renderer 拿不到逐条记录；未换行尾行视为写入中跳过，其余坏行报错。
