/**
 * Pi's personal enabledModels is the only persisted scope. Resolve patterns through the SDK so
 * glob, fuzzy matching and thinking suffixes behave exactly like Pi, without changing sessions.
 */
import { SettingsManager, resolveModelScopeFromModels } from '@earendil-works/pi-coding-agent'
import type { ScopedModelSettings } from '../../shared/api'
import { startModelRuntime, toModelInfo } from './model-settings'

function checkErrors(settings: SettingsManager): void {
  const errors = settings.drainErrors()
  if (errors.length) throw new AggregateError(errors.map(({ error }) => error), 'Could not access Pi scoped models')
}

export async function getScopedModels(): Promise<ScopedModelSettings> {
  const settings = SettingsManager.create(process.cwd())
  checkErrors(settings)
  const patterns = settings.getGlobalSettings().enabledModels ?? []
  const runtime = await startModelRuntime()
  const available = await runtime.getAvailable()
  if (!patterns.length) {
    return { patterns, selections: [], missingProviderPatterns: [], models: available.map(toModelInfo), warnings: [] }
  }
  // All rules resolve against one authenticated snapshot, not one provider scan per rule.
  const result = resolveModelScopeFromModels(patterns, available)
  const selections = patterns.map((pattern) => ({
    pattern,
    models: resolveModelScopeFromModels([pattern], available).scopedModels.map(({ model }) => toModelInfo(model))
  }))
  const availableProviders = new Set(available.map((model) => model.provider))
  const configuredProviders = new Set(runtime.getProviders()
    .filter((provider) => runtime.hasConfiguredAuth(provider.id) || availableProviders.has(provider.id))
    .map((provider) => provider.id))
  // The SDK registry includes every built-in provider, even after logout/removal. Cleanup uses
  // configured auth or available models (including keyless local providers), not registry membership.
  // Bare model IDs and wildcard provider patterns must survive cleanup.
  const missingProviderPatterns = patterns.filter((pattern) => {
    const slash = pattern.indexOf('/')
    if (slash <= 0 || !result.diagnostics.some((d) => d.pattern === pattern && d.code === 'no-match')) return false
    const provider = pattern.slice(0, slash)
    if (/[*?\[]/.test(provider) || configuredProviders.has(provider)) return false
    return !runtime.getAllModels().some((model) =>
      pattern === model.id || pattern.startsWith(`${model.id}:`))
  })
  return {
    patterns,
    selections,
    missingProviderPatterns,
    models: result.scopedModels.map(({ model }) => toModelInfo(model)),
    warnings: result.diagnostics.map(({ message }) => message)
  }
}

export async function setScopedModels(patterns: string[]): Promise<void> {
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new Error('Scoped model patterns must be non-empty strings')
  }
  const settings = SettingsManager.create(process.cwd())
  checkErrors(settings)
  settings.setEnabledModels(patterns)
  await settings.flush()
  checkErrors(settings)
}
