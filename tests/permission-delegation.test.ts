/** Borrow exact grants for a task, without copying privileges or supporting recursive controllers. */
import { expect, test } from 'bun:test'
import { approvalDelegation, delegateApprovals } from '../src/main/permissions/delegation'
import { forgetSessionGrants, grantSession, hasSessionGrant } from '../src/main/permissions/grants'

test('delegation borrows matching grants only and never persists them to the target', () => {
  grantSession('delegation-source', 'unsandboxed:sleep 3')
  grantSession('delegation-source', 'file:write:/approved/file')
  const detach = delegateApprovals('delegation-target', {
    controllerId: 'delegation-source', check() {}, allows: keys => hasSessionGrant('delegation-source', keys)
  })
  try {
    expect(hasSessionGrant('delegation-target', ['unsandboxed:sleep 3'])).toBe(true)
    expect(hasSessionGrant('delegation-target', ['unsandboxed:sleep 30'])).toBe(false)
    expect(hasSessionGrant('delegation-target', ['file:read:/approved/file', 'file:write:/approved/file'])).toBe(true)
    expect(hasSessionGrant('delegation-target', ['file:write:/different/file'])).toBe(false)
    expect(hasSessionGrant('delegation-target', [])).toBe(false)
    expect(() => delegateApprovals('delegation-next', { controllerId: 'delegation-target', check() {}, allows: () => true })).toThrow('Recursive')
  } finally { detach(); forgetSessionGrants('delegation-source') }
  expect(hasSessionGrant('delegation-target', ['unsandboxed:sleep 3'])).toBe(false)
})

test('instance or mode revocation invalidates old snapshots even after a replacement route exists', () => {
  let valid = true
  const detach = delegateApprovals('revoked-target', {
    controllerId: 'revoked-source',
    check() { if (!valid) throw new Error('Permission mode changed') },
    allows: () => true
  })
  const old = approvalDelegation('revoked-target')!
  expect(hasSessionGrant('revoked-target', ['mcp:example'])).toBe(true)
  valid = false
  expect(approvalDelegation('revoked-target')).toBeUndefined()
  expect(() => old.check()).toThrow()
  const current = delegateApprovals('revoked-target', { controllerId: 'revoked-source', check() {}, allows: () => false })
  try {
    detach()
    expect(approvalDelegation('revoked-target')).toBeDefined()
    expect(() => old.check()).toThrow('expired')
    expect(hasSessionGrant('revoked-target', ['mcp:example'])).toBe(false)
  } finally { current() }
})
