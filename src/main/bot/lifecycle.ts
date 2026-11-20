/** Quit must not initialize Bot or its SDK/model dependencies when it has never been used. */
let stop: () => Promise<unknown> = async () => {}
export function registerBotShutdown(handler: () => Promise<unknown>): void { stop = handler }
export async function shutdownBotService(): Promise<void> { await stop() }
