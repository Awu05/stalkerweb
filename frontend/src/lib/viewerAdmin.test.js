import { describe, it, expect } from 'vitest'
import { canRemoveViewer, canMakeAdmin } from './viewerAdmin'

describe('canRemoveViewer', () => {
  it('never the admin (the first profile), and never the last one', () => {
    const admin = { id: 'a', admin: true }
    const bea = { id: 'b', admin: false }
    expect(canRemoveViewer(bea, [admin, bea])).toBe(true)
    expect(canRemoveViewer(admin, [admin, bea])).toBe(false)
    expect(canRemoveViewer(bea, [bea])).toBe(false)
    // The Default: what devices picking no profile use.
    expect(canRemoveViewer({ id: 'd', isDefault: true }, [admin, bea, { id: 'd', isDefault: true }])).toBe(false)
  })
})

describe('canMakeAdmin', () => {
  it('offered to the admin, for anyone else', () => {
    const admin = { id: 'a', admin: true }
    const bea = { id: 'b', admin: false }
    const kim = { id: 'k', admin: false }
    expect(canMakeAdmin(bea, [admin, bea, kim], 'a')).toBe(true)
    expect(canMakeAdmin(admin, [admin, bea, kim], 'a')).toBe(false)
    expect(canMakeAdmin(kim, [admin, bea, kim], 'b')).toBe(false)   // not the admin asking
    expect(canMakeAdmin(kim, [admin, bea, kim], null)).toBe(false)
  })
})
