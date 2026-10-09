import { describe, it, expect } from 'vitest'
import { chooseViewer, viewerQuery, viewerPath } from './viewer'

const a = { id: 'view_a', name: 'Andy' }
const b = { id: 'view_b', name: 'Sam' }

describe('chooseViewer', () => {
  it('keeps the saved viewer while it exists', () => {
    expect(chooseViewer([a, b], 'view_b')).toEqual({ id: 'view_b', needsPicker: false })
  })

  it('picks the only viewer without asking', () => {
    expect(chooseViewer([a], null)).toEqual({ id: 'view_a', needsPicker: false })
    expect(chooseViewer([a], 'view_gone')).toEqual({ id: 'view_a', needsPicker: false })
  })

  it('asks when there are several and none is saved, or the saved one was deleted', () => {
    expect(chooseViewer([a, b], null)).toEqual({ id: null, needsPicker: true })
    expect(chooseViewer([a, b], 'view_gone')).toEqual({ id: null, needsPicker: true })
  })
})

describe('viewer links', () => {
  it('leaves the default viewer\'s links as they were', () => {
    expect(viewerQuery({ id: 'view_a', isDefault: true })).toBe('')
    expect(viewerPath({ id: 'view_a', isDefault: true })).toBe('')
    expect(viewerQuery(null)).toBe('')
  })

  it('adds the viewer to other viewers\' links', () => {
    expect(viewerQuery({ id: 'view_b', isDefault: false })).toBe('?viewer=view_b')
    expect(viewerPath({ id: 'view_b', isDefault: false })).toBe('/v/view_b')
  })
})
