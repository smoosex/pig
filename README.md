# Pig

Desktop GUI for the [pi](https://pi.dev) coding agent, built with Electron + React + Vite.

## Architecture

Three layers: main, preload, and renderer. Preload runs in an isolated context
inside the renderer process and exposes the permitted IPC methods.

```
renderer (React, sandboxed browser)
   ↕  contextBridge white-listed API (preload)
preload  (isolated context in the renderer process)
   ↕  ipcMain.handle / webContents.send
main     (Node, owns the pi SDK session)
```

Conversation sessions run in the main process. Branch naming uses a short-lived,
isolated Electron utility process with the pi SDK, no tools, and no saved session.
The renderer is sandboxed (`nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`) and reaches Node solely through `window.api`.

## Layout

```
src/
├── shared/      Serializable IPC contracts and shared data helpers
├── main/        Node + pi SDK
│   ├── index.ts        app entry, window creation
│   ├── window.ts       BrowserWindow lifecycle
│   ├── pi/             lifecycle, model settings, projections, event bridge
│   └── ipc/            invoke handlers + push channels
├── preload/     contextBridge API surface
└── renderer/    React UI
    └── src/
        ├── stores/     one Zustand session store, composed by responsibility
        ├── chat/       Pi event routing and message → turn projections
        ├── hooks/      React lifecycle adapters
        ├── ipc/        window.api wrapper
        └── components/ UI
```

See [code navigation and module ownership](docs/architecture.md) for the detailed
boundaries, data flow, and conventions.

## Develop

```bash
bun install
bun run dev
```

On macOS, `dev` signs the local Electron bundle once so system notifications work.
Allow notifications for Electron in System Settings if prompted. `build:mac` uses
ad-hoc signing for local builds; distribution requires a Developer ID signature
and notarization.

## Typecheck

```bash
bun run typecheck
```

## Build

```bash
bun run build:mac     # or build:win / build:linux
```

## Project Worktrees

The sidebar groups projects → worktrees/branches → sessions. Project `+` creates a
worktree from the original directory's current HEAD; each worktree's `+` creates a
conversation in that directory. Independent chats do not support worktrees.

New worktrees live at `<pig-dir>/worktrees/<project-name>/<uuid>`:
development uses `cwd/.pig`, packaged uses `$HOME/.pig`, and `PIG_DIR` overrides both.
A short path hash is appended only when two projects would share the same name;
metadata is stored at `<pig-dir>/worktrees/.state.json`.
Initially the branch also uses the UUID.
After its first user message, a temporary pi process uses the default model to
choose a conventional prefix and short kebab-case slug. Only the branch is renamed;
the directory stays fixed. Failures retain the UUID and appear in the sidebar.

Projects without Git prompt before initialization. Repositories without commits
create an empty orphan worktree (requires Git with `worktree add --orphan` support).
Pig never creates an initial commit or copies uncommitted files automatically.

Deleting a worktree stops its sessions and removes the working directory, branch,
and matching Pi session directory. Dirty/ignored files or unmerged commits require
a second confirmation. The original project directory cannot be deleted as a
worktree. Removing a project from the list leaves its files untouched.

```bash
bun test tests
bun run build
node_modules/.bin/electron tests/branch-namer-smoke.cjs
```

The smoke test starts the naming worker with isolated credentials and a local mock
provider, checking naming, disabled tools/context, no saved sessions, and process
exit without calling an external model API.

## Plugins

Manage trusted Pi extensions and the bundled Observational Memory extension in
**Settings → Plugins**. See [plugin loading, configuration and package metadata](docs/plugins.md).

## Authentication

Open **设置 → 供应商** in Pig to log in to a provider account or add an API key.
Credentials are managed by pi in `~/.pi/agent/auth.json`. Pig also uses existing
pi logins and environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
