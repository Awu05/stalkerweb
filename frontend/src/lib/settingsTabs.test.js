import { describe, it, expect } from 'vitest'
import { chooseTab, SETTINGS_TABS } from './settingsTabs'

describe('chooseTab', () => {
  it('opens the tab named in the address', () => {
    expect(chooseTab('links', 'logos', true)).toBe('links')
    expect(chooseTab('links', null, false)).toBe('links')
  })

  it('opens Connection before a portal is connected', () => {
    expect(chooseTab(null, 'logos', false)).toBe('connection')
  })

  it('reopens the last tab used, else Viewers', () => {
    expect(chooseTab(null, 'playback', true)).toBe('playback')
    expect(chooseTab(null, null, true)).toBe('viewers')
  })

  it('ignores tabs that do not exist', () => {
    expect(chooseTab('nope', 'gone', true)).toBe('viewers')
  })

  it('has the five tabs in order', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(['viewers', 'connection', 'links', 'playback', 'logos'])
  })
})
