# Plugins

## Loading and ownership

Pig manages plugins by `project` / `chat` scopes; [] disables a plugin. Saved scopes win over changed defaults. Plugins execute with main-process permissions: install only trusted sources. Pig owns its registry and npm/Git installs; Pi CLI packages and extensions are not loaded merely because they appear in Pi settings. Local paths are used in place. Idle sessions reload resources immediately, while active tasks finish first. Auxiliary runtimes and child agents use their own explicit loadouts.

Open **Settings → Plugins** to manage extensions or install a local directory, an `npm:package[@version]`, or a `git:URL`. User-installed plugins start disabled. Disable a plugin before uninstalling it. Updating or uninstalling a package while a plugin session is busy is blocked.

Persona and Observational Memory are built-in conversation features, not plugin entries. See [Persona](persona.md) and [Memory](long-term-memory.md); their reload path is independent of the plugin path allowlist.

Ordinary sessions bind extensions in `rpc` mode with Pig's `createExtensionUI` in `src/main/pi/session-registry.ts`. Dialog and approval replies are window-bound; this is not a full terminal TUI compatibility layer. Extension-driven new-session/fork replacement is explicitly refused rather than reporting a fake success.

## Built-in plugins and UI

- **pig-review** uses the private command panel and per-session indicator. Model selection, validation, fallback and restoration have one authoritative description in [Settings](settings.md).
- **pig-web** provides web_search / web_fetch / web_read. See [Web](pig-web.md).
- **pig-browser**, **pig-terminal**, **pig-process**, **pig-settings**, **pig-session** and **pig-subagent** use thin registration layers plus host bridges. Read the matching module document before changing their tools or lifecycle.

System notifications are shown only for the active session and expire eight seconds after receipt, including while a session is inactive. Pig retains at most five notifications per session and twenty across the window, dropping older notices first. Switching sessions does not renew their lifetime. Long messages never open a modal automatically; their notification has an explicit details action that consumes the notice while keeping its full text open. `src/main/plugins/pig-ui.ts` shares the system-plugin host registry across the SDK's jiti loader and Pig main, while `src/main/pi/system-plugin-ui.ts` owns pending review requests and window-bound replies. These are Pig implementation APIs, not a third-party `ctx.ui` compatibility layer.

## Scopes and tool grouping

- 内置系统插件默认范围：pig-review 与 pig-subagent 仅项目启用，pig-web、pig-settings 与 pig-session 项目和 Chat 都启用；已保存的选择不受默认值变化影响。
- 插件范围为 `project` / `chat`，可多选，空数组表示停用；旧版布尔配置迁移为仅项目。
- `enabledPluginPaths(scope)` 按会话类型过滤，并跳过缺失的内置文件，在设置页标出不可用。

- 会话能力面板的工具页按来源折叠分组：「内置」只含 Pi 自身工具（builtin 与 codemode / tool_search 等 inline），逐个开关；「Pig 插件」与「其他来源」每个插件只占一行、一个开关，名称取插件设置页的名字（`toolProvidersByPath`，未登记的扩展文件按文件名），分组身份使用插件注册 ID，未登记扩展使用完整路径，不能按显示名称合并同名插件。
- 插件行由 main 的 `groupPluginTools` 聚合，所有工具都启用才算开；会话偏好仍按工具名逐个记录，子 agent 与 `applySessionTools` 不感知分组。

## Packaged extensions

Keep runtime imports to supported Node builtins and SDK-aliased `@earendil-works/*` / `pi-schema` entries. Do not introduce TypeBox as the project schema API or import Electron directly from packaged TS resources. Shared contracts can be type imports; runtime bridges must be packaged. See [SDK maintenance](sdk-maintenance.md).

## Optional settings form for package authors

An extension may declare a settings form in its root `package.json`. The settings button appears on that plugin’s row. Fields are stored globally under `PIG_DIR/plugin-settings/<namespace>.json`, as a namespaced object; package authors must read that file themselves to use these values. Pig does not write Pi CLI's agent or project settings files. This is declarative metadata, not a renderer plugin API:

```json
{
  "pig": {
    "settings": {
      "namespace": "example-plugin",
      "fields": [
        { "key": "enabled", "label": "Enable feature", "type": "boolean" },
        { "key": "threshold", "label": "Threshold", "type": "integer", "min": 1, "max": 100 },
        { "key": "mode", "label": "Mode", "type": "select", "options": ["fast", "full"] },
        { "key": "prompt", "label": "Prompt", "type": "string" }
      ]
    }
  }
}
```

The namespace must be lowercase and hyphenated; only one installed plugin may claim it. Field keys must be alphanumeric identifiers. Unset fields use the extension's defaults. Pig preserves unknown keys in the same namespace and deletes the file on uninstall. Packages without this declaration can still request dialogs at runtime or manage their own configuration.
