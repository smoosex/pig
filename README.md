# Pig

Desktop GUI for the [pi](https://pi.dev) coding agent, built with Electron + React + Vite.

## Architecture

Three Electron processes, one Node brain:

```
renderer (React, sandboxed browser)
   ↕  contextBridge white-listed API (preload)
preload  (isolated bridge)
   ↕  ipcMain.handle / webContents.send
main     (Node, owns the pi SDK session)
```

The pi SDK (`@earendil-works/pi-coding-agent`) runs **only** in the main process.
The renderer is sandboxed (`nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`) and reaches Node solely through `window.api`.

## Layout

```
src/
├── main/        Node + pi SDK
│   ├── index.ts        app entry, window creation
│   ├── window.ts       BrowserWindow lifecycle
│   ├── pi/             session factory + event bridge
│   └── ipc/            invoke handlers + push channels
├── preload/     contextBridge API surface
└── renderer/    React UI
    └── src/
        ├── stores/     zustand
        ├── hooks/      pi event → store bridge
        ├── ipc/        window.api wrapper
        └── components/ UI
```

## Develop

```bash
bun install
bun run dev
```

## Typecheck

```bash
bun run typecheck
```

## Build

```bash
bun run build:mac     # or build:win / build:linux
```

## Authentication

pi reads credentials from `~/.pi/agent/auth.json`. Run `pi /login` in a terminal
once, or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` etc. Pig inherits whatever
pi already has configured.
