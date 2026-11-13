# 架构、会话与数据边界

修改 runtime、会话投影、IPC、数据持久化或打包边界前阅读。功能级规则由对应专题维护。

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

## 会话事实与生命周期

- 会话真相在 `~/.pi/agent/sessions/` 的 JSONL。
- UI 状态跟 Pi messages/turns，不要另做一套扁平 ChatMessage。
- 普通会话通过 `createSessionRuntime` 构造，注册与释放由 `src/main/pi/session-registry.ts` 及会话生命周期模块协调；内置功能的状态归属和清理见对应专题。

## 数据目录与 SDK 文档注入

- Pig 自己的数据：开发时 `cwd/.pig`，打包后 `$HOME/.pig`，`PIG_DIR` 作为最高优先级覆盖（启动方式见根 [AGENTS.md](../AGENTS.md)，开发时不要带上它）。
- Worktree 在该目录下 `worktrees/<项目名>/<uuid>`，同名项目撞目录时才加路径哈希；重命名只改 Git 分支，不改目录。
- pi 登录态读 `~/.pi/agent/auth.json`。
- 所有会话（含 Chat 与子 agent）经 `createSessionRuntime` 加载 `src/main/pi/pig-docs.ts`（辅助 loader 不带），用同名自定义章节原位替换 SDK 的 `docs`：先说明本实例实际的 Pig 数据目录、与 pi CLI 共用的文件（auth、sessions、skills、settings.json 的默认模型／思考强度／`modelThinkingLevels`／`enabledModels`）及被忽略的 pi packages/extensions，安装版再提示 asar 内文档只能用 read 工具读，后面接 SDK 原文；路径不变时文本不变，不产生补丁。
- SDK 的默认 docs 文本从 `event.systemPrompt` 截取，缺失（且未设 customPrompt）时直接报错；新增 Pig 自有数据文件或共用文件时同步更新该说明。

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
| `src/main/pi/plugins.ts`             | 内置 / 第三方插件注册表、启用状态与打包路径（不含人格／记忆）                             |
| `src/main/pi/web-search-settings.ts` | 内置 pig-web 的配置读写（`$PIG_DIR/web-search.json`，权限 0600）  |
| `src/main/skills/`                  | 个人 Skills 清单、本地引用、远程副本与手动更新、启停偏好及 skills.sh 搜索 |
| `src/main/subagents/`               | 子 agent 的排队、上限、生命周期、结果投递与落盘；执行器接口与同进程 SDK 实现 |
| `scripts/build-system-plugins.ts`    | 用 esbuild 将 pig-web 打成单文件到 `out/system-plugins/pig-web/`           |
| `src/renderer/src/ipc/api.ts`        | renderer 的接口入口，复用共享类型                                       |
| `src/renderer/src/lib/highlight.ts`  | Shiki 高亮（WASM 引擎、按可见性触发、LRU 缓存）                         |

新增跨进程字段时先改共享契约，再改 main 的生产端和 renderer 的消费端。
不要在 preload 声明、renderer 或 main 各复制一份接口。

main 向 UI 发起的浏览器、终端和会话控制请求共用 `src/main/ipc/pending-reply.ts` 的请求生命周期：统一清理超时、取消、发送异常及已结算请求。各 IPC 模块仍持有自己的 pending 清单，校验 UI 主 frame、窗口／会话实例、资源归属和应答内容，并在窗口重载／关闭时拒绝所属请求；公共工具不代替这些授权检查。

## 文件修改记录

- `src/main/pi/session-file-changes.ts` 从当前分支的原始 JSONL 条目累计成功的 edit／write 操作，不等同于 Git 净差异，不读取文件当前内容来重建历史。bash／终端脚本造成的修改目前不在记录范围内；不能解析命令文本猜测差异，也不能拿当前 Git 状态冒充本轮历史。
- 直接调用使用 toolResult 的 `details.patch`／`diff`。嵌套调用由 `session-file-change-records.ts` 在工具完成时捕获最终结果，将操作 ID、最外层调用 ID、实际路径和差异写入 `pig-file-change-v1` custom entry；只存文件操作证据，不存任意子工具结果，也不进入模型上下文。
- 这些条目跟随会话分支持久化，不依赖 SDK 有界 nestedCalls 是否保留参数；聚合时与 nestedCalls 去重。父脚本之后失败或未留下结果，不抹掉已经成功的文件操作。已识别的 `pig-file-change-v1` 记录校验失败时抛出 `ERR_INVALID_FILE_CHANGE_RECORD`，不静默忽略或返回貌似完整的统计。
- write 只记录本次写入内容，沿用整份内容计为新增的语义，不推断被覆盖的旧内容。旧会话未记录的 edit 差异继续显示不可用，不用当前 Git 状态或替换参数补造。

## 会话树与分支切换

- 会话树左键点击节点直接跳转（不总结），右键菜单提供「直接跳转 / 总结并跳转 / 自定义提示词总结」，只有自定义提示词会弹出输入框。
- 总结走 SDK `navigateTree`（summary 接在 Pi 自己选的叶子上，不再按轻量恢复重新 branch），不总结保留原轻量切换；两者都复用 `restoreSessionUserPrompt` 恢复图片与粘贴附件。
- main 用 `isNavigatingSessionBranch` 在准备会话前占位，prompt、bash、手动压缩入口都会拒绝；renderer 的 `isNavigatingBranch` 覆盖请求到目标分支 hydrate 完成，期间输入框禁用、树对话框不可关闭并显示进度，总结可经 `abortBranchSummary` 停止，取消结果保留当前分支与草稿。

## 回复书签

- 回复书签是 UI 功能，不使用 Pi 的会话树 label，也不进入模型上下文。
- `src/shared/bookmarks.ts` 是唯一 IPC 契约；main 的 `BookmarkStore` 将会话引用、turn ID、稳定的 assistant 回复 entry ID 与短预览保存到 `$PIG_DIR/bookmarks.json`（0600），严格读取、串行原子写入，坏文件不能覆盖。
- 书签身份使用 `DisplayTurn.replyEntryId`，不使用会被追加压缩／总结改变的 `lastEntryId`；后者仍用于保留完整 turn 的分支操作。
- 书签只接受所属 UI 主 frame 对已持久化回复的操作，内容由 main 从会话投影读取，不接受 renderer 提供回复正文。
- 顶部书签弹层汇总全部聊天，当前聊天优先分组；回复复制按钮前可切换书签，已收藏图标实心且回复轻微高亮。
- 点击列表先打开原会话；目标回复仍由当前分支展示时不导航分支，否则复用 `viewBranch` 到保存的 assistant entry，忙碌时拒绝换分支。
- 定位复用历史分页与 MessageScroller 的显式跳转，不另建滚动状态机；renderer 用持久化 revision 拒绝迟到快照覆盖。
- 原会话已删除时显示定位错误，仍可手动移除书签。

## 手动压缩

- 手动压缩不再是斜杠命令，入口在输入框的上下文用量弹窗：用量数字右侧「压缩」直接压缩，下拉箭头展开自定义压缩说明。
- 会话运行中（Pi 的 `compact` 会中止当前任务）、切换分支中、已有压缩（含自动压缩）进行中或尚无上下文时禁用并用 tooltip 说明原因；压缩失败由 Pi 的 compaction 事件显示在对话中，弹窗只显示 IPC 拒绝。
- 进度条标出自动压缩阈值：`SessionContextUsage.autoCompactAt` 由 main 按 Pi `getCompactionSettings(model)` 计算（窗口减 `reserveTokens`，关闭自动压缩时为 null），live 会话用自身的 settingsManager，未构建会话用全局设置。

## 相关入口

- 会话控制及其审批委派见 [会话控制](session-control.md)。
- 模型和 Review 偏好见 [应用设置](settings.md)。
- 插件、工具分组及子 agent 见 [插件](plugins.md) 与 [子 agent](subagents.md)。
- 浏览器／终端标签恢复与分屏布局见 [工作区](workspace.md)。
- `electron-builder` 只打包 production dependencies。第三方依赖按运行时 external 加载需求分区；renderer 依赖由 Vite 打包，放入 `devDependencies`，不能因被 import 就归入 production。原生 PTY 的例外见 [终端](terminal.md)。
