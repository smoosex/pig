# Plugins

Pig runs Pi extensions in ordinary project sessions only. Chat sessions and branch-naming workers remain extension-free. Plugins execute with main-process permissions: install only sources you trust. The plugin list and npm/Git installs live under Pig's data directory, not Pi CLI's package registry. Local paths are used in place. Pi CLI extensions and packages are never installed or executed by Pig just because they appear in Pi settings. Enabled plugins load on the next session start; idle live sessions reload automatically, while active sessions reload when work finishes.

Open **Settings → Plugins** to enable the bundled Observational Memory extension or install a local directory, an `npm:package[@version]`, or a `git:URL`. User-installed plugins start disabled. Disable a plugin before uninstalling it. Updating or uninstalling a package while a plugin session is busy is blocked.

Observational Memory is maintained in Pig at `src/main/plugins/observational-memory/` (adapted from the local pi-observational-memory source through #81, MIT license). Its slash commands and terminal-only renderers are omitted; open the context-usage popover and use **Memory status** or **View memory** for dialog views. The view supports visible and full history. Memory settings are global to Pig only: use the built-in plugin’s settings button to edit `PIG_DIR/plugins/observational-memory/settings.json` (dev default: `./.pig`, packaged: `~/.pig`). Pig never reads Pi CLI's memory settings or `PI_OBSERVATIONAL_MEMORY_PASSIVE`. Changes reload idle project sessions (or wait until they finish); chat sessions are unaffected. The built-in plugin can be disabled, not uninstalled.

The one Pig setting read from Pi CLI is `compaction.enabled` (global, then project scope): with Pi's automatic compaction off there is no backstop for a stalled observer, so the proactive trigger counts raw source tokens instead of observed ones and the compaction hook labels the metric accordingly.

Background observer, reflector, and dropper tasks are cancelled on session shutdown or reload. Late results are discarded before accessing session state or writing memory, and normal cancellation does not produce a worker-failed notification. Memory already written to the session remains intact.

Pig does not adapt Pi extension UI or terminal TUI. Extensions run with `ctx.mode === 'rpc'` and `ctx.hasUI === false`; Pig does not supply a `ctx.ui` implementation. Third-party tools, commands, events, and custom messages still work, but their `ctx.ui` notifications, dialogs, widgets, and terminal renderers do not appear in Pig.

The built-in plugins use Pig-owned surfaces instead:

- **pi-review** uses a dedicated command panel with searchable, keyboard-selectable rows, separate descriptions, a recommended option, and in-panel PR/path/instruction inputs. The current session has its own review indicator. Selection responses use option IDs rather than displayed text.
- **Observational Memory** sends session-scoped, non-blocking notifications through Pig's private system-plugin channel. Memory status and history keep their existing context-popover entry points. Worker cancellation remains tied to session shutdown.
- **pi-web-access** has no terminal UI to migrate. Its tool results and background-fetch messages remain in the conversation; no extra activity widget or generic plugin dialog is installed.

System notifications are shown only for the active session and expire eight seconds after receipt, including while a session is inactive. Pig retains at most five notifications per session and twenty across the window, dropping older notices first. Switching sessions does not renew their lifetime. Long messages never open a modal automatically; their notification has an explicit details action that consumes the notice while keeping its full text open. `src/main/plugins/pig-ui.ts` shares the system-plugin host registry across the SDK's jiti loader and Pig main, while `src/main/pi/system-plugin-ui.ts` owns pending review requests and window-bound replies. These are Pig implementation APIs, not a third-party `ctx.ui` compatibility layer.

Keep extension imports to Node builtins and Pi packages (`@earendil-works/*`, `typebox`), which the loader aliases to the packaged app. Host modules such as `electron` resolve in development but fail to load from packaged resources, so extensions must not import them.

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
