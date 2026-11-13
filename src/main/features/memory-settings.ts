/** File-memory enablement, independent of session compaction and auxiliary models. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readSettingsObject, saveNamespacedSettings } from '../settings/json-file'
import type { MemorySettings, MemorySettingsPatch } from '../../shared/api'
import { memorySettingsPath } from './memory/paths'
import { validateLongTermSettings } from './memory/long-term/settings'

let mutation: Promise<unknown> = Promise.resolve()
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = mutation.then(action)
  mutation = result.catch(() => {})
  return result
}

function validate(value: unknown): asserts value is MemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid memory settings')
  if (Object.keys(value).some(key => key !== 'fileMemory')) throw new Error('Unknown memory setting')
  if ('fileMemory' in value && value.fileMemory !== undefined) validateLongTermSettings(value.fileMemory)
}

async function read(): Promise<MemorySettings> {
  const path = memorySettingsPath()
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Carry over only file-memory enablement once; never load the retired worker settings.
    const old = (await readSettingsObject(join(dirname(path), 'plugins', 'observational-memory', 'settings.json')))['observational-memory']
    if (old !== undefined && (!old || typeof old !== 'object' || Array.isArray(old))) throw new Error('Invalid previous memory settings')
    const fileMemory = (old as MemorySettings | undefined)?.fileMemory
    value = fileMemory === undefined ? {} : { fileMemory }
    validate(value)
    await saveNamespacedSettings(path, { ...value })
  }
  validate(value)
  return value
}

export function getMemorySettings(): Promise<MemorySettings> {
  return serialize(read)
}

export function setMemorySettings(patch: MemorySettingsPatch): Promise<MemorySettings> {
  return serialize(async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid memory settings')
    if (Object.keys(patch).some(key => key !== 'fileMemory')) throw new Error('Unknown memory setting')
    if (patch.fileMemory != null) validateLongTermSettings(patch.fileMemory)
    const next = await read()
    if (patch.fileMemory === null) delete next.fileMemory
    else if (patch.fileMemory !== undefined) next.fileMemory = patch.fileMemory
    await saveNamespacedSettings(memorySettingsPath(), { ...next })
    return next
  })
}
