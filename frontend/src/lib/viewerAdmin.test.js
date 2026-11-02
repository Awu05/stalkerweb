import { describe, it, expect } from 'vitest'
import { canRemoveViewer } from './viewerAdmin'

describe('canRemoveViewer', () => {
  it('never the admin (the first profile), and never the last one', () => {
    const admin = { id: 'a', admin: true }
    const bea = { id: 'b', admin: false }
    expect(canRemoveViewer(bea, [admin, bea])).toBe(true)
    expect(canRemoveViewer(admin, [admin, bea])).toBe(false)
    expect(canRemoveViewer(bea, [bea])).toBe(false)
  })
})
