import { describe, expect, it } from 'vitest'
import { persistChunks } from '../../../layers/evidence-files/src/index.ts'

describe('evidence-files layer', () => {
  it('exposes worker chunk persistence from the layer path', () => {
    expect(persistChunks).toEqual(expect.any(Function))
  })
})
