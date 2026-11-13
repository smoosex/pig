# SDK、schema 与本地补丁

升级 Pi SDK、schema、依赖补丁或独立 TS 插件的加载方式前阅读。

## Pi SDK 补丁清单

- Pi SDK 当前固定为 1.5.0，直接依赖 `pi-ai` 同步固定为 1.5.0。
- `patches/@earendil-works%2Fpi-coding-agent@1.5.0.patch` 保留六项上游尚未合入的改动：允许自定义 `preamble` 而保留默认 tools/rules/docs；MCP HTTP 传输、OAuth 登录及刷新统一注入宿主 `fetch`，并等待异步 `openUrl` 以传播打开失败；从包入口导出 `resolveModelScopeFromModels`（含类型声明）；扩展 `ToolDefinition`／`defineTool`／`registerTool` 的参数推导改用 pi-schema 的 `Static`（继续兼容 SDK 内部 TypeBox schema）；jiti 增加 `pi-schema` 与 `pi-schema/formats` 的宿主入口 alias，确保独立 TS 资源可加载；`PromptOptions.beforeStart` 在异步输入/鉴权预检后、`_startRun` 前同步执行宿主门控，抛出即拒绝，不留下 busy 状态或启动压缩。
- `tests/sdk-preflight-patch.test.ts` 以真实 SDK 阻塞输入/鉴权验证取消后零运行/请求/工具执行。
- 插件注册、子 agent 排除和权限来源验证统一用 `system-plugin-paths.ts` 的 `sessionToolPath`，不能复制路径实现。
- 升级 SDK 时逐项核对，不能只迁移 preamble 补丁；`tests/sdk-schema-patch.test.ts` 守护原生 schema 的类型推导和脱离项目目录的插件加载。

## 工具 schema 与严格校验

- 项目工具 schema 与严格校验统一使用 `@earendil-works/pi-schema@1.5.0`（直接开发依赖，main 的使用会打入 bundle，插件走 SDK alias）；不再直接依赖 TypeBox，但 SDK 内部仍保留它。
- 原本默认开放的 TypeBox 对象迁移后显式使用 `obj(..., { open: true })`，设置等原本关闭的对象使用 `obj` 默认关闭。
- 扩展 SDK shell schema 时保留原根字段、properties 与 required，只追加可选属性；不能将 TypeBox 的 properties 塞进原生 `obj`，否则旧 optional 标记会失效。
- SDK 默认会转换参数，`settings_update.prepareArguments` 必须用不启用 coercion 的 `compile(...).check(...)` 在转换前严格校验原始写入，不能让字符串转数组等行为放宽设置契约。

## 消息滚动补丁

- `patches/@shadcn%2Freact@0.3.1.patch` 为固定版本的组件补充显式暂停、偏移恢复、
状态读取及显式消息锚定。
- 修改它时同步更新 `tests/message-scroller.test.ts`，
不要在业务组件外另建一套自动滚动状态机。

## 身份前缀回归

- preamble 实现见 `src/main/features/persona/preamble.ts`；唯一不包 XML 标签的系统章节由 SDK 补丁放行，`tests/sdk-preamble-patch.test.ts` 守护。不能因升级丢失这项补丁而强制重写整个系统前缀。

## 插件与构建边界

- `tsconfig` 开启 `allowImportingTsExtensions`，vendored 插件保留 `.ts` 后缀 import。
- 独立 TS 插件只能依赖宿主 alias 提供的 Pi/schema 入口和允许的 Node 内置模块；共享契约尽量使用 type import，不从外部资源直接导入 Electron 或项目运行时模块。
- `sessionToolPath` 是内置插件路径、子 agent 排除和权限来源验证的统一入口；新 host bridge 与插件目录需同步 `extraResources`。
- sandbox preload 必须独立打成单文件，不能拆出需要本地 `require` 的公共 chunk，详见 [浏览器](browser.md)。
- 包管理、验证命令和测试进程规则统一见根 [AGENTS.md](../AGENTS.md)。
