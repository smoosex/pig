/** Shared registry between the jiti extension and the main-process session reader. */
export interface SessionReadHost {
  read(caller: string, target: string, offset: number, limit: number): Promise<string>
}
const key = Symbol.for('pig:session-read-host')
type Slot = Record<symbol, SessionReadHost | undefined>
export function registerSessionReadHost(host: SessionReadHost): void { (globalThis as Slot)[key] = host }
export function sessionReadHost(): SessionReadHost | undefined { return (globalThis as Slot)[key] }
