# Plugins

Pig runs Pi extensions in ordinary project sessions only. Chat sessions and branch-naming workers remain extension-free. Plugins execute with main-process permissions: install only sources you trust. The plugin list and npm/Git installs live under Pig's data directory, not Pi CLI's package registry. Local paths are used in place. Pi CLI extensions and packages are never installed or executed by Pig just because they appear in Pi settings. Enabled plugins load on the next session start; idle live sessions reload automatically, while active sessions reload when work finishes.

Open **Settings → Plugins** to enable the bundled Observational Memory extension or install a local directory, an `npm:package[@version]`, or a `git:URL`. User-installed plugins start disabled. Disable a plugin before uninstalling it. Updating or uninstalling a package while a plugin session is busy is blocked.

Observational Memory is maintained in Pig at `src/main/plugins/observational-memory/` (adapted from the local pi-observational-memory 3.1.3 source, MIT license). Its slash commands and terminal-only renderers are omitted; open the context-usage popover and use **Memory status** or **View memory** for dialog views. The view supports visible and full history. Settings are global to Pig only: use the built-in plugin’s settings button to edit `PIG_DIR/plugins/observational-memory/settings.json` (dev default: `./.pig`, packaged: `~/.pig`). Pig never reads Pi CLI's memory settings or `PI_OBSERVATIONAL_MEMORY_PASSIVE`. Changes reload idle project sessions (or wait until they finish); chat sessions are unaffected. The built-in plugin can be disabled, not uninstalled.

Extensions can use `ctx.ui.notify`, `setStatus`, `setWidget`, and `select`/`confirm`/`input`/`editor` dialogs. Pig does not provide a terminal TUI: `ctx.mode` is `rpc`; terminal-only widgets, themes, custom TUI, and editor manipulation are unavailable. Extensions should test `ctx.mode === 'tui'` before using terminal APIs.

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
