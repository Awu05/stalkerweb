import { describe, it, expect } from 'vitest'
import { continueTarget, episodeLabel, historyEpisodeLabel, seasonNoOf, watchedInSeason, seasonWatchedLabel, watchedOfEpisodes } from './seriesProgress'

const s1 = { id: 's1', name: 'Season 1', seasonNumber: '1' }
const s2 = { id: 's2', name: 'Season 2', seasonNumber: '2' }
const ep = (id, n) => ({ episodeId: id, seriesNumber: String(n), name: `Episode ${n}` })
const e1 = ep('e1', 1), e2 = ep('e2', 2), e3 = ep('e3', 3), f1 = ep('f1', 1), f2 = ep('f2', 2)
const all = { s1: [e1, e2, e3], s2: [f1, f2] }
const base = { showId: '200', seasons: [s1, s2], episodesBySeason: all, history: [], progress: [], watchedEpisodes: [] }

describe('continueTarget', () => {
  it('starts a show not watched yet at its first episode', () => {
    expect(continueTarget(base)).toEqual({ action: 'play', season: s1, episode: e1 })
  })

  it('resumes the episode stopped partway through', () => {
    const history = [{ id: '200', key: '200:s1:e2', finished: false }]
    const progress = [{ key: '200:s1:e2' }]
    expect(continueTarget({ ...base, history, progress })).toEqual({ action: 'resume', season: s1, episode: e2 })
    // Its resume point gone (pushed out of the list): it plays from the start.
    expect(continueTarget({ ...base, history })).toEqual({ action: 'play', season: s1, episode: e2 })
  })

  it('plays the next episode after one finished, into the next season', () => {
    expect(continueTarget({ ...base, history: [{ id: '200', key: '200:s1:e2', finished: true }] }))
      .toEqual({ action: 'play', season: s1, episode: e3 })
    expect(continueTarget({ ...base, history: [{ id: '200', key: '200:s1:e3', finished: true }] }))
      .toEqual({ action: 'play', season: s2, episode: f1 })
  })

  it('skips episodes already watched', () => {
    const history = [{ id: '200', key: '200:s1:e1', finished: true }]
    expect(continueTarget({ ...base, history, watchedEpisodes: ['200:s1:e2', '200:s1:e3'] }))
      .toEqual({ action: 'play', season: s2, episode: f1 })
  })

  it('has nothing to continue after the last episode', () => {
    expect(continueTarget({ ...base, history: [{ id: '200', key: '200:s2:f2', finished: true }] })).toBeNull()
  })

  it('asks for a season it has to look into', () => {
    const history = [{ id: '200', key: '200:s1:e3', finished: true }]
    expect(continueTarget({ ...base, history, episodesBySeason: { s1: all.s1 } })).toEqual({ needs: 's2' })
    expect(continueTarget({ ...base, history: [{ id: '200', key: '200:s2:f1', finished: false }], episodesBySeason: {} })).toEqual({ needs: 's2' })
  })

  it('without a history entry, resumes the newest resume point of the show', () => {
    const progress = [{ key: '999:x:y' }, { key: '200:s2:f2' }]
    expect(continueTarget({ ...base, progress })).toEqual({ action: 'resume', season: s2, episode: f2 })
  })

  it('does not resume an episode marked watched by hand', () => {
    const history = [{ id: '200', key: '200:s1:e1', finished: false }]
    expect(continueTarget({ ...base, history, watchedEpisodes: ['200:s1:e1'] })).toEqual({ action: 'play', season: s1, episode: e2 })
  })
})

describe('labels', () => {
  it('names an episode by season and number, and its title when it has a real one', () => {
    expect(episodeLabel({ season: '2', episode: '5', name: 'The Long Night' })).toBe('S2 · E5 · The Long Night')
    expect(episodeLabel({ season: '2', episode: '5', name: 'Episode 5' })).toBe('S2 · E5')
    expect(episodeLabel({ season: '', episode: '5', name: 'Pilot' })).toBe('E5 · Pilot')
    expect(episodeLabel({ season: '', episode: '', name: 'Pilot' })).toBe('Pilot')
  })

  it("reads a Recently watched tile's episode from its player link", () => {
    expect(historyEpisodeLabel({ params: 'videoId=200&series=5&seasonId=s2&episodeId=e5&season=2', episodeTitle: 'Episode 5' })).toBe('S2 · E5')
    // Saved before the season was kept: as before.
    expect(historyEpisodeLabel({ params: 'videoId=200&series=5&seasonId=s2&episodeId=e5', episodeTitle: 'Episode 5' })).toBe('Episode 5')
    expect(historyEpisodeLabel({ params: 'videoId=100', episodeTitle: '' })).toBe('')
  })

  it("finds a season's number in its name when the portal leaves it out", () => {
    expect(seasonNoOf({ seasonNumber: '3', name: 'x' })).toBe('3')
    expect(seasonNoOf({ seasonNumber: '', name: 'Season 4' })).toBe('4')
    expect(seasonNoOf({ seasonNumber: '', name: 'Specials' })).toBe('')
  })

  it("counts a season's watched episodes", () => {
    const w = ['200:s1:e1', '200:s1:e2', '200:s2:f1', '300:s1:e1']
    expect(watchedInSeason(w, '200', 's1')).toBe(2)
    expect(seasonWatchedLabel(2, null)).toBe('2 watched')
    expect(seasonWatchedLabel(2, 3)).toBe('2 of 3')
    expect(seasonWatchedLabel(3, 3)).toBe('Watched')
    expect(seasonWatchedLabel(0, 3)).toBe('')
    // Its episodes known: only theirs count (an episode the portal dropped doesn't make it Watched).
    expect(watchedOfEpisodes(['200:s1:e1', '200:s1:gone'], '200', 's1', [e1, e2])).toBe(1)
  })
})
