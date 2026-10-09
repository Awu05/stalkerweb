import { describe, it, expect } from 'vitest'
import { episodeNeighbours } from './episodeNav'

const seasons = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
const ep = (id) => ({ episodeId: id })
const eps = { s1: [ep('a'), ep('b')], s2: [ep('c'), ep('d')] }
const ids = (n) => n && [n.season.id, n.episode.episodeId]

describe('episodeNeighbours', () => {
  it('steps within a season', () => {
    const n = episodeNeighbours(seasons, eps, 's2', 'c')
    expect(ids(n.prev)).toEqual(['s1', 'b'])
    expect(ids(n.next)).toEqual(['s2', 'd'])
  })

  it("moves on to the next season's first episode, and back to the last season's last", () => {
    expect(ids(episodeNeighbours(seasons, eps, 's1', 'b').next)).toEqual(['s2', 'c'])
    expect(ids(episodeNeighbours(seasons, eps, 's2', 'c').prev)).toEqual(['s1', 'b'])
  })

  it('asks for a neighbouring season that is not loaded yet', () => {
    const n = episodeNeighbours(seasons, eps, 's2', 'd')
    expect(n.next).toBe(null)
    expect(n.needs).toEqual(['s3'])
  })

  it('has nothing before the first episode or after the last', () => {
    expect(episodeNeighbours(seasons, eps, 's1', 'a').prev).toBe(null)
    expect(episodeNeighbours([{ id: 's1' }], eps, 's1', 'b').next).toBe(null)
    expect(episodeNeighbours(seasons, eps, 's9', 'x')).toEqual({ prev: null, next: null, needs: [] })
  })
})
