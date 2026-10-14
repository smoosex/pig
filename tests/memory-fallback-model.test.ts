/*
 * Fallback memory model resolution. `Runtime.resolveModel` takes its registry through
 * `ctx`, so these exercise the real precedence rules without module mocking: the primary
 * (`config.model`, else the session model) wins when it resolves, the configured fallback
 * is tried only after that fails, and a fallback identical to the effective primary is
 * rejected rather than re-running the same failure.
 */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { Runtime } from '../src/main/plugins/observational-memory/runtime'

type RegistryOptions = {
  /** Models the registry resolves, keyed `provider/id`. */
  models?: Record<string, { provider: string; id: string; contextWindow?: number }>
  /** Providers whose auth resolves to a usable api key. */
  authenticated?: string[]
  hasConfiguredAuth?: (provider: string) => boolean
}

function registry({ models = {}, authenticated = [], hasConfiguredAuth }: RegistryOptions) {
  return {
    find: (provider: string, id: string) => models[`${provider}/${id}`],
    getApiKeyAndHeaders: async (model: { provider: string }) =>
      authenticated.includes(model.provider) ? { ok: true, apiKey: `key-${model.provider}` } : { ok: true },
    isUsingOAuth: () => false,
    hasConfiguredAuth: hasConfiguredAuth ?? (() => false),
  }
}

const sessionModel = { provider: 'session', id: 'big' }
const primary = { provider: 'primary', id: 'p1' }
const fallback = { provider: 'backup', id: 'b1' }

function runtimeWith(config: Record<string, unknown>): Runtime {
  const runtime = new Runtime()
  runtime.configLoaded = true
  Object.assign(runtime.config, config)
  return runtime
}

test('resolveModel uses the primary without touching the fallback', async () => {
  const runtime = runtimeWith({ fallbackModel: fallback })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel, 'backup/b1': fallback }, authenticated: ['session', 'backup'] }),
  })
  assert.equal(result.ok, true)
  assert.equal((result as any).model, sessionModel)
  assert.equal((result as any).fallbackUsed, undefined)
})

test('resolveModel falls back when the primary has no usable auth', async () => {
  const runtime = runtimeWith({ fallbackModel: fallback })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel, 'backup/b1': fallback }, authenticated: ['backup'] }),
  })
  assert.equal(result.ok, true)
  assert.equal((result as any).model, fallback)
  assert.equal((result as any).fallbackUsed, true)
  assert.match((result as any).primaryFailure, /no API key or auth headers/)
})

test('resolveModel reports the primary reason unchanged when no fallback is configured', async () => {
  const runtime = runtimeWith({})
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel } }),
  })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /no API key or auth headers/)
  assert.doesNotMatch((result as any).reason, /no fallback model configured/)
})

test('resolveModel reports both reasons when a configured fallback also fails', async () => {
  const runtime = runtimeWith({ fallbackModel: fallback })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel, 'backup/b1': fallback } }),
  })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /no API key or auth headers/)
  assert.match((result as any).reason, /no API key or auth headers for provider "backup"/)
})

test('resolveModel rejects a fallback identical to the effective primary', async () => {
  const runtime = runtimeWith({ fallbackModel: sessionModel })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel } }),
  })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /identical to the effective primary model/)
})

test('resolveModel compares the fallback against the configured primary, not the session model', async () => {
  // Both the configured primary and the fallback are the same model, and neither
  // authenticates: the guard must reject the fallback as a pointless second attempt.
  const runtime = runtimeWith({ model: primary, fallbackModel: primary })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'primary/p1': primary, 'session/big': sessionModel } }),
  })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /identical to the effective primary model/)
})

test('resolveModel treats the session model as the effective primary when the configured one is missing', async () => {
  // `config.model` absent from the registry degrades the primary to the session model,
  // so a fallback equal to that session model is the same pointless retry.
  const runtime = runtimeWith({ model: primary, fallbackModel: sessionModel })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel } }),
  })
  assert.equal(result.ok, false)
  assert.match((result as any).reason, /identical to the effective primary model/)
})

test('resolveModel still reaches the fallback when the configured primary is missing and the session model is unusable', async () => {
  // A missing configured model alone does not fail resolution — the session model takes
  // over. Only when that also fails does the fallback get its turn.
  const runtime = runtimeWith({ model: primary, fallbackModel: fallback })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel, 'backup/b1': fallback }, authenticated: ['backup'] }),
  })
  assert.equal(result.ok, true)
  assert.equal((result as any).model, fallback)
  assert.equal((result as any).fallbackUsed, true)
})

test('resolveModel uses the session model when the configured primary is missing but usable', async () => {
  const runtime = runtimeWith({ model: primary, fallbackModel: fallback })
  const result = await runtime.resolveModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel, 'backup/b1': fallback }, authenticated: ['session', 'backup'] }),
  })
  assert.equal(result.ok, true)
  assert.equal((result as any).model, sessionModel)
  assert.equal((result as any).fallbackUsed, undefined)
})

test('resolveFallbackModel reports why it declined', async () => {
  const unset = await runtimeWith({}).resolveFallbackModel({ model: sessionModel, modelRegistry: registry({}) })
  assert.equal(unset.ok, false)
  assert.match((unset as any).reason, /no fallback model configured/)

  const missing = await runtimeWith({ fallbackModel: fallback }).resolveFallbackModel({
    model: sessionModel,
    modelRegistry: registry({ models: { 'session/big': sessionModel } }),
  })
  assert.equal(missing.ok, false)
  assert.match((missing as any).reason, /backup\/b1 not found/)
})
