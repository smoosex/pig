/** Quit must not initialize Dream or its SDK/model dependencies when it has never been used. */
let stop: () => Promise<unknown> = async () => {}
export function registerDreamShutdown(handler: () => Promise<unknown>): void { stop = handler }
export async function shutdownDream(): Promise<void> { await stop() }
