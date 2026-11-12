/** Quit must not initialize Dream or its SDK/model dependencies when it has never been used. */
let stop: (disabling?: boolean) => Promise<unknown> = async () => {}
export function registerDreamShutdown(handler: (disabling?: boolean) => Promise<unknown>): void { stop = handler }
export async function shutdownDream(disabling?: boolean): Promise<void> { await stop(disabling) }
