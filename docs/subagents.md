# 子 agent

修改 `src/main/subagents/`、pig-subagent、子任务审批、结果投递或关闭清理前阅读。

## 工具、宿主与生命周期

- pig-subagent 注册 `spawn({ title, prompt, background })` 和 `subagent_restart({ id, instruction? })`：后者仅显式恢复当前父会话中已结束但未完成的任务，复用原 ID 与 JSONL，后台发送继续指令并提醒检查中断操作；缺少原始记录时明确报错，运行中或已完成任务不可重启。
- 失败通知要求主 agent 自行判断，不自动重试；模型输出因长度截断不能算完成。
- 分两层：`src/main/plugins/pig-subagent/` 是 jiti 加载的扩展，只负责工具和用 `pi.sendMessage({ triggerTurn: true, deliverAs: 'steer' })` 投递后台结果（父会话空闲时开新一轮，运行中在本批工具结果后插入）；子会话由 main 的 `src/main/subagents/` 构造，两层经 `pig-subagent-host.ts` 挂在 globalThis 上的注册表连接（与 `pig-ui.ts` 同理，打包时两者都要进 `extraResources`）。
- 子 agent 与父会话同进程，用 `createSessionRuntime` 复用父会话的资源加载，只有干净上下文，排除人格、文件记忆与自身（不能递归），不绑定普通扩展 UI，prompt 不做模板展开；仅权限审批经专用 select 转发到父会话，卡片显示子 agent 标题和 ID，并说明会话授权由主 agent 与其他子 agent 共用。
- 子 agent 独立生命周期信号覆盖异步启动和审批，停止、超时及关闭父会话立即取消请求，父窗口／会话实例变化和迟到回复不能生效；父资源重载不取消后台子 agent 的审批。
- 子 agent 启动时快照继承父会话的工具与 MCP 开关，工具工厂拦截与 SDK 工具可见性都应用该快照，并强制禁用 `spawn`；Skills 仍按自身默认配置加载，运行中的子 agent 不跟随父会话后续开关变化。
- 扩展的 `session_shutdown` 在资源重载时也会触发，所以只解除投递；中断子 agent 由 `disposeLiveSession` 负责（关闭标签、删除会话、退出时都标为 `interrupted`，不恢复）。
- 用户点停止只会中止前台子 agent（它是父会话这一轮里的工具调用），后台的继续运行。
- 头像从 Lucide 动物图标中随机分配，同一父会话大轮（`agent_start` 时最近的用户消息 entry id）内优先不重复；动物与主题 `chart-*` 颜色索引随子 agent 记录持久化，旧记录按 id 稳定回退。
- 记录在 `$PIG_DIR/subagents/<父会话 id>/`（`index.json` 加各子会话 JSONL），配置在 `$PIG_DIR/subagent-settings.json`。
- 新记录保存父会话 JSONL 路径，启动时清理父文件已不存在的子 agent 目录（缺少路径的旧记录保留）；清理结束前暂停加载索引及 spawn，避免和索引修复写入竞争。
- 关闭父会话会等待最终索引落盘，删除目录不会被迟到的写入重建。

## 与其他会话能力的边界

- `createSessionRuntime` 复用资源加载，但子 agent 是干净上下文，排除人格、文件记忆、自身以及要求窗口宿主的浏览器／终端等内置插件；具体排除统一走插件路径选择，不复制实现。
- 权限上限和会话授权共享见 [权限](permissions.md)；普通独立会话不是子 agent，见 [会话控制](session-control.md)。
- 父会话首次 idle 不等于受控任务完成；最终索引写入、报告投递及父续跑也属于任务完成边界。
