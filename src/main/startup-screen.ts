/**
 * Self-contained document of the startup screen: one full-window canvas driven by
 * `runStartupScene`, with no network or simulated progress. Inline script is the only allowance;
 * the view is sandboxed and has no preload.
 */
import { runStartupScene } from './startup-scene'

export const STARTUP_EXIT_MS = 860

/** Starts the scene's exit; the canvas is transparent once `STARTUP_EXIT_MS` has passed. */
export const STARTUP_EXIT_SCRIPT = 'window.__pigStartupExit?.()'

export function startupScreenHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Pig</title><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
body { -webkit-app-region: drag; user-select: none; cursor: default; }
canvas { display: block; width: 100%; height: 100%; }
</style></head><body>
<canvas role="progressbar" aria-label="Loading Pig"></canvas>
<script>(${runStartupScene.toString()})(${STARTUP_EXIT_MS})</script>
</body></html>`
}
