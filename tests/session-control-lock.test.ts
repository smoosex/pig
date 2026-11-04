/** Exclusive setup leases must not be released by stale owners. */
import { expect, test } from 'bun:test'
import { assertSessionControlAvailable, reserveSessionControl, withSessionControl } from '../src/main/pi/session-control-lock'

test('UI updates serialize under one lease without queueing behind controlled tasks', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const first = withSessionControl('ui-updates', async token => {
    assertSessionControlAvailable('ui-updates', token)
    order.push('model')
    await gate
  })
  const second = withSessionControl('ui-updates', async token => {
    assertSessionControlAvailable('ui-updates', token)
    order.push('thinking')
  })
  expect(order).toEqual(['model'])
  expect(() => reserveSessionControl('ui-updates')).toThrow()
  release()
  await Promise.all([first, second])
  expect(order).toEqual(['model', 'thinking'])
  expect(() => assertSessionControlAvailable('ui-updates')).not.toThrow()
  const task = reserveSessionControl('ui-updates')
  try { expect(() => withSessionControl('ui-updates', async () => {})).toThrow() }
  finally { task.release() }
})

test('only the matching token bypasses a session lease; other sessions remain independent', () => {
  const lease = reserveSessionControl('lock-exclusive')
  const other = reserveSessionControl('lock-other')
  try {
    expect(() => assertSessionControlAvailable('lock-exclusive')).toThrow('configuration is in progress')
    expect(() => assertSessionControlAvailable('lock-exclusive', Symbol('lock-exclusive'))).toThrow()
    expect(() => reserveSessionControl('lock-exclusive')).toThrow()
    expect(() => assertSessionControlAvailable('lock-exclusive', lease.token)).not.toThrow()
    expect(() => assertSessionControlAvailable('lock-other', other.token)).not.toThrow()
    expect(() => assertSessionControlAvailable('unreserved')).not.toThrow()
  } finally {
    lease.release()
    other.release()
  }
  expect(() => assertSessionControlAvailable('lock-exclusive')).not.toThrow()
})

test('release is idempotent and a stale release cannot unlock a replacement lease', () => {
  const old = reserveSessionControl('lock-stale')
  old.release()
  old.release()
  const current = reserveSessionControl('lock-stale')
  try {
    expect(current.token).not.toBe(old.token)
    old.release()
    expect(() => assertSessionControlAvailable('lock-stale', old.token)).toThrow()
    expect(() => reserveSessionControl('lock-stale')).toThrow()
    expect(() => assertSessionControlAvailable('lock-stale', current.token)).not.toThrow()
  } finally {
    current.release()
  }
  expect(() => assertSessionControlAvailable('lock-stale')).not.toThrow()
})
