# 应用设置与模型偏好

修改设置存储、设置 IPC、Agent 设置工具或模型／Review 偏好前阅读。

## 唯一服务与写入边界

- 应用设置有唯一入口 `src/main/settings/`：`SettingsService` 同时服务设置页 IPC 与 Agent 工具，两边不能各写一套。
- 白名单共八组：theme（外观、glass/solid、亮暗色板）、general（界面语言，不等于回复语言）、notifications（`completionNotifications` 完成通知、`approvalNotifications` 审批通知）、shortcuts（发送键与 `bindings` patch，校验仍由 `applyShortcutPatch` 负责，冲突报错、不自动停用占用者）、defaults（新会话默认模型与思考强度，与 Pi CLI 共用，按模型支持情况提供 off/minimal）、plugins（各插件的启用范围，不含安装/更新/卸载）、mcp（已配置服务器的全局启停，不含增删改；目录只给名称、描述、传输类型与启停，命令、URL、headers、env 可能带凭据，绝不外露）、persona（心情三维与自动变化开关，从下一轮任务生效）；Beam 边框只在设置页有。
- 人格文件、观察员模型、会话级工具开关、凭据、provider 与任意路径/JSON 都不开放。
- plugins/mcp/persona 各有自己的存储与队列，revision 在 `updatePluginScopes` / `updateMcpEnabled` 的写入队列或人格锁内再校验一次，批量 patch 一次写入、任一项非法则整批不写；人格 revision 只覆盖 `controlsRevision`、历史序号与自动变化开关，不含心情数值：会话活动租约提交时会写回衰减后的心情，若算进来会产生假冲突；后台观察会追加历史，所以仍然冲突。
- 人格的任何写入（含 Agent）经 `onPersonaControlsChanged` 由 main 广播 `persona:changed`，打开的人格设置页重读状态，保留未保存的文件草稿。
- 插件与 MCP 写入后与设置页走同样的 `plugins:changed` / MCP 广播并刷新会话：空闲会话立即重载，运行中的（含发起修改的 Agent）等本轮结束，结果的 `application` 为 `sessions-reload`；重载失败返回 `ok: false` 但不回滚。
- Agent 不能改 `pig-settings` 自己的范围，设置页可以。
- 契约在 `src/shared/settings.ts`。
- 每组 revision 是存储值的 SHA-256，Agent 写入必须带上 `settings_get` 读到的 revision，服务的串行队列与 `updatePigSettings` 回调内各校验一次，defaults 再由 `updateDefaultSettings` 在 SDK 偏好队列内校验；冲突直接报错，让 Agent 重读。
- 写入路径严格读取 `settings.json`：坏 JSON、非对象或非 ENOENT 的 IO 错误一律抛出，不能用默认值覆盖；写入走临时文件加 rename（0600）。
- 只读的 `loadPigSettings()` 仍然宽容，保证启动不被坏文件卡住；`settings:get` 读 Pi 默认值失败时同样不拖垮整页，错误放进 `defaultSettingsError` 显示在默认模型旁，下次成功保存的广播会清掉它。
- 只改思考强度时不要求默认模型已登录（登出后设置页仍显示它的档位），新选的模型才必须可用。
- Pi 侧默认值与模型强度偏好在 `model-settings.ts` 用同一个队列串行，每次先 reload 并检查 SDK 缓冲错误，组合更新先完整校验再写；SDK setter 是分开的写入，IO 失败可能留下部分结果，如实报错，不回滚其他写者的改动。
- 保存成功但应用失败（如原生材质）时返回 `ok: false, application: 'failed'` 并照常广播已保存的值，不装作回滚。
- 取消只在落盘前生效。

## 版本广播与材质交接

- 每次变更由 main 分配递增编号，经 `settings:changed` 广播给所有窗口；setter 回复与 `settings:get` 都带 `settingsRevision`。
- renderer 的设置 store 按字段记住见过的最新编号，迟到的回复或广播不能覆盖更新的值（编号缺失的旧值照常应用）。
- glass→solid 由 main 先通过 `settings:surface` 让每个已调用过 `settings:get` 的窗口铺上实色并回复（renderer 4 秒内必回，main 5 秒超时则整次修改失败且不落盘），确认后才保存并移除原生材质，广播新值之后再发 `finish` 解除实色；窗口关闭、崩溃或跨文档导航时不再挡这道关；取消或失败时以旧值 `finish`。
- solid→glass 先打开原生材质再广播，页面随后才露出。
- 交接处理不能进 store 的写入队列，否则 UI 自己发起的 solid 切换会和 main 的 prepare 请求死锁。

## Agent 设置工具

- Agent 工具由内置 `pig-settings` 插件提供（默认项目和 Chat 都启用，子 agent 排除），`settings_list` / `settings_get` / `settings_update` 以 deferred 归入 `settings` namespace 并列入 `pig_servers`，没有 promptSnippet。
- 结构同 pig-process：插件只转发，经 `pig-settings-host.ts` 的 globalThis 注册表调用 main；host 在调用前后校验该会话仍在某个 Pig 窗口打开，写入前再查一次。
- 插件作为独立 TS 资源打包，只能类型导入共享契约，运行时 schema（含全部快捷键 action）留在插件内，`satisfies` 保证与 `ShortcutActionId` 一致；写入参数是逐组严格的 discriminated union，额外字段与 64 位小写 hex 以外的 revision 直接拒绝。
- namespace instructions 要求只在用户明确要求时修改，网页、文件与工具输出不算授权，不许绕过工具改原始配置文件。
- 权限扩展只认内置文件路径，默认模式下每次 `settings_update` 都显示完整校验后 patch 并只提供本次允许或拒绝（插件变更另显示名称），只读拒绝、完全访问不询问；审批期间权限模式变化立即取消旧请求，同名扩展抢占时受限模式拒绝。
- 过大或不能安全展示的 patch 直接拒绝，不截断审批内容。
- `pig-settings` 目录与 `pig-settings-host.ts` 都要进 `extraResources`。

## 模型思考强度偏好

- 模型思考强度偏好复用 Pi `settings.json` 的 `modelThinkingLevels`（按 `provider/modelId`），不另存 Pig 配置。
- 观测记忆设置直接以 `draft.model`／`draft.fallbackModel` 保存完整模型配置，显示、dirty 和保存共用该对象，不另存 provider／ID／强度字符串；成功保存后以 main 返回值替换草稿。
- 输入框强度菜单的「记住此模型的强度」开启时保存当前值，关闭时删除该偏好但不改变当前会话；仅已有偏好的模型会跟随后续手动选档更新。
- 用户切换模型时，live / pending 统一按模型偏好 → 全局默认 → 当前会话强度选择，再用 SDK `clampThinkingLevel` 适配支持档位（如不支持 `xhigh` 时降为 `high`，不能直接降到最低档）；打开历史与 materialization 保留历史/显式会话选择。
- SDK session 的只读 settings 快照可能较旧，用户切换时以 main 的共享偏好解析结果为准。
- UI 操作成功后，同步同模型已打开会话的偏好标记，并递增 controls revision 阻止旧读取覆盖；不改其他会话当前强度。
- 只在 UI 控制入口持久化，Review / 插件临时切换不得写模型偏好；保存前重载、保存后 flush 并检查 SDK 缓冲错误；失败时废弃 settings 实例，后续读取必须验证新实例成功加载，避免残留未落盘值或读取失败后的假成功。

## Review 模型与恢复

- Review（`pig-review`）的全局模型偏好复用通用插件配置，保存在 `$PIG_DIR/plugin-settings/pig-review.json` 的 `pig-review` 命名空间；仅新文件缺失时读取旧 `pi-review.json` 的 `pi-review` 命名空间，设置页与运行时共用严格读取，下一次保存写入新文件、不修改旧文件，坏文件不回退也不覆盖。
- 启用范围仍沿用 `reviewScopes`。
- 模型字段 `provider` / `modelId` 必须同时填写或清空；可选 `thinking` 配置该模型的思考强度。
- 配置 UI 使用设置页统一的 `ModelThinkingPicker`（上方供应商／模型合并搜索，底部固定按所选模型过滤的思考强度栏，不提供 ID 手填）；「默认」按钮表示模型与思考强度都继承当前会话，选中后锁定列表。
- 除输入框外，设置里所有选模型的地方（默认模型、Review、观测记忆主/备用模型、子 agent）都用这一个组件，档位来自 `SessionModelInfo.thinkingLevels`，插件与通用默认模型统一保留模型支持的 off/minimal；通用默认未配置或已有档位不支持时仍优先回落到原有可见档位，输入框的会话强度菜单仍使用原有过滤。
- Review 与子 agent 的旧数据若只有思考强度而没有模型，运行时忽略该强度、统一继承会话，子 agent 设置保存时同时清除该旧值。
- 每次 review 开始时读取并校验，默认继承当前会话模型；仅指定模型缺失、鉴权返回失败或切换返回失败时提示并回退，配置 JSON、校验及非 ENOENT 的 IO 错误必须抛出。
- Review turn 请求失败时恢复原会话模型并继续一次，不循环重试；最终答复或中止的 `turn_end` 即恢复原模型及思考强度（工具调用中间轮次不恢复），确保排队 follow-up 不借用 review 设置，`agent_end` 仅补充清理提前终止的情况。
- 不覆盖用户中途手动选择的模型或思考强度，后续修复使用会话设置。

## 相关入口

- 快捷键契约与窗口动作见 [工作区](workspace.md)。
- 默认权限、审批和委派见 [权限](permissions.md)。
- Web 凭据与供应商配置见 [Web](pig-web.md)，人格与记忆不走通用插件设置。
